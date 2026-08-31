// iOS Simulators — a right-panel tab listing simulators served by baguette,
// with boot/shutdown controls, a live per-simulator view, and a configurable
// server hostname (plus optional auto-start of `baguette serve`).
// Now with SimSlim integration (https://github.com/mobai-app/simslim):
// fleet RAM, per-sim slim badge, and Slim/Unslim actions.
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

type FleetSim = {
  udid: string;
  name: string;
  state: string;
  osVersion?: string;
  managedDisabled?: number | null;
  managedTotal?: number;
  statusError?: string;
  memory?: { processes: number; bytes: number; cpu: number } | null;
  memoryError?: string;
  diskBytes?: number | null;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

  // SimSlim state
  const [simSlim, setSimSlim] = useState<{ installed: boolean; version: string | null; path: string | null } | null>(null);
  const [fleet, setFleet] = useState<FleetSim[] | null>(null);
  const [fleetTotal, setFleetTotal] = useState<number | null>(null);
  const [slimBusy, setSlimBusy] = useState<string | null>(null);
  const [showSlimAdvanced, setShowSlimAdvanced] = useState<string | null>(null);
  const [slimExcept, setSlimExcept] = useState("");
  const [slimKeep, setSlimKeep] = useState("");

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

  const refreshSimSlim = useCallback(async () => {
    try {
      const s = await rpc.call("getSimSlimStatus");
      setSimSlim({ installed: s.installed, version: s.version, path: s.path });
    } catch {
      setSimSlim({ installed: false, version: null, path: null });
    }
    try {
      const f = await rpc.call("getSimSlimFleet");
      setFleet(f.sims);
      setFleetTotal(f.totalBytes);
    } catch {
      setFleet(null);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    void refreshStatus();
    void refreshSimSlim();
  }, [load, refreshStatus, refreshSimSlim]);

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
      void refreshSimSlim();
    } else {
      // Even without a running-state flip, fleet may have changed (sim booted via simctl/simslim CLI)
      void refreshSimSlim();
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
        await refreshSimSlim();
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

  async function slimOn(sim: Simulator) {
    setSlimBusy(sim.udid);
    try {
      const payload: { udid: string; except?: string; keep?: string } = { udid: sim.udid };
      const except = slimExcept.trim();
      const keep = slimKeep.trim();
      if (except) payload.except = except;
      if (keep) payload.keep = keep;
      const result = await rpc.call("runSlimOn", payload);
      if (result.ok) {
        toast.success(`Slimmed ${sim.name} — rebooted slim`);
        await refreshSimSlim();
        await load();
      } else toast.error(result.message);
    } catch (e: any) {
      toast.error(String(e?.message ?? "Slim failed"));
    } finally {
      setSlimBusy(null);
    }
  }

  async function slimOff(sim: Simulator) {
    setSlimBusy(sim.udid);
    try {
      const result = await rpc.call("runSlimOff", { udid: sim.udid });
      if (result.ok) {
        toast.success(`Restored ${sim.name} to stock`);
        await refreshSimSlim();
        await load();
      } else toast.error(result.message);
    } catch (e: any) {
      toast.error(String(e?.message ?? "Restore failed"));
    } finally {
      setSlimBusy(null);
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

  const fleetByUdid = new Map<string, FleetSim>();
  for (const f of fleet ?? []) fleetByUdid.set(f.udid, f);

  function slimBadge(sim: Simulator) {
    const row = fleetByUdid.get(sim.udid);
    if (!row) {
      // shutdown — no live data, but simslim status would be unknown until booted
      if (!isRunning(sim)) return <span className="text-[11px] text-muted-foreground">—</span>;
      return <span className="text-[11px] text-muted-foreground">…</span>;
    }
    const disabled = row.managedDisabled;
    const total = row.managedTotal ?? 170;
    const bytes = row.memory?.bytes;
    if (typeof disabled !== "number") return <span className="text-[11px] text-muted-foreground">?</span>;
    const isSlim = disabled > total * 0.7; // heuristic: slim ≈170, stock ≈0
    const isPartial = disabled > 0 && !isSlim;
    return (
      <span className="flex items-center gap-1.5">
        <span
          className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
            isSlim ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : isPartial ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground"
          }`}
          title={`${disabled}/${total} daemons disabled`}
        >
          {isSlim ? "Slim" : isPartial ? "Partial" : "Stock"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {disabled}/{total}
        </span>
        {typeof bytes === "number" && (
          <span className="text-[11px] text-muted-foreground">{formatBytes(bytes)}</span>
        )}
      </span>
    );
  }

  function renderGroup(title: string, group: Simulator[]) {
    if (group.length === 0) return null;
    return (
      <div className="space-y-1.5">
        <h3 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {group.map((simulator) => {
          const fleetRow = fleetByUdid.get(simulator.udid);
          const disabled = fleetRow?.managedDisabled;
          const isSlim = typeof disabled === "number" && disabled > 120;
          const isBooted = isRunning(simulator);
          return (
            <div
              key={simulator.udid}
              className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex items-center gap-2">
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
                  <div className="mt-1">{slimBadge(simulator)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isBooted && (
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
                    variant={isBooted ? "outline" : "default"}
                    disabled={busyUdid === simulator.udid || slimBusy === simulator.udid}
                    onClick={() => void runAction(simulator, isBooted ? "shutdown" : "boot")}
                  >
                    {busyUdid === simulator.udid ? "…" : isBooted ? "Shut down" : "Boot"}
                  </Button>
                </div>
              </div>
              {simSlim?.installed && (
                <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
                  {isSlim ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={slimBusy === simulator.udid || busyUdid === simulator.udid}
                      onClick={() => void slimOff(simulator)}
                    >
                      {slimBusy === simulator.udid ? "Restoring…" : "Restore stock"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={slimBusy === simulator.udid || busyUdid === simulator.udid}
                      onClick={() => void slimOn(simulator)}
                    >
                      {slimBusy === simulator.udid ? "Slimming…" : "Slim"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowSlimAdvanced((v) => (v === simulator.udid ? null : simulator.udid))}
                  >
                    {showSlimAdvanced === simulator.udid ? "Hide options" : "Options"}
                  </Button>
                  {fleetRow?.memory && (
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {fleetRow.memory.processes} procs · {formatBytes(fleetRow.memory.bytes)}
                    </span>
                  )}
                </div>
              )}
              {showSlimAdvanced === simulator.udid && (
                <div className="space-y-2 rounded-md bg-muted/50 p-2">
                  <p className="text-[11px] text-muted-foreground">
                    Leave categories enabled (e.g. <code>search,store</code>) or keep daemons (e.g. <code>com.apple.apsd</code>). Empty = full slim (~170 daemons off, ~4× RAM).
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="except: siri,search"
                      value={slimExcept}
                      onChange={(e) => setSlimExcept(e.target.value)}
                      className="h-7 text-xs"
                    />
                    <Input
                      placeholder="keep: com.apple.apsd"
                      value={slimKeep}
                      onChange={(e) => setSlimKeep(e.target.value)}
                      className="h-7 text-xs"
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
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
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => { void load(); void refreshSimSlim(); }} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
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

      {/* SimSlim fleet bar */}
      <div className={`rounded-lg border p-3 text-sm ${simSlim?.installed ? "border-sky-500/30 bg-sky-500/5" : "border-border bg-card"}`}>
        <div className="flex items-center gap-2">
          <span className={`size-2 shrink-0 rounded-full ${simSlim?.installed ? "bg-sky-500" : "bg-muted-foreground/40"}`} aria-hidden />
          <p className="min-w-0 flex-1">
            {simSlim === null ? (
              "Checking SimSlim…"
            ) : simSlim.installed ? (
              <>
                <span className="font-medium">SimSlim</span> {simSlim.version} ·{" "}
                {fleet && fleet.length > 0 ? (
                  <>
                    {fleet.length} booted · {fleetTotal !== null ? formatBytes(fleetTotal) : "—"} total · ~4× RAM per slim sim
                  </>
                ) : (
                  "no booted sims — boot one to see RAM"
                )}
              </>
            ) : (
              <>SimSlim not installed — install with <code className="rounded bg-muted px-1 py-0.5 text-xs">brew install mobai-app/tap/simslim</code> or <code className="rounded bg-muted px-1 py-0.5 text-xs">go install github.com/mobai-app/simslim/cmd/simslim@latest</code></>
            )}
          </p>
          {simSlim?.installed && (
            <Button size="sm" variant="outline" onClick={() => void refreshSimSlim()}>
              Refresh
            </Button>
          )}
        </div>
        {simSlim?.installed && fleet && fleet.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            Slim disables ~170 daemons (widgets, Siri, search, etc.). Stock iPhone 17 Pro ~0.9–4 GB; slim → ~0.9 GB. <code>simslim on --except search</code> keeps Spotlight if you need it.
          </p>
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
