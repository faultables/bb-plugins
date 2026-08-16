// bb-plugin-opencode-go — a BB plugin backend entry.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const DOCS_URL = "https://opencode.ai/docs/go.md";

const usageWindowSchema = z.object({
  status: z.string(),
  percent: z.number(),
  resetsAt: z.string(),
});

const usageSchema = z.object({
  usage: z.object({
    rolling: usageWindowSchema,
    weekly: usageWindowSchema,
    monthly: usageWindowSchema,
  }),
});

export const rpcContract = defineRpcContract({
  getUsage: {
    input: z.null(),
    output: z.object({
      usage: usageSchema.shape.usage.nullable(),
      limits: z.object({
        rolling: z.number(),
        weekly: z.number(),
        monthly: z.number(),
      }),
      source: z.enum(["settings", "env", "auth-file"]),
      error: z.string().nullable(),
    }),
  },
  getDocs: {
    input: z.null(),
    output: z.object({
      content: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
});

const OPENCODE_AUTH_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "auth.json",
);

async function readAuthFileKey() {
  try {
    const raw = await readFile(OPENCODE_AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { key?: string }>;
    return parsed["opencode-go"]?.key?.trim() || null;
  } catch {
    return null;
  }
}

function stripFrontmatter(md: string) {
  const body = md.replace(/^\uFEFF/, "");
  const idx = body.indexOf("\n\n");
  return idx >= 0 ? body.slice(idx + 2) : body;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "OpenCode Go API key (optional; falls back to the opencode CLI auth file)",
      secret: true,
    },
    rollingLimitDollars: {
      type: "string",
      label: "Rolling (5 hour) limit in USD",
      default: "12",
    },
    weeklyLimitDollars: {
      type: "string",
      label: "Weekly limit in USD",
      default: "30",
    },
    monthlyLimitDollars: {
      type: "string",
      label: "Monthly limit in USD",
      default: "60",
    },
  });

  const usageCache = new Map<string, { data: GetUsageResult; fetchedAtMs: number }>();

  async function resolveApiKey(): Promise<{
    key: string | null;
    source: GetUsageResult["source"];
  }> {
    const { apiKey } = await settings.get();
    if (apiKey?.trim()) return { key: apiKey.trim(), source: "settings" };
    if (process.env.OPENCODE_GO_API_KEY?.trim()) {
      return { key: process.env.OPENCODE_GO_API_KEY.trim(), source: "env" };
    }
    return { key: await readAuthFileKey(), source: "auth-file" };
  }

  async function fetchUsage(): Promise<GetUsageResult> {
    const { rollingLimitDollars, weeklyLimitDollars, monthlyLimitDollars } =
      await settings.get();
    const limits = {
      rolling: parseInt(rollingLimitDollars, 10) || 12,
      weekly: parseInt(weeklyLimitDollars, 10) || 30,
      monthly: parseInt(monthlyLimitDollars, 10) || 60,
    };

    const { key, source } = await resolveApiKey();
    if (!key) {
      const error =
        "No OpenCode Go API key found. Set one with `bb plugin config opencode-go set apiKey <key>`, set the OPENCODE_GO_API_KEY env var, or sign in with the opencode CLI (which writes ~/.local/share/opencode/auth.json).";
      bb.log.warn(error);
      return { usage: null, limits, source, error };
    }

    try {
      const res = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as {
            error?: { message?: string };
          };
          if (body.error?.message) detail = body.error.message;
        } catch {
          // keep the HTTP status detail
        }
        bb.log.error(`usage fetch failed: ${detail}`);
        return {
          usage: null,
          limits,
          source,
          error: `OpenCode Go usage request failed (${detail}). Check the API key in plugin settings.`,
        };
      }
      const parsed = usageSchema.parse(await res.json());
      return { usage: parsed.usage, limits, source, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bb.log.error(`usage fetch failed: ${message}`);
      return {
        usage: null,
        limits,
        source,
        error: `Could not reach the OpenCode Go usage API (${message}).`,
      };
    }
  }

  async function getCachedUsage(ttlSeconds: number): Promise<GetUsageResult> {
    const cached = usageCache.get("usage");
    if (cached && Date.now() - cached.fetchedAtMs < ttlSeconds * 1000) {
      return cached.data;
    }
    const data = await fetchUsage();
    usageCache.set("usage", { data, fetchedAtMs: Date.now() });
    return data;
  }

  const docsCache = new Map<string, { data: DocsResult; fetchedAtMs: number }>();

  async function fetchDocs() {
    try {
      const res = await fetch(DOCS_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        const error = `HTTP ${res.status}`;
        bb.log.warn(`docs fetch failed: ${error}`);
        return { content: null, error };
      }
      const content = stripFrontmatter(await res.text());
      if (!content.trim()) {
        bb.log.warn("docs fetch returned empty content");
        return { content: null, error: "Empty docs response." };
      }
      return { content, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bb.log.warn(`docs fetch failed: ${message}`);
      return { content: null, error: message };
    }
  }

  async function getCachedDocs(): Promise<DocsResult> {
    const cached = docsCache.get("docs");
    if (cached && Date.now() - cached.fetchedAtMs < 6 * 60 * 60 * 1000) {
      return cached.data;
    }
    const data = await fetchDocs();
    docsCache.set("docs", { data, fetchedAtMs: Date.now() });
    return data;
  }

  bb.rpc.register(rpcContract, {
    async getUsage() {
      return getCachedUsage(30);
    },

    async getDocs() {
      return getCachedDocs();
    },
  });

  bb.cli.register({
    name: "opencode-go",
    summary: "OpenCode Go usage and limits",
    commands: [
      {
        name: "usage",
        summary: "Show current OpenCode Go usage and limits",
        usage: "bb opencode-go usage",
      },
    ],
    async run(argv) {
      if (argv[0] !== "usage") {
        return {
          exitCode: 1,
          stderr: "Usage: bb opencode-go usage",
        };
      }
      const result = await fetchUsage();
      if (result.error || !result.usage) {
        return { exitCode: 1, stderr: result.error ?? "No usage data." };
      }
      const lines = ["OpenCode Go usage"];
      for (const [key, label] of [
        ["rolling", "Rolling (5h)"],
        ["weekly", "Weekly"],
        ["monthly", "Monthly"],
      ] as const) {
        const window = result.usage[key];
        lines.push(
          `  ${label}: ${window.percent}% used (${window.status}), resets ${formatReset(window.resetsAt)}, limit $${result.limits[key]}`,
        );
      }
      return { exitCode: 0, stdout: lines.join("\n") };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

type GetUsageResult = {
  usage: z.infer<typeof usageSchema>["usage"] | null;
  limits: { rolling: number; weekly: number; monthly: number };
  source: "settings" | "env" | "auth-file";
  error: string | null;
};

type DocsResult = {
  content: string | null;
  error: string | null;
};

function formatReset(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms)) return iso;
  if (ms <= 0) return "now";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}
