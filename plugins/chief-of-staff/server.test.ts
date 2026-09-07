import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { classifyRung } from "./server";

const spawnCalls: Array<Record<string, unknown> & { prompt: string; title?: string }> = [];

/** Hermetic `bb` stub: answers `tasks preset show <name> --json` with a canned preset. */
function makeStubBbCli(preset: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "cos-test-bb-"));
  const script = join(dir, "bb");
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s' '${JSON.stringify({ preset }).replace(/'/g, "'\\''" )}'\n`,
  );
  chmodSync(script, 0o755);
  return script;
}

const FAKE_PRESET = {
  name: "Dial High",
  providerId: "pi",
  modelId: "test/model-x",
  reasoningLevel: "xhigh",
  serviceTier: null,
  permissionMode: "full",
  environmentKind: "project-default",
  baseBranch: null,
  instructions: "Hard tasks: think carefully before acting.",
};

async function makeHost(extraSettings: Record<string, string> = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "chief-of-staff",
    settings: {
      standingAnswers: "- Always name files in kebab-case.\n- Tests first.",
      nudgeAfter: "off",
      escalationTimeout: "1h",
      autoTriage: "off",
      ...extraSettings,
    },
    sdk: {
      projects: {
        list: async () => [{ id: "proj_1", name: "Personal" }],
      },
      threads: {
        spawn: async (args: { prompt: string; title?: string }) => {
          spawnCalls.push(args);
          return makeThreadResponse({ id: `th_${spawnCalls.length}` });
        },
        stop: async () => ({ ok: true as const }),
      },
    },
  });
  await plugin(bb);
  return harness;
}

let harness: Awaited<ReturnType<typeof makeHost>>;

beforeEach(async () => {
  spawnCalls.length = 0;
  delete process.env.BB_CLI;
  harness = await makeHost();
});

