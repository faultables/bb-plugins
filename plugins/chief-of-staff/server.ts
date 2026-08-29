// bb-plugin-chief-of-staff — backend entry.
//
// The Chief of Staff takes a backlog, opens one agent thread per item,
// keeps the workers moving (answering routine questions itself from your
// standing instructions), and escalates to you — in this panel — only the
// decisions only you can make. It briefs you on progress at the top of the
// panel and via `bb chief-of-staff brief`.
import { randomUUID } from "node:crypto";
import {
  defineRpcContract,
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared schemas (wire boundary for the frontend)
// ---------------------------------------------------------------------------

const itemStatusSchema = z.enum(["queued", "running", "blocked", "done", "failed"]);

const itemSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  status: itemStatusSchema,
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  summary: z.string().nullable(),
  nudgedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const decisionStatusSchema = z.enum(["pending", "answered", "dismissed", "expired"]);

const decisionSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  threadId: z.string(),
  question: z.string(),
  context: z.string().nullable(),
  status: decisionStatusSchema,
  answer: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});

const activitySchema = z.object({
  id: z.string(),
  itemId: z.string().nullable(),
  kind: z.string(),
  message: z.string(),
  createdAt: z.string(),
});

export type CosItem = z.infer<typeof itemSchema>;
export type CosDecision = z.infer<typeof decisionSchema>;
export type CosActivity = z.infer<typeof activitySchema>;

