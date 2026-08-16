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
  uploadedDate: string | null;
  expirationDate: string | null;
  processingState: string | null;
  minOsVersion: string | null;
  internalBuildState: string | null;
  externalBuildState: string | null;
  statusLabel: string;
  testingGroups: string[];
};

type ManagedBuild = {
  build: Build;
  version: string;
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

type TestNote = {
  id: string;
  locale: string;
  whatsNew: string;
};

type BuildGroup = {
  id: string;
  name: string;
  isInternalGroup: boolean;
  hasAccessToAllBuilds: boolean;
};

function formatDate(value?: string | null) {
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

function BuildTestSettings({
  appId,
  build,
  version,
  defaultLocale,
  onClose,
}: {
  appId: string;
  build: Build;
  version: string;
  defaultLocale?: string;
  onClose?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [testNotes, setTestNotes] = useState<TestNote[]>([]);
  const [groups, setGroups] = useState<BuildGroup[]>([]);
  const [assignedGroupIds, setAssignedGroupIds] = useState<string[]>([]);
  const [locale, setLocale] = useState(defaultLocale || "en-US");
  const [whatsNew, setWhatsNew] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingGroups, setSavingGroups] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    setSaved(null);
    try {
      const result = await rpc.call("getBuildTestSettings", {
        appId,
        buildId: build.id,
      });
      setTestNotes(result.testNotes);
      setGroups(result.groups);
      setAssignedGroupIds(result.assignedGroupIds);
      if (result.error) {
        setError(result.error);
        return;
      }
      const nextLocale =
        result.testNotes.find((note) => note.locale === locale)?.locale ??
        result.testNotes[0]?.locale ??
        defaultLocale ??
        "en-US";
      setLocale(nextLocale);
      setWhatsNew(
        result.testNotes.find((note) => note.locale === nextLocale)?.whatsNew ??
          "",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [appId, build.id]);

  const locales = [
    ...new Set(
      [defaultLocale, ...testNotes.map((note) => note.locale)].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];

  function changeLocale(nextLocale: string) {
    setLocale(nextLocale);
    setWhatsNew(
      testNotes.find((note) => note.locale === nextLocale)?.whatsNew ?? "",
    );
    setSaved(null);
  }

  async function saveNotes() {
    setSavingNotes(true);
    setError(null);
    setSaved(null);
    try {
      const result = await rpc.call("setBuildTestNotes", {
        buildId: build.id,
        locale,
        whatsNew,
      });
      setTestNotes(result.testNotes);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved("Test details saved");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingNotes(false);
    }
  }

  async function saveGroups() {
    setSavingGroups(true);
    setError(null);
    setSaved(null);
    try {
      const result = await rpc.call("setBuildGroups", {
        appId,
        buildId: build.id,
        groupIds: assignedGroupIds,
      });
      setGroups(result.groups);
      setAssignedGroupIds(result.assignedGroupIds);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved("Build groups saved");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingGroups(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">TestFlight settings</p>
          <p className="text-xs text-muted-foreground">
            Version {version} · Build {build.buildNumber}
          </p>
        </div>
        {onClose && (
          <Button size="sm" variant="ghost" onClick={onClose}>
            Hide
          </Button>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Spinner />
          Loading test details…
        </div>
      )}

      {!loading && (
        <div className="mt-3 space-y-4">
          {error && (
            <div className="rounded-md border border-border bg-muted/40 p-2 text-xs text-destructive">
              {error}
              <Button
                size="sm"
                variant="ghost"
                className="ml-1 h-6 px-1"
                onClick={() => void load()}
              >
                Retry
              </Button>
            </div>
          )}

          {!error && (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor={`test-locale-${build.id}`}
                    className="text-xs font-medium"
                  >
                    Test details
                  </label>
                  <select
                    id={`test-locale-${build.id}`}
                    value={locale}
                    onChange={(event) => changeLocale(event.target.value)}
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                  >
                    {locales.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                    {locales.length === 0 && <option value={locale}>{locale}</option>}
                  </select>
                </div>
                <textarea
                  value={whatsNew}
                  maxLength={4000}
                  onChange={(event) => {
                    setWhatsNew(event.target.value);
                    setSaved(null);
                  }}
                  placeholder="What should testers focus on?"
                  rows={4}
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    What to Test · {whatsNew.length}/4000
                  </span>
                  <Button
                    size="sm"
                    disabled={savingNotes || !locale}
                    onClick={() => void saveNotes()}
                  >
                    {savingNotes ? <Spinner /> : "Save details"}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <div>
                  <p className="text-xs font-medium">Build groups</p>
                </div>
                {groups.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No TestFlight groups found for this app.
                  </p>
                ) : (
                  <div className="space-y-1 rounded-md border border-border p-2">
                    {groups.map((group) => {
                      const checked = assignedGroupIds.includes(group.id);
                      return (
                        <label
                          key={group.id}
                          className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={group.hasAccessToAllBuilds}
                            onChange={() =>
                              setAssignedGroupIds((current) =>
                                checked
                                  ? current.filter((id) => id !== group.id)
                                  : [...current, group.id],
                              )
                            }
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {group.name}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {group.hasAccessToAllBuilds
                              ? "All builds"
                              : group.isInternalGroup
                                ? "Internal"
                                : "External"}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <Button
                  size="sm"
                  className="w-full"
                  disabled={savingGroups || groups.length === 0}
                  onClick={() => void saveGroups()}
                >
                  {savingGroups ? <Spinner /> : "Save groups"}
                </Button>
              </div>
            </>
          )}

          {saved && (
            <p className="text-xs text-emerald-500" role="status">
              {saved}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function BuildsRow({
  build,
  hasMore,
  onSeeMore,
  loadingMore,
  onManage,
}: {
  build: Build;
  hasMore: boolean;
  onSeeMore?: () => void;
  loadingMore: boolean;
  onManage: () => void;
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
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2 text-xs"
          onClick={onManage}
        >
          Test details
        </Button>
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
  onManageBuild,
}: {
  version: Version;
  expanded: boolean;
  onToggle: () => void;
  onSeeMoreBuilds: () => void;
  loadingMore: boolean;
  onManageBuild: (build: Build, version: string) => void;
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
              onManage={() => onManageBuild(build, version.version)}
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
  const [managedBuild, setManagedBuild] = useState<ManagedBuild | null>(null);

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

        {managedBuild && (
          <div className="mt-4">
            <BuildTestSettings
              appId={app.id}
              build={managedBuild.build}
              version={managedBuild.version}
              defaultLocale={app.primaryLocale}
              onClose={() => setManagedBuild(null)}
            />
          </div>
        )}

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
                        onManageBuild={(build, version) =>
                          setManagedBuild({ build, version })
                        }
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
          <h1 className="text-lg font-semibold">App Store Connect</h1>
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

function CompactOverview({
  appId,
  defaultLocale,
}: {
  appId: string;
  defaultLocale?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [managedBuild, setManagedBuild] = useState<ManagedBuild | null>(null);

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
      {managedBuild && (
        <BuildTestSettings
          appId={appId}
          build={managedBuild.build}
          version={managedBuild.version}
          defaultLocale={defaultLocale}
          onClose={() => setManagedBuild(null)}
        />
      )}
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
                  {latest && <StatusPill label={latest.statusLabel} />}
                  {latest && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      Build {latest.buildNumber}
                    </span>
                  )}
                  {latest && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-base"
                      aria-label="Manage TestFlight settings"
                      onClick={() =>
                        setManagedBuild({
                          build: latest,
                          version: version.version,
                        })
                      }
                    >
                      <span aria-hidden>→</span>
                    </Button>
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
  const { projectId } = useBbContext();
  const [app, setApp] = useState<App | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!projectId) return;
      setLoading(true);
      const r = await rpc.call("getProjectApp", { projectId });
      if (cancelled) return;
      setApp(r.app);
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!projectId) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        Open a project to see its App Store Connect app.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (app) {
    return (
      <div className="space-y-4">
        <section className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-start gap-3">
            <AppIcon app={app} size={44} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">{app.name}</p>
                <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
                  Active
                </span>
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {app.bundleId ?? "No bundle ID"}
              </p>
            </div>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <div className="min-w-0">
              <dt className="text-muted-foreground">App ID</dt>
              <dd className="mt-0.5 break-all font-mono">{app.id}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">SKU</dt>
              <dd className="mt-0.5 break-all font-mono">{app.sku ?? "—"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">Primary locale</dt>
              <dd className="mt-0.5">{app.primaryLocale ?? "—"}</dd>
            </div>
          </dl>
        </section>
        <CompactOverview appId={app.id} defaultLocale={app.primaryLocale} />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
      No <code className="rounded bg-muted px-1">.bb/asc</code> file found for
      this project. Add one at the project root with your app&apos;s bundle id
      (e.g. <code className="rounded bg-muted px-1">com.penerbangwalet.flo</code>).
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "apps",
    title: "App Store Connect",
    icon: "AppStoreIcon",
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
