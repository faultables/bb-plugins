// bb-plugin-opencode-go — a BB plugin frontend entry.
import { useEffect, useState } from "react";
import { definePluginApp, Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { mountSidebarUsageStrip } from "@/lib/sidebar-strip";
import "@/lib/sidebar-strip.css";

type UsageWindow = {
  status: string;
  percent: number;
  resetsAt: string;
};

type UsageResult = {
  usage: { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow } | null;
  limits: { rolling: number; weekly: number; monthly: number };
  source: "settings" | "env" | "auth-file";
  error: string | null;
};

const REFRESH_MS = 60_000;

const windowMeta: Array<{
  key: "rolling" | "weekly" | "monthly";
  label: string;
  caption: string;
}> = [
  { key: "rolling", label: "Rolling 5 hours", caption: "5-hour usage window" },
  { key: "weekly", label: "Weekly", caption: "7-day usage window" },
  { key: "monthly", label: "Monthly", caption: "Billing month" },
];

function formatReset(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms)) return iso;
  if (ms <= 0) return "resets now";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function toneForPercent(percent: number) {
  if (percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function useUsage() {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<UsageResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;

    async function load() {
      try {
        const data = await rpc.call("getUsage", null);
        if (!disposed) setResult(data);
      } catch {
        if (!disposed) {
          setResult({
            usage: null,
            limits: { rolling: 12, weekly: 30, monthly: 60 },
            source: "auth-file",
            error: "Could not load usage from the OpenCode Go API.",
          });
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [rpc]);

  return {
    rpc,
    result,
    loading,
    refresh: async () => {
      setLoading(true);
      try {
        const data = await rpc.call("getUsage", null);
        setResult(data);
      } finally {
        setLoading(false);
      }
    },
  };
}

function LimitRow({
  label,
  caption,
  window,
  limit,
  compact,
}: {
  label: string;
  caption: string;
  window: UsageWindow;
  limit: number;
  compact?: boolean;
}) {
  const percent = Math.max(0, Math.min(100, window.percent));
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{label}</p>
          {!compact && <p className="text-xs text-muted-foreground">{caption}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {window.status !== "ok" && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
              Limited
            </span>
          )}
          <span className="text-xs tabular-nums text-muted-foreground">
            ${limit.toFixed(0)}
          </span>
        </div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${toneForPercent(percent)}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span className="tabular-nums">{percent}% used</span>
        <span>{formatReset(window.resetsAt)}</span>
      </div>
    </div>
  );
}

function GoUsagePanel() {
  const { rpc, result, loading, refresh } = useUsage();
  const [docs, setDocs] = useState<{ content: string | null; error: string | null } | null>(null);
  const [layout, setLayout] = useState<"rows" | "columns">(() =>
    typeof localStorage === "undefined"
      ? "rows"
      : localStorage.getItem("opencode-go-card-layout") === "columns"
        ? "columns"
        : "rows",
  );

  useEffect(() => {
    localStorage.setItem("opencode-go-card-layout", layout);
  }, [layout]);

  useEffect(() => {
    let disposed = false;
    void rpc
      .call("getDocs", null)
      .then((data) => {
        if (!disposed) setDocs(data);
      })
      .catch(() => {
        if (!disposed) setDocs({ content: null, error: "RPC failed" });
      });
    return () => {
      disposed = true;
    };
  }, [rpc]);

  const sourceLabels: Record<UsageResult["source"], string> = {
    settings: "key from plugin settings",
    env: "key from OPENCODE_GO_API_KEY",
    "auth-file": "key from the opencode CLI auth file",
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">OpenCode Go</h2>
              <p className="text-xs text-muted-foreground">
                Low-cost subscription for open coding models. $5 first month,
                then $10/month — usage tracked in dollars.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div className="flex rounded-md border border-border p-0.5">
                <button
                  onClick={() => setLayout("rows")}
                  className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${layout === "rows" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
                >
                  Rows
                </button>
                <button
                  onClick={() => setLayout("columns")}
                  className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${layout === "columns" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
                >
                  Columns
                </button>
              </div>
              <button
                onClick={() => void refresh()}
                disabled={loading}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                {loading ? "Loading…" : "Refresh"}
              </button>
            </div>
          </div>

        {result?.error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {result.error}
          </div>
        ) : !result ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Loading usage…
          </p>
        ) : result.usage ? (
          <>
            <div
              className={
                layout === "columns"
                  ? "grid grid-cols-1 gap-3 sm:grid-cols-3"
                  : "space-y-3"
              }
            >
              {windowMeta.map((meta) => (
                <LimitRow
                  key={meta.key}
                  label={meta.label}
                  caption={meta.caption}
                  window={result.usage![meta.key]}
                  limit={result.limits[meta.key]}
                  compact={layout === "columns"}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Using {sourceLabels[result.source]}. Reaching a limit blocks
              further requests unless Zen balance fallback is enabled.
            </p>
            <a
              href="https://opencode.ai/console"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Track usage in the OpenCode console →
            </a>
          </>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No usage data available.
          </p>
        )}

        {docs?.error ? (
          <p className="text-xs text-muted-foreground">
            Docs unavailable ({docs.error}).
          </p>
        ) : docs?.content ? (
          <div className="border-t border-border pt-4">
            <Markdown content={docs.content} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "sidebar-usage-strip",
    mount: ({ signal, pluginId }) =>
      mountSidebarUsageStrip(signal, pluginId),
  });

  app.slots.navPanel({
    id: "usage",
    title: "OpenCode Go",
    icon: "ChartColumn",
    path: "usage",
    component: GoUsagePanel,
  });
  app.slots.threadPanelAction({
    id: "usage",
    title: "OpenCode Go",
    icon: "ChartColumn",
    layout: "flush",
    component: GoUsagePanel,
  });
});