export const rpcContract = defineRpcContract({
  // One snapshot powers the whole panel.
  brief_get: {
    input: z.null(),
    output: z.object({
      items: z.array(itemSchema),
      pendingDecisions: z.array(decisionSchema),
      activity: z.array(activitySchema),
    }),
  },
  items_add: {
    input: z.object({ title: z.string().trim().min(1).max(300) }),
    output: z.object({ item: itemSchema }),
  },
  items_remove: {
    input: z.object({ id: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  items_retry: {
    input: z.object({ id: z.string() }),
    output: z.object({ item: itemSchema }),
  },
  decisions_resolve: {
    input: z.object({
      decisionId: z.string(),
      action: z.enum(["answer", "dismiss"]),
      answer: z.string().optional(),
    }),
    output: z.object({ decision: decisionSchema }),
  },
});

/** Realtime channel; any mutation publishes so open panels refetch. */
const CHANGED = "cos-changed";

const DEFAULT_STANDING_ANSWERS = [
  "# Standing instructions",
  "",
  "- Prefer the smallest change that fully solves the task.",
  "- Follow existing repository conventions over personal taste.",
  "- Add or update tests for behavior you change.",
  "- Do not commit or push unless the task explicitly asks for it.",
].join("\n");

function parseDuration(text: string): number {
  const match = /^(\d+)(m|h)$/.exec(text);
  if (match === null) return 4 * 60 * 60 * 1000;
  const value = Number(match[1]);
  return match[2] === "h" ? value * 3_600_000 : value * 60_000;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loading chief-of-staff");

  const settings = bb.settings.define({
    project: { type: "project", label: "Project worker threads run in" },
    standingAnswers: {
      type: "string",
      label: "Standing instructions (used to answer routine questions)",
      experimental_multiline: true,
      default: DEFAULT_STANDING_ANSWERS,
    },
    nudgeAfter: {
      type: "select",
      label: "Nudge an idle worker after",
      options: ["off", "5", "15", "30", "60"],
      default: "15",
    },
    escalationTimeout: {
      type: "select",
      label: "How long a blocked worker waits on you before proceeding safely",
      options: ["15m", "1h", "4h", "24h"],
      default: "4h",
    },
  });

  // --- storage -------------------------------------------------------------
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      thread_id TEXT,
      project_id TEXT,
      summary TEXT,
      nudged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      question TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      item_id TEXT,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_items_thread ON items(thread_id)`,
    `CREATE INDEX IF NOT EXISTS idx_decisions_item ON decisions(item_id)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at)`,
  ]);

  const now = () => new Date().toISOString();

  interface ItemRow {
    id: string;
    title: string;
    detail: string;
    status: string;
    thread_id: string | null;
    project_id: string | null;
    summary: string | null;
    nudged_at: string | null;
    created_at: string;
    updated_at: string;
  }
  interface DecisionRow {
    id: string;
    item_id: string;
    thread_id: string;
    question: string;
    context: string | null;
    status: string;
    answer: string | null;
    created_at: string;
    resolved_at: string | null;
  }

  function toItem(row: ItemRow) {
    return {
      id: row.id,
      title: row.title,
      detail: row.detail,
      status: row.status as z.infer<typeof itemStatusSchema>,
      threadId: row.thread_id,
      projectId: row.project_id,
      summary: row.summary,
      nudgedAt: row.nudged_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  function toDecision(row: DecisionRow) {
    return {
      id: row.id,
      itemId: row.item_id,
      threadId: row.thread_id,
      question: row.question,
      context: row.context,
      status: row.status as z.infer<typeof decisionStatusSchema>,
      answer: row.answer,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  const publish = () => bb.realtime.publish(CHANGED, { at: now() });

  function logActivity(itemId: string | null, kind: string, message: string) {
    db.prepare(
      `INSERT INTO activity (id, item_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID().slice(0, 8), itemId, kind, message.slice(0, 500), now());
  }

  const getItemByThread = (threadId: string): ItemRow | undefined =>
    db
      .prepare(
        `SELECT * FROM items WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(threadId) as ItemRow | undefined;

  async function resolveProjectId(): Promise<string> {
    const s = await settings.get();
    if (s.project) return s.project;
    const projects = await bb.sdk.projects.list();
    if (projects.length > 0) return projects[0]!.id;
    throw new Error(
      "No project available for worker threads. Set one in Settings → Chief Of Staff.",
    );
  }

  // --- worker threads ------------------------------------------------------

  function buildPrompt(s: { standingAnswers: string }, item: ItemRow): string {
    const standing = s.standingAnswers.trim().slice(0, 2000);
    return [
      `You are one of several parallel workers coordinated by the Chief-of-Staff plugin.`,
      ``,
      `# Task`,
      item.title,
      item.detail.trim() === "" ? "" : `\n${item.detail.trim()}`,
      ``,
      `# Working agreement`,
      `1. Work autonomously until the task is complete. Do not stop to chat.`,
      `2. ROUTINE questions — conventions, naming, file placement, style, tooling choices — must go through the \`cos_ask\` tool with kind "routine". The chief of staff answers these for you from the operator's standing instructions; never idle waiting on the operator for these.`,
      `3. DECISIONS only the operator can make — scope changes, cost or spend, external communication, irreversible actions, product tradeoffs — also go through \`cos_ask\`, with kind "decision". The call blocks until the operator answers (or a timeout); meanwhile, continue any work that does not depend on it.`,
      `4. When the task is fully complete, end your FINAL message with a line starting exactly: COS:DONE followed by a one-sentence summary of what was done.`,
      `5. If you truly cannot proceed, end your final message with a line starting exactly: COS:BLOCKED followed by the reason.`,
      ``,
      `# Operator's standing instructions`,
      standing,
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  async function spawnWorker(item: ItemRow): Promise<ItemRow> {
    const s = await settings.get();
    const projectId = await resolveProjectId();
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      prompt: buildPrompt(s, item),
      title: item.title,
    });
    db.prepare(
      `UPDATE items SET status='running', thread_id=?, project_id=?, nudged_at=NULL, updated_at=? WHERE id=?`,
    ).run(thread.id, projectId, now(), item.id);
    logActivity(
      item.id,
      "spawned",
      `Opened worker thread for "${item.title}"`,
    );
    return getItem(item.id)!;
  }

  const getItem = (id: string): ItemRow | undefined =>
    db.prepare(`SELECT * FROM items WHERE id=?`).get(id) as ItemRow | undefined;

  // --- decision waiters ----------------------------------------------------
  // cos_ask("decision") blocks until the operator resolves the decision from
  // the panel (or CLI). Waiters live only for the current load; a reload
  // leaves the decision row pending and the sweep expires it on schedule.
  const waiters = new Map<
    string,
    { resolve: (outcome: { action: "answered" | "dismissed" | "timeout"; answer?: string }) => void }
  >();

  async function waitOnDecision(
    decisionId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ action: "answered" | "dismissed" | "timeout"; answer?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (
        outcome: { action: "answered" | "dismissed" | "timeout"; answer?: string },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        waiters.delete(decisionId);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ action: "timeout" }), timeoutMs);
      const onAbort = () =>
        finish({ action: "timeout" });
      signal.addEventListener("abort", onAbort, { once: true });
      waiters.set(decisionId, { resolve: finish });
    });
  }

  function resolveDecisionRow(
    decisionId: string,
    action: "answer" | "dismiss" | "expire",
    answer?: string,
  ): DecisionRow | undefined {
    const status =
      action === "answer" ? "answered" : action === "dismiss" ? "dismissed" : "expired";
    db.prepare(
      `UPDATE decisions SET status=?, answer=COALESCE(?, answer), resolved_at=? WHERE id=? AND status='pending'`,
    ).run(status, action === "answer" ? (answer ?? null) : null, now(), decisionId);
    const row = db
      .prepare(`SELECT * FROM decisions WHERE id=?`)
      .get(decisionId) as DecisionRow | undefined;
    if (!row || row.status !== status) return undefined;
    const waiter = waiters.get(decisionId);
    if (waiter) {
      waiter.resolve(
        action === "answer"
          ? { action: "answered", answer }
          : action === "dismiss"
            ? { action: "dismissed" }
            : { action: "timeout" },
      );
    }
    return row;
  }

  // --- the cos_ask native tool ----------------------------------------------

  bb.agents.registerTool({
    name: "cos_ask",
    description:
      "Ask the chief of staff a question. Use kind 'routine' for conventions, naming, style, file placement, or tooling choices — it is answered immediately from the operator's standing instructions. Use kind 'decision' only for choices that are genuinely the operator's (scope, cost, external communication, irreversible actions, product tradeoffs); the call blocks until they answer from the Chief of Staff panel.",
    instructions:
      "When working on a chief-of-staff task, route routine questions through cos_ask instead of stopping, and reserve cos_ask kind 'decision' for true operator-only decisions.",
    presentation: {
      label: {
        pending: "Asking the chief of staff",
        completed: "Asked the chief of staff",
      },
    },
    parameters: z.object({
      question: z.string().min(1).describe("The question, in one or two sentences."),
      kind: z.enum(["routine", "decision"]).describe("routine = conventions/taste (auto-answered); decision = operator-only."),
      context: z.string().optional().describe("Optional supporting detail: what you tried, the options you see."),
    }),
    execute: async ({ question, kind, context }, ctx) => {
      const item = getItemByThread(ctx.threadId);
      const s = await settings.get();

      // Untracked threads get a generic conventionalist answer.
      if (item === undefined) {
        return `[chief-of-staff] This thread is not tracked by me. Answer from repository conventions and continue.`;
      }

      if (kind === "routine") {
        const answer = [
          `[Chief of staff — answered automatically]`,
          s.standingAnswers.trim(),
          ``,
          `If none of the above covers "${question}", pick the most conventional option consistent with this repository, state the assumption in one line in your final summary, and continue working.`,
        ].join("\n");
        logActivity(item.id, "routine", `Answered routine question: ${question}`);
        publish();
        return answer;
      }

      // kind === "decision": escalate and block until answered / dismissed / timed out.
      const decisionId = randomUUID().slice(0, 8);
      db.prepare(
        `INSERT INTO decisions (id, item_id, thread_id, question, context, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(decisionId, item.id, ctx.threadId, question, context ?? null, now());
      db.prepare(`UPDATE items SET status='blocked', updated_at=? WHERE id=?`).run(now(), item.id);
      logActivity(item.id, "escalated", `Escalated decision: ${question}`);
      publish();

      const outcome = await waitOnDecision(
        decisionId,
        parseDuration(s.escalationTimeout),
        ctx.signal,
      );

      if (outcome.action === "answered") {
        db.prepare(`UPDATE items SET status='running', updated_at=? WHERE id=?`).run(now(), item.id);
        logActivity(item.id, "decision", `Decision answered: ${question}`);
        publish();
        return `[Chief of staff — operator decision]\n${outcome.answer ?? "(no text provided)"}`;
      }
      if (outcome.action === "dismissed") {
        db.prepare(`UPDATE items SET status='running', updated_at=? WHERE id=?`).run(now(), item.id);
        logActivity(item.id, "decision", `Decision dismissed; told to proceed safely: ${question}`);
        publish();
        return `[Chief of staff] The operator dismissed this question without answering. Proceed with the safest reversible option consistent with repository conventions, state the assumption in one line in your final summary, and continue.`;
      }
      logActivity(item.id, "decision", `Timed out waiting on an answer; proceeding safely: ${question}`);
      publish();
      return `[Chief of staff] No operator answer within ${s.escalationTimeout}. Proceed with the safest reversible option consistent with repository conventions, state the assumption in one line in your final summary, and continue. Do not ask again.`;
    },
  });

  // --- lifecycle events keep item state honest -------------------------------

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    try {
      const item = getItemByThread(thread.id);
      if (item === undefined || item.status === "done") return;
      const text = lastAssistantText ?? "";
      const doneLine = text.split("\n").find((line) => line.startsWith("COS:DONE"));
      const blockedLine = text.split("\n").find((line) => line.startsWith("COS:BLOCKED"));
      if (doneLine !== undefined) {
        db.prepare(`UPDATE items SET status='done', summary=?, nudged_at=NULL, updated_at=? WHERE id=?`).run(
          doneLine.replace(/^COS:DONE\s*/, "").slice(0, 300),
          now(),
          item.id,
        );
        logActivity(item.id, "done", `Done: ${doneLine.replace(/^COS:DONE\s*/, "")}`);
        publish();
      } else if (blockedLine !== undefined) {
        db.prepare(`UPDATE items SET status='blocked', summary=NULL, updated_at=? WHERE id=?`).run(now(), item.id);
        logActivity(item.id, "stalled", `Worker stopped without finishing: ${blockedLine.replace(/^COS:BLOCKED\s*/, "")}`);
        publish();
      } else if (item.status !== "blocked") {
        // Turn ended without a marker; still in progress. Reset the nudge clock.
        db.prepare(`UPDATE items SET status='running', nudged_at=NULL, updated_at=? WHERE id=?`).run(now(), item.id);
      }
    } catch (cause) {
      bb.log.warn(`thread.idle handler failed: ${String(cause)}`);
    }
  });

  bb.events.on("thread.failed", ({ thread }) => {
    try {
      const item = getItemByThread(thread.id);
      if (item === undefined || item.status === "done") return;
      db.prepare(`UPDATE items SET status='failed', updated_at=? WHERE id=?`).run(now(), item.id);
      logActivity(item.id, "failed", `Worker thread failed`);
      publish();
    } catch (cause) {
      bb.log.warn(`thread.failed handler failed: ${String(cause)}`);
    }
  });

  // --- sweep: nudge stalled workers, expire stale decisions -------------------

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });

  bb.background.service("sweep", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const s = await settings.get();
          const nudgeMinutes = s.nudgeAfter === "off" ? null : Number(s.nudgeAfter);

          // Expire decisions whose waiter died with a previous load.
          const cutoff = new Date(Date.now() - parseDuration(s.escalationTimeout)).toISOString();
          const stale = db
            .prepare(`SELECT id FROM decisions WHERE status='pending' AND created_at < ?`)
            .all(cutoff) as Array<{ id: string }>;
          for (const row of stale) resolveDecisionRow(row.id, "expire");

          // Nudge running workers idle past the threshold.
          if (nudgeMinutes !== null && !signal.aborted) {
            const threshold = new Date(Date.now() - nudgeMinutes * 60_000).toISOString();
            const stalled = db
              .prepare(
                `SELECT * FROM items WHERE status='running' AND thread_id IS NOT NULL AND (nudged_at IS NULL OR nudged_at < updated_at) AND updated_at < ?`,
              )
              .all(threshold) as ItemRow[];
            for (const item of stalled) {
              if (signal.aborted) break;
              try {
                await bb.sdk.threads.send({
                  threadId: item.thread_id!,
                  mode: "auto",
                  input: [
                    {
                      mentions: [],
                      type: "text",
                      text: "[chief-of-staff] Status check: keep working on the task. If something genuinely blocks you, call cos_ask (kind \"decision\") or end with COS:BLOCKED <reason>. If you are finished, end with COS:DONE <summary>.",
                    },
                  ],
                });
                db.prepare(`UPDATE items SET nudged_at=?, updated_at=? WHERE id=?`).run(now(), now(), item.id);
                logActivity(item.id, "nudged", `Nudged an idle worker`);
                publish();
              } catch (cause) {
                bb.log.warn(`nudge failed for item ${item.id}: ${String(cause)}`);
              }
            }
          }
        } catch (cause) {
          bb.log.warn(`sweep iteration failed: ${String(cause)}`);
        }
        await sleep(60_000, signal);
      }
    },
  });

  // --- RPC -------------------------------------------------------------------

  function snapshot() {
    const items = (
      db.prepare(`SELECT * FROM items ORDER BY created_at DESC LIMIT 200`).all() as ItemRow[]
    ).map(toItem);
    const pendingDecisions = (
      db
        .prepare(`SELECT * FROM decisions WHERE status='pending' ORDER BY created_at ASC LIMIT 50`)
        .all() as DecisionRow[]
    ).map(toDecision);
    const activity = (
      db.prepare(`SELECT * FROM activity ORDER BY created_at DESC, rowid DESC LIMIT 30`).all() as Array<{
        id: string;
        item_id: string | null;
        kind: string;
        message: string;
        created_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      itemId: row.item_id,
      kind: row.kind,
      message: row.message,
      createdAt: row.created_at,
    }));
    return { items, pendingDecisions, activity };
  }

  bb.rpc.register(rpcContract, {
    brief_get: () => snapshot(),

    items_add: async ({ title }) => {
      const id = randomUUID().slice(0, 8);
      db.prepare(
        `INSERT INTO items (id, title, detail, status, created_at, updated_at) VALUES (?, ?, '', 'queued', ?, ?)`,
      ).run(id, title, now(), now());
      let item = getItem(id)!;
      try {
        item = await spawnWorker(item);
      } catch (cause) {
        db.prepare(`UPDATE items SET status='failed', summary=?, updated_at=? WHERE id=?`).run(
          `Failed to open a worker: ${String(cause).slice(0, 200)}`,
          now(),
          id,
        );
        logActivity(id, "failed", `Could not open worker thread: ${String(cause)}`);
        item = getItem(id)!;
      }
      publish();
      return { item: toItem(item) };
    },

    items_remove: async ({ id }) => {
      const item = getItem(id);
      if (item === undefined) return { removed: false };
      if (item.thread_id !== null) {
        try {
          await bb.sdk.threads.stop({ threadId: item.thread_id });
        } catch (cause) {
          bb.log.warn(`stop on remove failed: ${String(cause)}`);
        }
      }
      db.prepare(`DELETE FROM items WHERE id=?`).run(id);
      db.prepare(`DELETE FROM decisions WHERE item_id=?`).run(id);
      logActivity(null, "note", `Removed backlog item "${item.title}"`);
      publish();
      return { removed: true };
    },

    items_retry: async ({ id }) => {
      const item = getItem(id);
      if (item === undefined) throw new Error(`No item ${id}`);
      db.prepare(`UPDATE items SET status='queued', summary=NULL, nudged_at=NULL, updated_at=? WHERE id=?`).run(now(), id);
      let updated = getItem(id)!;
      try {
        updated = await spawnWorker(updated);
      } catch (cause) {
        db.prepare(`UPDATE items SET status='failed', summary=?, updated_at=? WHERE id=?`).run(
          `Retry failed: ${String(cause).slice(0, 200)}`,
          now(),
          id,
        );
        updated = getItem(id)!;
      }
      publish();
      return { item: toItem(updated) };
    },

    decisions_resolve: async ({ decisionId, action, answer }) => {
      const row = resolveDecisionRow(decisionId, action, answer);
      if (row === undefined) throw new Error(`Decision ${decisionId} is not pending`);
      if (row.item_id !== null) {
        const item = getItem(row.item_id);
        if (item !== undefined && item.status === "blocked") {
          db.prepare(`UPDATE items SET status='running', updated_at=? WHERE id=?`).run(now(), item.id);
        }
      }
      logActivity(
        row.item_id,
        "decision",
        action === "answer"
          ? `You answered: ${row.question}`
          : `You dismissed: ${row.question}`,
      );
      publish();
      const fresh = db.prepare(`SELECT * FROM decisions WHERE id=?`).get(decisionId) as DecisionRow;
      return { decision: toDecision(fresh) };
    },
  });

  // --- CLI ---------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb chief-of-staff brief                     -- progress briefing + pending decisions",
    "  bb chief-of-staff list                      -- all backlog items",
    "  bb chief-of-staff add <title>               -- add a backlog item and open its worker",
    "  bb chief-of-staff retry <item-id>           -- reopen a worker for an item",
    "  bb chief-of-staff decide <decision-id> <answer|dismiss> [text]",
    "  bb chief-of-staff remove <item-id>",
  ].join("\n");

  bb.cli.register({
    name: "chief-of-staff",
    summary: "Backlog triage: worker threads, auto-answered questions, escalations",
    commands: [
      { name: "brief", summary: "Progress briefing with pending decisions", usage: "bb chief-of-staff brief" },
      { name: "list", summary: "List backlog items", usage: "bb chief-of-staff list [--json]" },
      { name: "add", summary: "Add a backlog item and open its worker thread", usage: "bb chief-of-staff add <title>" },
      { name: "retry", summary: "Reopen a worker thread for an item", usage: "bb chief-of-staff retry <item-id>" },
      { name: "decide", summary: "Answer or dismiss a pending decision", usage: "bb chief-of-staff decide <decision-id> <answer|dismiss> [text]" },
      { name: "remove", summary: "Remove a backlog item", usage: "bb chief-of-staff remove <item-id>" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "list":
        case "brief": {
          const snap = snapshot();
          const counts = { queued: 0, running: 0, blocked: 0, done: 0, failed: 0 };
          for (const item of snap.items) counts[item.status as keyof typeof counts]++;
          if (command === "list") {
            return reply(
              snap.items,
              snap.items.length === 0
                ? "Backlog is empty."
                : snap.items
                    .map((i) => `${i.id}  ${i.status.padEnd(7)}  ${i.title}`)
                    .join("\n"),
            );
          }
          const lines: string[] = [
            `Backlog: ${counts.done} done, ${counts.running} running, ${counts.blocked} blocked, ${counts.queued} queued, ${counts.failed} failed.`,
          ];
          if (snap.pendingDecisions.length > 0) {
            lines.push("", "Decisions waiting on you:");
            for (const d of snap.pendingDecisions) {
              lines.push(`  ${d.id}  ${d.question}${d.context ? ` — ${d.context}` : ""}`);
            }
            lines.push(`Resolve with: bb chief-of-staff decide <decision-id> answer "<your answer>"`);
          }
          if (snap.activity.length > 0) {
            lines.push("", "Recent activity:");
            for (const a of snap.activity.slice(0, 10)) {
              lines.push(`  ${a.createdAt.slice(11, 16)}  ${a.message}`);
            }
          }
          return reply({ counts, pendingDecisions: snap.pendingDecisions }, lines.join("\n"));
        }
        case "add": {
          const title = rest.join(" ").trim();
          if (title === "") break;
          const added = await addItemInternal(title);
          return reply(added, `Added "${added.title}" (${added.status}); worker thread ${added.threadId ?? "not opened"}.`);
        }
        case "retry": {
          const id = rest[0];
          if (id === undefined) break;
          const item = getItem(id);
          if (item === undefined) return { exitCode: 1, stderr: `No item ${id}.` };
          db.prepare(`UPDATE items SET status='queued', summary=NULL, nudged_at=NULL, updated_at=? WHERE id=?`).run(now(), id);
          const refreshed = await spawnWorker(getItem(id)!);
          publish();
          return reply(toItem(refreshed), `Reopened worker for "${refreshed.title}".`);
        }
        case "decide": {
          const [decisionId, verb, ...textParts] = rest;
          if (decisionId === undefined || verb === undefined) break;
          if (verb !== "answer" && verb !== "dismiss") break;
          const answerText = textParts.join(" ").trim() || undefined;
          const row = resolveDecisionRow(decisionId, verb, answerText);
          if (row === undefined) return { exitCode: 1, stderr: `Decision ${decisionId} is not pending. Run "bb chief-of-staff brief".` };
          if (row.item_id !== null) {
            const item = getItem(row.item_id);
            if (item !== undefined && item.status === "blocked") {
              db.prepare(`UPDATE items SET status='running', updated_at=? WHERE id=?`).run(now(), item.id);
            }
          }
          publish();
          return reply({ ok: true }, verb === "answer" ? `Answer delivered to the worker.` : `Dismissed; the worker proceeds safely.`);
        }
        case "remove": {
          const id = rest[0];
          if (id === undefined) break;
          const item = getItem(id);
          if (item === undefined) return { exitCode: 1, stderr: `No item ${id}.` };
          if (item.thread_id !== null) {
            try { await bb.sdk.threads.stop({ threadId: item.thread_id }); } catch { /* already stopped */ }
          }
          db.prepare(`DELETE FROM items WHERE id=?`).run(id);
          publish();
          return reply({ removed: true }, `Removed ${id}.`);
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // The CLI runs inside the same factory scope, so it can reuse internals.
  async function addItemInternal(title: string) {
    const id = randomUUID().slice(0, 8);
    db.prepare(
      `INSERT INTO items (id, title, detail, status, created_at, updated_at) VALUES (?, ?, '', 'queued', ?, ?)`,
    ).run(id, title, now(), now());
    let item = getItem(id)!;
    try {
      item = await spawnWorker(item);
    } catch (cause) {
      db.prepare(`UPDATE items SET status='failed', summary=?, updated_at=? WHERE id=?`).run(
        `Failed to open a worker: ${String(cause).slice(0, 200)}`,
        now(),
        id,
      );
      item = getItem(id)!;
    }
    publish();
    return toItem(item);
  }

  bb.onDispose(() => {
    bb.log.info("chief-of-staff disposed");
  });
  void PLUGIN_CLI_OUTPUT_MAX_BYTES;
}
