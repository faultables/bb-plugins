// bb-plugin-app-store-connect — a BB plugin frontend entry.
import { useEffect, useState } from "react";
import { definePluginApp, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";

type App = {
  id: string;
  name: string;
  bundleId?: string;
  sku?: string;
  primaryLocale?: string;
  iconUrl?: string | null;
};

function AppIcon({ app, size = 40 }: { app: App; size?: number }) {
  const [errored, setErrored] = useState(false);
  if (app.iconUrl && !errored) {
    return (
      <img
        src={app.iconUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setErrored(true)}
        className="shrink-0 rounded-lg border border-border"
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className="flex shrink-0 items-center justify-center rounded-lg border border-border bg-muted font-semibold text-muted-foreground"
    >
      {app.name.charAt(0).toUpperCase() || "?"}
    </div>
  );
}

type Build = {
  id: string;
  buildNumber: string;
  uploadedDate?: string;
  expirationDate?: string;
  processingState?: string;
  minOsVersion?: string;
  internalBuildState?: string;
  externalBuildState?: string;
  statusLabel: string;
  testingGroups: string[];
};

type Version = {
  id: string;
  version: string;
  testing: boolean;
  hasMoreBuilds: boolean;
  builds: Build[];
};

type Group = {
  platform: string;
  label: string;
  hasMoreVersions: boolean;
  versions: Version[];
};

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function statusTone(label: string) {
  if (label === "Testing") return "bg-emerald-500/15 text-emerald-500";
  if (label === "Approved" || label === "Ready to Submit")
    return "bg-sky-500/15 text-sky-500";
  if (label === "In Review" || label === "Waiting for Review")
    return "bg-amber-500/15 text-amber-500";
  if (label === "Rejected" || label === "Expired" || label === "Processing")
    return "bg-red-500/15 text-red-500";
  return "bg-muted text-muted-foreground";
}

function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      aria-hidden
    />
  );
}

