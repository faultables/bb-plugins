// iOS Simulators — a right-panel tab listing simulators served by baguette,
// with boot/shutdown controls, a live per-simulator view, and a configurable
// server hostname (plus optional auto-start of `baguette serve`).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Simulator = {
  name: string;
  runtime: string;
  state: string;
  udid: string;
};

function isRunning(simulator: Simulator): boolean {
  return /booted/i.test(simulator.state);
}

function normalizeHost(hostname: string): string {
  const trimmed = hostname.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function normalizeHttpsUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  return `https://${trimmed.replace(/^https?:\/\//, "")}`;
}

// The panel branches on the tab's params: no params → the simulator list;
// `{ udid, name, runtime }` → the live stream page for that simulator.
function SimulatorsPanel({ params }: { params: unknown }) {
  const target = (params ?? null) as {
    udid?: string;
    name?: string;
    runtime?: string;
  } | null;
  if (target?.udid) {
    return (
      <SimulatorView
        udid={target.udid}
        name={target.name ?? "Simulator"}
        runtime={target.runtime ?? ""}
      />
    );
  }
  return <SimulatorList />;
}

function SimulatorView({
  udid,
  name,
  runtime,
}: {
  udid: string;
  name: string;
  runtime: string;
}) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const hostname = typeof values?.hostname === "string" ? values.hostname : "";
  const viewUrl = typeof values?.viewUrl === "string" ? values.viewUrl.trim() : "";
  const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
  const [viewBaseUrl, setViewBaseUrl] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  // The inline proxy URL is only usable from an HTTP page; on HTTPS it would
  // be blocked as mixed content, so skip loading it unless we'll iframe it.
  const canIframeInline = !isHttps || viewUrl.length > 0;
  useEffect(() => {
    if (!canIframeInline) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const status = await rpc.call("getBaguetteStatus");
        if (!cancelled) {
          if (status.viewBaseUrl) {
            setViewBaseUrl(status.viewBaseUrl);
          } else {
            retry = setTimeout(load, 2000);
          }
        }
      } catch {
        if (!cancelled) retry = setTimeout(load, 2000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [rpc, canIframeInline]);

  const openUrl = viewUrl
    ? `${normalizeHttpsUrl(viewUrl)}/simulators/${encodeURIComponent(udid)}`
    : `${normalizeHost(hostname)}/simulators/${encodeURIComponent(udid)}`;

  const inlineSrc = viewUrl
    ? `${normalizeHttpsUrl(viewUrl)}/simulators/${encodeURIComponent(udid)}`
    : viewBaseUrl !== null
      ? `${viewBaseUrl}/simulators/${encodeURIComponent(udid)}`
      : null;

  const mustOpenTab = isHttps && viewUrl.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            navigate.openThreadPanel({ actionId: "simulators", title: "iOS Simulators" })
          }
        >
          Back
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {runtime ? `${name} (${runtime})` : name}
        </p>
        {!mustOpenTab && (
          <Button size="sm" variant="outline" onClick={() => setFrameKey((k) => k + 1)}>
            Reload
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => window.open(openUrl, "_blank", "noopener")}
        >
          Open in new tab
        </Button>
      </div>
      {mustOpenTab ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            bb is served over HTTPS, so the HTTP simulator page can&apos;t be
            embedded inline. Set an HTTPS view URL in the plugin settings to
            embed it, or open it in a new tab.
          </p>
          <Button onClick={() => window.open(openUrl, "_blank", "noopener")}>
            Open simulator in a new tab
          </Button>
        </div>
      ) : inlineSrc === null ? (
        <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
          Connecting to simulator…
        </div>
      ) : (
        <iframe
          key={frameKey}
          src={inlineSrc}
          title={name}
          className="min-h-0 flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      )}
    </div>
  );
}

function SimulatorList() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [simulators, setSimulators] = useState<Simulator[]>([]);
  const [search, setSearch] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyUdid, setBusyUdid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baguette, setBaguette] = useState<{
    running: boolean;
    autoStart: boolean;
    spawned: boolean;
    stopped: boolean;
  } | null>(null);
  const previousRunning = useRef<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("listSimulators");
      setSimulators(result.simulators);
      setBaseUrl(result.baseUrl);
    } catch {
      setError("Could not reach the simulator server.");
      setSimulators([]);
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await rpc.call("getBaguetteStatus");
      previousRunning.current = status.running;
      setBaguette({
        running: status.running,
        autoStart: status.autoStart,
        spawned: status.spawned,
        stopped: status.stopped,
      });
    } catch {
      // keep whatever we had
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    void refreshStatus();
  }, [load, refreshStatus]);

  useRealtime("baguette-status", (payload) => {
    const status = payload as { running?: boolean; spawned?: boolean } | null;
    if (!status || typeof status.running !== "boolean") return;

    const running = status.running;
    const wasRunning = previousRunning.current;
    previousRunning.current = running;
    setBaguette((current) => ({
      running,
      spawned: status.spawned ?? current?.spawned ?? false,
      autoStart: current?.autoStart ?? true,
      stopped: current?.stopped ?? false,
    }));

    // Refresh on daemon start or stop so the list does not show stale
    // simulators after the server changes state outside the panel.
    if (wasRunning !== null && wasRunning !== running) {
      void load();
    }
  });

  async function runAction(simulator: Simulator, action: "boot" | "shutdown") {
    setBusyUdid(simulator.udid);
    try {
      const result = await rpc.call("runAction", {
        udid: simulator.udid,
        action,
      });
      if (result.ok) {
        toast.success(result.message);
        await load();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("Action failed");
    } finally {
      setBusyUdid(null);
    }
  }

  async function startBaguette() {
    try {
      const result = await rpc.call("startBaguette");
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      await refreshStatus();
      await load();
    } catch {
      toast.error("Could not start baguette");
    }
  }

  async function stopBaguette() {
    try {
      const result = await rpc.call("stopBaguette");
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      await refreshStatus();
      // The daemon owns the simulator list, so refresh it after stopping the
      // daemon instead of leaving the old list visible in the panel.
      await load();
    } catch {
      toast.error("Could not stop baguette");
    }
  }

  const normalizedSearch = search.trim().toLowerCase();
  const filteredSimulators = normalizedSearch
    ? simulators.filter((simulator) =>
        [simulator.name, simulator.runtime, simulator.state, simulator.udid].some(
          (value) => value.toLowerCase().includes(normalizedSearch),
        ),
      )
    : simulators;
  const running = filteredSimulators.filter(isRunning);
  const available = filteredSimulators.filter((s) => !isRunning(s));

  function renderGroup(title: string, group: Simulator[]) {
    if (group.length === 0) return null;
    return (
      <div className="space-y-1.5">
        <h3 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {group.map((simulator) => (
          <div
            key={simulator.udid}
            className="flex items-center gap-2 rounded-lg border border-border bg-card p-3"
          >
            <span
              className={`size-2 shrink-0 rounded-full ${
                isRunning(simulator) ? "bg-emerald-500" : "bg-muted-foreground/50"
              }`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {simulator.name}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {simulator.runtime} · {simulator.state}
              </p>
            </div>
            {isRunning(simulator) && (
              <Button
                size="sm"
                variant="outline"
                disabled={busyUdid === simulator.udid}
                onClick={() =>
                  navigate.openThreadPanel({
                    actionId: "simulators",
                    title: simulator.name,
                    params: {
                      udid: simulator.udid,
                      name: simulator.name,
                      runtime: simulator.runtime,
                    },
                  })
                }
              >
                View
              </Button>
            )}
            <Button
              size="sm"
              variant={isRunning(simulator) ? "outline" : "default"}
              disabled={busyUdid === simulator.udid}
              onClick={() =>
                void runAction(simulator, isRunning(simulator) ? "shutdown" : "boot")
              }
            >
              {busyUdid === simulator.udid
                ? "…"
                : isRunning(simulator)
                  ? "Shut down"
                  : "Boot"}
            </Button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {baseUrl ? (
            <>
              Server:{" "}
              <span className="font-medium text-foreground">{baseUrl}</span>
            </>
          ) : (
            "No simulator server configured."
          )}
        </p>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="simulator-search" className="text-xs font-medium text-muted-foreground">
          Search simulators
        </label>
        <Input
          id="simulator-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Name, runtime, state, or UDID"
        />
      </div>

      <div
        className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${
          baguette?.running
            ? "border-emerald-500/40 bg-emerald-500/10 text-foreground"
            : "border-border bg-card text-foreground"
        }`}
      >
        <span
          className={`size-2 shrink-0 rounded-full ${
            baguette?.running ? "bg-emerald-500" : "bg-amber-500"
          }`}
          aria-hidden
        />
        <p className="min-w-0 flex-1">
          {baguette === null
            ? "Checking baguette…"
            : baguette.running
              ? "Baguette is running."
              : baguette.stopped
                ? "Baguette is stopped."
                : baguette.autoStart
                  ? "Baguette is not running — the watchdog will start it."
                  : "Baguette is not running."}
        </p>
        {baguette && !baguette.running && (
          <Button size="sm" variant="outline" onClick={() => void startBaguette()}>
            Start
          </Button>
        )}
        {baguette?.running && (
          <Button size="sm" variant="outline" onClick={() => void stopBaguette()}>
            Stop
          </Button>
        )}
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error} Check the hostname in the plugin settings.
        </p>
      ) : loading && simulators.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Loading simulators…
        </p>
      ) : simulators.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No simulators found.
        </p>
      ) : filteredSimulators.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No simulators match “{search}”.
        </p>
      ) : (
        <>
          {renderGroup("Running", running)}
          {renderGroup("Available", available)}
        </>
      )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "simulators",
    title: "iOS Simulators",
    icon: "Smartphone",
    layout: "flush",
    component: SimulatorsPanel,
  });
});