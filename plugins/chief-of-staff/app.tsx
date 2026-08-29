// bb-plugin-chief-of-staff — frontend entry.
//
// One nav panel: your briefing at the top, decisions waiting on you, the
// backlog, and a recent-activity feed. Live updates arrive over the plugin's
// realtime channel; every mutation refetches the snapshot.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, CosActivity, CosDecision, CosItem } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
type Brief = {
  items: CosItem[];
  pendingDecisions: CosDecision[];
  activity: CosActivity[];
};

type Item = CosItem;
type Decision = CosDecision;

type Activity = CosActivity;

const STATUS_ORDER = ["blocked", "running", "queued", "failed", "done"] as const;

function statusClasses(status: Item["status"]): string {
  switch (status) {
    case "running":
      return "border-border bg-accent text-accent-foreground";
    case "blocked":
      return "border-destructive/40 text-destructive";
    case "failed":
      return "border-destructive/40 text-destructive line-through";
    case "done":
      return "border-border text-muted-foreground";
    default:
      return "border-border text-muted-foreground";
  }
}

function StatusBadge({ status }: { status: Item["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
        statusClasses(status),
      )}
    >
      {status === "running" && (
        <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status}
    </span>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function useBrief() {
  const rpc = useRpc<typeof rpcContract>();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("brief_get").then((result) => {
      setBrief(result);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("cos-changed", refetch);
  return { rpc, brief, error, report, refetch };
}

// --- decisions -------------------------------------------------------------

function DecisionCard({
  decision,
  onResolve,
}: {
  decision: Decision;
  onResolve: (action: "answer" | "dismiss", answer?: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const resolve = async (action: "answer" | "dismiss") => {
    if (busy) return;
    setBusy(true);
    try {
      await onResolve(action, action === "answer" ? answer.trim() || undefined : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-sm font-medium">{decision.question}</p>
      {decision.context ? (
        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{decision.context}</p>
      ) : null}
      <textarea
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="Your decision (optional — dismissing tells the worker to proceed safely)…"
        rows={2}
        aria-label={`Answer for: ${decision.question}`}
        className="mt-2 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void resolve("dismiss")}>
          Dismiss — proceed safely
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void resolve("answer")}>
          Send decision
        </Button>
      </div>
    </div>
  );
}

// --- item row ---------------------------------------------------------------

function ItemRow({
  item,
  onOpen,
  onRetry,
  onRemove,
}: {
  item: Item;
  onOpen: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center gap-3">
        <StatusBadge status={item.status} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            item.status === "done" && "text-muted-foreground",
          )}
          title={item.title}
        >
          {item.title}
        </span>
        {item.threadId !== null && (
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" onClick={onOpen}>
            <Icon name="ExternalLink" className="size-4" />
            <span className="sr-only">Open worker thread for "{item.title}"</span>
          </Button>
        )}
        {item.status !== "running" && item.status !== "done" && (
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" onClick={onRetry}>
            <Icon name="RotateCcw" className="size-4" />
            <span className="sr-only">Restart worker for "{item.title}"</span>
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" onClick={onRemove}>
          <Icon name="Trash2" className="size-4" />
          <span className="sr-only">Remove "{item.title}"</span>
        </Button>
      </div>
      {item.summary ? (
        <p className="pl-0.5 text-xs text-muted-foreground">{item.summary}</p>
      ) : null}
    </li>
  );
}

// --- page --------------------------------------------------------------------

function ChiefOfStaffPage() {
  const navigate = useBbNavigate();
  const { rpc, brief, error, report, refetch } = useBrief();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = title.trim();
    if (next === "" || pending) return;
    setPending(true);
    try {
      await rpc.call("items_add", { title: next });
      setTitle("");
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setPending(false);
    }
  };

  const counts = { blocked: 0, running: 0, done: 0 };
  for (const item of brief?.items ?? []) {
    if (item.status in counts) counts[item.status as keyof typeof counts]++;
  }
  const sortedItems = [...(brief?.items ?? [])].sort((a, b) => {
    const rank = (status: Item["status"]) => STATUS_ORDER.indexOf(status as (typeof STATUS_ORDER)[number]);
    const byStatus = rank(a.status) - rank(b.status);
    return byStatus !== 0 ? byStatus : b.createdAt.localeCompare(a.createdAt);
  });

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        {/* Briefing */}
        <section aria-label="Briefing">
          <h2 className="text-sm font-semibold">Briefing</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {(
              [
                ["running", counts.running],
                ["blocked", counts.blocked],
                ["done", counts.done],
              ] as const
            ).map(([label, count]) => (
              <span
                key={label}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                  label === "blocked" && count > 0
                    ? "border-destructive/40 text-destructive"
                    : "border-border text-muted-foreground",
                )}
              >
                {count} {label}
              </span>
            ))}
          </div>
          {error !== null && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </section>

        {/* Add to backlog */}
        <form onSubmit={add} className="flex items-center gap-2" aria-label="Add backlog item">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Add a backlog item — a worker thread opens for it…"
            aria-label="New backlog item"
          />
          <Button type="submit" disabled={pending || title.trim() === ""}>
            <Icon name="Plus" className="size-4" />
            Delegate
          </Button>
        </form>

        {/* Decisions waiting on you */}
        {(brief?.pendingDecisions.length ?? 0) > 0 && (
          <section aria-label="Decisions waiting on you">
            <h2 className="text-sm font-semibold">
              Only you can make these ({brief!.pendingDecisions.length})
            </h2>
            <div className="mt-2 space-y-2">
              {brief!.pendingDecisions.map((decision) => (
                <DecisionCard
                  key={decision.id}
                  decision={decision}
                  onResolve={async (action, answer) => {
                    await rpc.call("decisions_resolve", {
                      decisionId: decision.id,
                      action,
                      ...(answer !== undefined ? { answer } : {}),
                    });
                    refetch();
                  }}
                />
              ))}
            </div>
          </section>
        )}

        {/* Backlog */}
        <section aria-label="Backlog">
          <h2 className="text-sm font-semibold">Backlog</h2>
          <div className="mt-2">
            {brief === null ? (
              <EmptyState>Loading…</EmptyState>
            ) : sortedItems.length === 0 ? (
              <EmptyState>
                Nothing delegated yet. Add an item above and a worker thread opens for it.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {sortedItems.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    onOpen={() => navigate.toThread(item.threadId!)}
                    onRetry={() => {
                      rpc.call("items_retry", { id: item.id }).then(refetch, report);
                    }}
                    onRemove={() => {
                      rpc.call("items_remove", { id: item.id }).then(refetch, report);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Activity */}
        {(brief?.activity.length ?? 0) > 0 && (
          <section aria-label="Recent activity">
            <h2 className="text-sm font-semibold">Recent activity</h2>
            <ul className="mt-2 space-y-1.5">
              {brief!.activity.map((a: Activity) => (
                <li key={a.id} className="flex gap-2 text-xs text-muted-foreground">
                  <span className="shrink-0 font-mono">{a.createdAt.slice(11, 16)}</span>
                  <span className="min-w-0">{a.message}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "chief-of-staff",
    title: "Chief of Staff",
    icon: "Inbox",
    path: "chief-of-staff",
    component: ChiefOfStaffPage,
  });
});