function LoadingState() {
  return (
    <div className="flex justify-center pt-10">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

function StatusPill({ label }: { label: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(label)}`}
    >
      {label}
    </span>
  );
}

function BuildsRow({
  build,
  hasMore,
  onSeeMore,
  loadingMore,
}: {
  build: Build;
  hasMore: boolean;
  onSeeMore: () => void;
  loadingMore: boolean;
}) {
  const testing = build.testingGroups;
  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">Build {build.buildNumber}</p>
        <StatusPill label={build.statusLabel} />
        {testing.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-500">
            {testing.map((g) => `${g} testing`).join(" · ")}
          </span>
        )}
        {build.processingState && build.processingState !== "VALID" && (
          <span className="text-xs text-muted-foreground">
            {build.processingState}
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>min OS {build.minOsVersion ?? "—"}</span>
        <span>Uploaded {formatDate(build.uploadedDate)}</span>
        <span>Expires {formatDate(build.expirationDate)}</span>
      </div>
      {onSeeMore && hasMore && (
        <div className="mt-4">
          <Button
            size="sm"
            variant="ghost"
            className="w-full"
            disabled={loadingMore}
            onClick={onSeeMore}
          >
            {loadingMore ? (
              <Spinner />
            ) : (
              "See more builds"
            )}
          </Button>
        </div>
      )}
    </li>
  );
}

function VersionSection({
  version,
  expanded,
  onToggle,
  onSeeMoreBuilds,
  loadingMore,
}: {
  version: Version;
  expanded: boolean;
  onToggle: () => void;
  onSeeMoreBuilds: () => void;
  loadingMore: boolean;
}) {
  const lastBuildId = version.builds[version.builds.length - 1]?.id;
  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-left hover:bg-muted/60"
      >
        <span
          className={`inline-block text-[10px] leading-none text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          ▶
        </span>
        <span className="text-sm font-semibold">Version {version.version}</span>
        {version.testing && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-500">
            Testing
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {version.builds.length} builds
        </span>
      </button>
      {expanded && (
        <ul>
          {version.builds.length === 0 && (
            <li className="px-4 py-3 text-sm text-muted-foreground">
              No builds.
            </li>
          )}
          {version.builds.map((build) => (
            <BuildsRow
              key={build.id}
              build={build}
              hasMore={version.hasMoreBuilds}
              onSeeMore={build.id === lastBuildId ? onSeeMoreBuilds : undefined}
              loadingMore={loadingMore}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AppBuilds({ app, onBack }: { app: App; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [groups, setGroups] = useState<Group[]>([]);
  const [versionLimit, setVersionLimit] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMoreVersion, setLoadingMoreVersion] = useState<string | null>(null);
  const [loadingMoreVersions, setLoadingMoreVersions] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  async function load(limit: number) {
    setLoading(true);
    const result = await rpc.call("getBuildOverview", {
      appId: app.id,
      versionLimit: limit,
    });
    setGroups(result.groups);
    setError(result.error);
    setLoading(false);
  }

  useEffect(() => {
    void load(5);
  }, [app.id]);

  async function seeMoreVersions() {
    const next = versionLimit + 5;
    setVersionLimit(next);
    setLoadingMoreVersions(true);
    const result = await rpc.call("getBuildOverview", {
      appId: app.id,
      versionLimit: next,
    });
    setLoadingMoreVersions(false);
    if (result.error) return;
    setGroups((prev) => {
      const incoming = new Map(result.groups.map((g) => [g.platform, g]));
      return prev.map((g) => {
        const fresh = incoming.get(g.platform);
        if (!fresh) return g;
        const knownIds = new Set(g.versions.map((v) => v.id));
        const appended = fresh.versions.filter((v) => !knownIds.has(v.id));
        return { ...fresh, versions: [...g.versions, ...appended] };
      });
    });
  }

  async function seeMoreBuilds(version: Version) {
    setLoadingMoreVersion(version.id);
    const result = await rpc.call("listBuilds", {
      preReleaseVersionId: version.id,
      limit: 30,
    });
    setLoadingMoreVersion(null);
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        versions: g.versions.map((v) => {
          if (v.id !== version.id) return v;
          const existingIds = new Set(v.builds.map((b) => b.id));
          const appended = result.builds.filter((b) => !existingIds.has(b.id));
          return {
            ...v,
            builds: [...v.builds, ...appended],
            hasMoreBuilds: result.hasMore,
          };
        }),
      })),
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl p-4 md:p-5">
        <div className="flex items-center justify-between">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <span aria-hidden>←</span> Apps
          </button>
          <h1 className="truncate text-lg font-semibold">{app.name}</h1>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void load(versionLimit)}
          >
            Refresh
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{app.bundleId}</p>

        {loading && <LoadingState />}

        {!loading && error && (
          <div className="mt-6 rounded-lg border border-border bg-card p-4 text-sm text-destructive">
            Failed to load builds: {error}
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <p className="mt-6 text-sm text-muted-foreground">
            No builds found for this app.
          </p>
        )}

        {!loading && !error && groups.length > 0 && (
          <div className="mt-5 space-y-6">
            {groups.map((group) => (
              <section key={group.platform}>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-base font-semibold">{group.label}</h2>
                  {group.versions.some((v) => v.testing) && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-500">
                      Testing
                    </span>
                  )}
                </div>
                <div className="space-y-3">
                  {group.versions.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No versions yet.
                    </p>
                  )}
                  {group.versions.map((version, i) => {
                    const defaultExpanded = i === 0;
                    const expanded =
                      collapsed[version.id] === undefined
                        ? defaultExpanded
                        : !collapsed[version.id];
                    return (
                      <VersionSection
                        key={version.id}
                        version={version}
                        expanded={expanded}
                        onToggle={() =>
                          setCollapsed((prev) => ({
                            ...prev,
                            [version.id]: expanded,
                          }))
                        }
                        onSeeMoreBuilds={() => void seeMoreBuilds(version)}
                        loadingMore={loadingMoreVersion === version.id}
                      />
                    );
                  })}
                  {group.hasMoreVersions && (
                    <div className="mt-4">
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        disabled={loadingMoreVersions}
                        onClick={() => void seeMoreVersions()}
                      >
                        {loadingMoreVersions ? (
                          <Spinner />
                        ) : (
                          "See more versions"
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AppsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [apps, setApps] = useState<App[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<App | null>(null);

  async function load() {
    setLoading(true);
    const result = await rpc.call("listApps");
    setApps(result.apps);
    setError(result.error);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  if (selected) {
    return <AppBuilds app={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl p-4 md:p-5">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">My Apps</h1>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Select an app to view its TestFlight builds by platform and version.
        </p>

        {loading && (
          <LoadingState />
        )}

        {!loading && error && (
          <div className="mt-6 rounded-lg border border-border bg-card p-4 text-sm text-destructive">
            Failed to list apps: {error}
          </div>
        )}

        {!loading && !error && apps.length === 0 && (
          <p className="mt-6 text-sm text-muted-foreground">No apps found.</p>
        )}

        {!loading && !error && apps.length > 0 && (
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
            {apps.map((app) => (
              <li key={app.id}>
                <button
                  onClick={() => setSelected(app)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
                >
                  <AppIcon app={app} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{app.name}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {app.bundleId}
                      {app.primaryLocale ? ` · ${app.primaryLocale}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CompactOverview({ appId }: { appId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const r = await rpc.call("getBuildOverview", { appId, versionLimit: 3 });
      if (cancelled) return;
      setGroups(r.groups);
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [appId]);

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No builds yet.</p>;
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.platform}>
          <p className="mb-1 text-sm font-semibold">{group.label}</p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {group.versions.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">
                No versions.
              </li>
            )}
            {group.versions.map((version) => {
              const latest = version.builds[0];
              return (
                <li
                  key={version.id}
                  className="flex items-center gap-2 px-3 py-2"
                >
                  <span className="text-sm font-medium">
                    Version {version.version}
                  </span>
                  {version.testing && (
                    <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-500">
                      Testing
                    </span>
                  )}
                  {latest && <StatusPill label={latest.statusLabel} />}
                  {latest && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      Build {latest.buildNumber}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ProjectAppPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId: contextProjectId } = useBbContext();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState<string | null>(contextProjectId);
  const [app, setApp] = useState<App | null>(null);
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState("");

  useEffect(() => {
    void (async () => {
      const r = await rpc.call("listProjects");
      setProjects(r.projects);
      if (r.projects.length > 0 && !r.projects.some((p) => p.id === projectId)) {
        setProjectId(r.projects[0].id);
      }
    })();
  }, []);

  async function load() {
    if (!projectId) return;
    setLoading(true);
    const r = await rpc.call("getProjectApp", { projectId });
    setApp(r.app);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [projectId]);

  function onProjectChange(next: string) {
    setProjectId(next);
    setPicking(false);
    setSelectedAppId("");
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          Project
        </label>
        <select
          value={projectId ?? ""}
          onChange={(e) => onProjectChange(e.target.value)}
          className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="flex justify-center py-6">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      )}

      {!loading && app && (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <AppIcon app={app} size={44} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{app.name}</p>
              <p className="truncate text-sm text-muted-foreground">
                {app.bundleId}
                {app.primaryLocale ? ` · ${app.primaryLocale}` : ""}
              </p>
            </div>
          </div>
          <CompactOverview appId={app.id} />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                setPicking(true);
                setSelectedAppId("");
                const r = await rpc.call("listApps");
                setApps(r.apps);
              }}
            >
              Change app
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (projectId) {
                  await rpc.call("setProjectApp", { projectId, appId: "" });
                }
                setApp(null);
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      )}

      {!loading && !app && picking && (
        <div className="space-y-3">
          <p className="text-sm font-medium">
            Associate an App Store Connect app
          </p>
          <select
            value={selectedAppId}
            onChange={(e) => setSelectedAppId(e.target.value)}
            className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
          >
            <option value="">Select an app…</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.bundleId})
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!selectedAppId || !projectId}
              onClick={async () => {
                if (!selectedAppId || !projectId) return;
                await rpc.call("setProjectApp", {
                  projectId,
                  appId: selectedAppId,
                });
                setPicking(false);
                await load();
              }}
            >
              Associate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!loading && !app && !picking && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            No App Store Connect app linked to this project.
          </p>
          <Button
            size="sm"
            onClick={async () => {
              setPicking(true);
              setSelectedAppId("");
              const r = await rpc.call("listApps");
              setApps(r.apps);
            }}
          >
            Link an app
          </Button>
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "apps",
    title: "My Apps",
    icon: "Smartphone",
    path: "apps",
    component: AppsPanel,
  });
  app.slots.threadPanelAction({
    id: "project-app",
    title: "App Store Connect",
    layout: "padded",
    component: ProjectAppPanel,
    run: async ({ openPanel }) => openPanel({}),
  });
});