describe("chief-of-staff", () => {
  it("classifies item titles into dial rungs", () => {
    expect(classifyRung("Migrate the auth service to the new gateway", "")).toBe("ultra");
    expect(classifyRung("Fix the flaky login test", "")).toBe("high");
    expect(classifyRung("Fix typo in the readme", "")).toBe("low");
    expect(classifyRung("Add a settings page", "")).toBe("medium");
  });
  it("adds an item and opens a worker thread with the working agreement", async () => {
    const result = await harness.behavior.callRpc("items_add", {
      title: "Fix the flaky login test",
    });
    expect(result.item.status).toBe("running");
    expect(result.item.threadId).toBe("th_1");
    expect(spawnCalls[0]!.title).toBe("Fix the flaky login test");
    expect(spawnCalls[0]!.prompt).toContain("COS:DONE");
    expect(spawnCalls[0]!.prompt).toContain("kebab-case"); // standing instructions embedded

    const brief = await harness.behavior.callRpc("brief_get", null);
    expect(brief.items).toHaveLength(1);
  });

  it("answers routine questions itself from standing instructions", async () => {
    const added = await harness.behavior.callRpc("items_add", { title: "Tidy utils" });
    const threadId = added.item.threadId as string;

    const answer = (await harness.behavior.callAgentTool(
      "cos_ask",
      { question: "What naming convention for new files?", kind: "routine" },
      { threadId, projectId: "proj_1" },
    )) as string;
    expect(answer).toContain("Chief of staff");
    expect(answer).toContain("kebab-case");

    const brief = await harness.behavior.callRpc("brief_get", null);
    const activity = brief.activity.map((a: { kind: string }) => a.kind);
    expect(activity).toContain("routine");
    void threadId;
  });

  it("escalates decisions, blocks the worker, and delivers the operator's answer", async () => {
    const added = await harness.behavior.callRpc("items_add", { title: "Migrate database" });
    const threadId = added.item.threadId as string;

    let toolResult: unknown;
    const toolPromise = harness.behavior
      .callAgentTool(
        "cos_ask",
        {
          question: "Should we drop the legacy table?",
          kind: "decision",
          context: "It may still be read by reporting jobs.",
        },
        { threadId, projectId: "proj_1" },
      )
      .then((r) => {
        toolResult = r;
        return r as string;
      });

    // Give the escalation a moment to register.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const brief = await harness.behavior.callRpc("brief_get", null);
    expect(brief.pendingDecisions).toHaveLength(1);
    const decision = brief.pendingDecisions[0];
    expect(decision.question).toContain("legacy table");

    // The item shows as blocked while waiting.
    const itemRow = brief.items.find((i: { id: string }) => i.id === added.item.id);
    expect(itemRow.status).toBe("blocked");

    await harness.behavior.callRpc("decisions_resolve", {
      decisionId: decision.id,
      action: "answer",
      answer: "Yes — drop it after archiving.",
    });

    const resolved = (await toolPromise) as string;
    expect(resolved).toContain("operator decision");
    expect(resolved).toContain("drop it after archiving");
    expect(toolResult).toBe(resolved);
    void threadId;

    const after = await harness.behavior.callRpc("brief_get", null);
    expect(after.pendingDecisions).toHaveLength(0);
  });

  it("dismissal tells the worker to proceed safely", async () => {
    const added = await harness.behavior.callRpc("items_add", { title: "Pick a color" });
    const threadId = added.item.threadId as string;

    const pendingCall = harness.behavior
      .callAgentTool(
        "cos_ask",
        { question: "Blue or green?", kind: "decision" },
        { threadId, projectId: "proj_1" },
      )
      .then((r) => r as string);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const brief = await harness.behavior.callRpc("brief_get", null);
    const decision = brief.pendingDecisions[0];
    await harness.behavior.callRpc("decisions_resolve", {
      decisionId: decision.id,
      action: "dismiss",
    });

    const reply = await pendingCall;
    expect(reply).toContain("dismissed");
    expect(reply).toContain("safest reversible option");
  });

  it("cli brief reports counts and pending decisions", async () => {
    await harness.behavior.callRpc("items_add", { title: "Item one" });
    const cli = await harness.behavior.runCli(["brief"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("Backlog:");
    expect(cli.stdout).toContain("running");
  });

  it("removing an item stops its worker thread", async () => {
    const added = await harness.behavior.callRpc("items_add", { title: "Temporary" });
    const removed = await harness.behavior.callRpc("items_remove", {
      id: added.item.id,
    });
    expect(removed.removed).toBe(true);
    const calls = harness.inspection.sdk.callsTo("threads.stop");
    expect(calls.length).toBe(1);
  });

  it("spawns workers with the preset's execution config and effort profile", async () => {
    process.env.BB_CLI = makeStubBbCli(FAKE_PRESET);
    harness = await makeHost({ autoTriage: "on" });
    const result = await harness.behavior.callRpc("items_add", {
      title: "Do the thing",
      rung: "high",
    });
    expect(result.item.preset).toBe("Dial High");
    const spawned = spawnCalls[0] as Record<string, unknown>;
    expect(spawned.providerId).toBe("pi");
    expect(spawned.model).toBe("test/model-x");
    expect(spawned.reasoningLevel).toBe("xhigh");
    expect(spawned.permissionMode).toBe("full");
    expect(spawned.executionInputSources).toMatchObject({
      providerId: "explicit",
      model: "explicit",
    });
    expect(spawned.prompt).toContain("Effort profile");
    expect(spawned.prompt).toContain("think carefully before acting");
  });

  it("falls back to the project default when a preset cannot be resolved", async () => {
    process.env.BB_CLI = makeStubBbCli({}); // resolves to nothing
    harness = await makeHost({ autoTriage: "on" });
    const result = await harness.behavior.callRpc("items_add", {
      title: "Just do it",
      rung: "high",
    });
    expect(result.item.status).toBe("running");
    const spawned = spawnCalls[0] as Record<string, unknown>;
    expect(spawned.providerId).toBeUndefined();
    expect(spawned.prompt).not.toContain("Effort profile");
  });
});
