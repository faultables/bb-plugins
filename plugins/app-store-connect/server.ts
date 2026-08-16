// bb-plugin-app-store-connect — a BB plugin backend entry.
import { execFile } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const buildSchema = z.object({
  id: z.string(),
  buildNumber: z.string(),
  uploadedDate: z.string().nullable(),
  expirationDate: z.string().nullable(),
  processingState: z.string().nullable(),
  minOsVersion: z.string().nullable(),
  internalBuildState: z.string().nullable(),
  externalBuildState: z.string().nullable(),
  statusLabel: z.string(),
  testingGroups: z.array(z.string()),
});

const appSchema = z.object({
  id: z.string(),
  name: z.string(),
  bundleId: z.string().optional(),
  sku: z.string().optional(),
  primaryLocale: z.string().optional(),
  iconUrl: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  listApps: {
    input: z.null(),
    output: z.object({
      apps: z.array(appSchema),
      error: z.string().nullable(),
    }),
  },
  getBuildOverview: {
    input: z.object({ appId: z.string(), versionLimit: z.number().int().optional() }),
    output: z.object({
      groups: z.array(
        z.object({
          platform: z.string(),
          label: z.string(),
          hasMoreVersions: z.boolean(),
          versions: z.array(
            z.object({
              id: z.string(),
              version: z.string(),
              testing: z.boolean(),
              hasMoreBuilds: z.boolean(),
              builds: z.array(buildSchema),
            }),
          ),
        }),
      ),
      error: z.string().nullable(),
    }),
  },
  listBuilds: {
    input: z.object({
      preReleaseVersionId: z.string(),
      limit: z.number().int().optional(),
    }),
    output: z.object({
      builds: z.array(buildSchema),
      hasMore: z.boolean(),
      error: z.string().nullable(),
    }),
  },
  listProjects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  getProjectApp: {
    input: z.object({ projectId: z.string() }),
    output: z.object({ app: appSchema.nullable() }),
  },
  setProjectApp: {
    input: z.object({ projectId: z.string(), appId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
});

const BUILD_PREVIEW_LIMIT = 5;
const PLATFORM_LABELS: Record<string, string> = {
  IOS: "iOS Builds",
  MAC_OS: "macOS Builds",
  TV_OS: "tvOS Builds",
  VISION_OS: "visionOS Builds",
};

function platformLabel(platform: string) {
  return PLATFORM_LABELS[platform] ?? `${platform} Builds`;
}

function mapState(state?: string) {
  switch (state) {
    case "IN_BETA_TESTING":
      return "Testing";
    case "READY_FOR_BETA_SUBMISSION":
      return "Ready to Submit";
    case "WAITING_FOR_BETA_REVIEW":
      return "Waiting for Review";
    case "IN_BETA_REVIEW":
      return "In Review";
    case "BETA_APPROVED":
      return "Approved";
    case "BETA_REJECTED":
      return "Rejected";
    case "PROCESSING":
      return "Processing";
    case "EXPIRED":
      return "Expired";
    case "VALID":
      return "Valid";
    default:
      return state ?? "—";
  }
}

function versionSort(a: string, b: string) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    ascBin: {
      type: "string",
      label: "asc binary (path or name on PATH)",
      default: "asc",
    },
    cacheTtlSeconds: {
      type: "string",
      label: "Cache overview for this many seconds (0 to disable)",
      default: "300",
    },
  });

  const overviewCache = new Map<
    string,
    { data: Awaited<ReturnType<typeof computeOverview>>; fetchedAtMs: number }
  >();

  const iconCache = new Map<
    string,
    { url: string | null; fetchedAtMs: number }
  >();

  async function getAppIcon(appId: string) {
    const cached = iconCache.get(appId);
    if (cached && Date.now() - cached.fetchedAtMs < 24 * 60 * 60 * 1000) {
      return cached.url;
    }
    try {
      const res = await fetch(`https://itunes.apple.com/lookup?id=${appId}`);
      const json = (await res.json()) as { results?: Array<{ artworkUrl512?: string }> };
      const url = json.results?.[0]?.artworkUrl512 ?? null;
      iconCache.set(appId, { url, fetchedAtMs: Date.now() });
      return url;
    } catch (err) {
      bb.log.error(`app icon lookup for ${appId} failed: ${err instanceof Error ? err.message : String(err)}`);
      iconCache.set(appId, { url: null, fetchedAtMs: Date.now() });
      return null;
    }
  }

  async function computeOverview(appId: string, versionLimit: number) {
    const versions = await listPreReleaseVersions(appId);
    const grouped = new Map<string, typeof versions>();
    for (const v of versions) {
      if (!grouped.has(v.platform)) grouped.set(v.platform, []);
      grouped.get(v.platform)!.push(v);
    }

    const platformOrder = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"];
    const platforms = [...grouped.keys()].sort(
      (a, b) =>
        (platformOrder.indexOf(a) + 1 || 99) - (platformOrder.indexOf(b) + 1 || 99),
    );

    const groups = await mapLimit(platforms, 2, async (platform) => {
      const all = [...grouped.get(platform)!].sort((a, b) =>
        versionSort(a.version, b.version),
      );
      const shown = all.slice(0, versionLimit);
      const loaded = await mapLimit(shown, 2, async (v) => {
        const { builds, hasMore } = await loadVersionBuilds(v.id, BUILD_PREVIEW_LIMIT);
        return {
          id: v.id,
          version: v.version,
          testing: builds.some((b) => b.testingGroups.length > 0),
          hasMoreBuilds: hasMore,
          builds,
        };
      });
      return {
        platform,
        label: platformLabel(platform),
        hasMoreVersions: all.length > versionLimit,
        versions: loaded,
      };
    });

    return { groups, error: null as string | null };
  }

  async function getCachedOverview(appId: string, versionLimit: number) {
    const { cacheTtlSeconds } = await settings.get();
    const ttlSeconds = parseInt(cacheTtlSeconds, 10) || 0;
    const key = `${appId}:${versionLimit}`;
    const cached = overviewCache.get(key);
    if (
      cached &&
      ttlSeconds > 0 &&
      Date.now() - cached.fetchedAtMs < ttlSeconds * 1000
    ) {
      return cached.data;
    }
    try {
      const data = await computeOverview(appId, versionLimit);
      overviewCache.set(key, { data, fetchedAtMs: Date.now() });
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bb.log.error(`asc build overview failed: ${message}`);
      return { groups: [], error: message } as const;
    }
  }

  async function runAsc(args: string[]) {
    const { ascBin } = await settings.get();
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        ascBin,
        args,
        {
          env: { ...process.env },
          timeout: 90_000,
          maxBuffer: 40 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr?.trim() || error.message));
          else resolve(stdout);
        },
      );
    });
    return JSON.parse(stdout) as { data?: any[] };
  }

  async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let index = 0;
    async function worker() {
      while (index < items.length) {
        const i = index++;
        results[i] = await fn(items[i]);
      }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  async function listPreReleaseVersions(appId: string) {
    const parsed = await runAsc([
      "testflight",
      "pre-release",
      "list",
      "--app",
      appId,
      "--paginate",
    ]);
    return (parsed.data ?? [])
      .map((v: any) => ({
        id: v.id as string,
        version: (v.attributes?.version as string) ?? "",
        platform: (v.attributes?.platform as string) ?? "",
      }))
      .filter((v) => v.id && v.version);
  }

  async function listVersionBuilds(preReleaseVersionId: string, limit: number) {
    const parsed = await runAsc([
      "testflight",
      "pre-release",
      "builds",
      "list",
      "--id",
      preReleaseVersionId,
      "--limit",
      String(limit),
    ]);
    return (parsed.data ?? [])
      .map((b: any) => ({
        id: b.id as string,
        buildNumber: (b.attributes?.version as string) ?? "",
        uploadedDate: (b.attributes?.uploadedDate as string | undefined) ?? null,
        expirationDate: (b.attributes?.expirationDate as string | undefined) ?? null,
        processingState: (b.attributes?.processingState as string | undefined) ?? null,
        minOsVersion: (b.attributes?.minOsVersion as string | undefined) ?? null,
      }))
      .sort((a, b) => {
        const ta = a.uploadedDate ? new Date(a.uploadedDate).getTime() : 0;
        const tb = b.uploadedDate ? new Date(b.uploadedDate).getTime() : 0;
        return tb - ta;
      });
  }

  async function buildBetaDetail(buildId: string) {
    try {
      const parsed = await runAsc([
        "testflight",
        "distribution",
        "view",
        "--build-id",
        buildId,
      ]);
      const arr = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
      const attrs = arr[0]?.attributes ?? {};
      return {
        internalBuildState: (attrs.internalBuildState as string | undefined) ?? null,
        externalBuildState: (attrs.externalBuildState as string | undefined) ?? null,
      };
    } catch (err) {
      bb.log.error(`beta detail for ${buildId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { internalBuildState: null, externalBuildState: null };
    }
  }

  async function enrichBuild(build: Awaited<ReturnType<typeof listVersionBuilds>>[number]) {
    const { internalBuildState, externalBuildState } = await buildBetaDetail(build.id);
    const testingGroups: string[] = [];
    if (internalBuildState === "IN_BETA_TESTING") testingGroups.push("Internal");
    if (externalBuildState === "IN_BETA_TESTING") testingGroups.push("External");
    return {
      ...build,
      internalBuildState,
      externalBuildState,
      statusLabel: mapState(internalBuildState ?? externalBuildState),
      testingGroups,
    };
  }

  async function loadVersionBuilds(preReleaseVersionId: string, limit: number) {
    const raw = await listVersionBuilds(preReleaseVersionId, limit);
    const enriched = await mapLimit(raw, 6, enrichBuild);
    const hasMore = raw.length >= limit && enriched.length >= limit;
    return { builds: enriched, hasMore };
  }

  async function fetchApps() {
    const parsed = await runAsc(["apps", "list", "--output", "json"]);
    return (parsed.data ?? []).map((app: any) => ({
      id: app.id ?? "",
      name: app.attributes?.name ?? "Untitled",
      bundleId: app.attributes?.bundleId as string | undefined,
      sku: app.attributes?.sku as string | undefined,
      primaryLocale: app.attributes?.primaryLocale as string | undefined,
    }));
  }

  async function appsWithIcons() {
    const apps = await fetchApps();
    return await mapLimit(apps, 4, async (app) => ({
      ...app,
      iconUrl: await getAppIcon(app.id),
    }));
  }

  const PROJECT_APP_KEY = "project-app-map";
  async function getProjectAppMap() {
    return (await bb.storage.kv.get<Record<string, string>>(PROJECT_APP_KEY)) ?? {};
  }

  bb.rpc.register(rpcContract, {
    async listApps() {
      try {
        return { apps: await appsWithIcons(), error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        bb.log.error(`asc apps list failed: ${message}`);
        return { apps: [], error: message };
      }
    },

    async getBuildOverview({ appId, versionLimit = BUILD_PREVIEW_LIMIT }) {
      return getCachedOverview(appId, versionLimit);
    },

    async listBuilds({ preReleaseVersionId, limit = BUILD_PREVIEW_LIMIT }) {
      try {
        const { builds, hasMore } = await loadVersionBuilds(preReleaseVersionId, limit);
        return { builds, hasMore, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        bb.log.error(`asc builds list failed: ${message}`);
        return { builds: [], hasMore: false, error: message };
      }
    },

    async listProjects() {
      try {
        const projects = await bb.sdk.projects.list();
        return {
          projects: projects.map((p: any) => ({
            id: String(p.id),
            name: p.name ?? p.path ?? String(p.id),
          })),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        bb.log.error(`projects list failed: ${message}`);
        return { projects: [] };
      }
    },

    async getProjectApp({ projectId }) {
      try {
        const map = await getProjectAppMap();
        const appId = map[projectId];
        if (!appId) return { app: null };
        const apps = await appsWithIcons();
        const app = apps.find((a) => a.id === appId) ?? null;
        return { app };
      } catch (err) {
        bb.log.error(`get project app failed: ${err instanceof Error ? err.message : String(err)}`);
        return { app: null };
      }
    },

    async setProjectApp({ projectId, appId }) {
      const map = await getProjectAppMap();
      if (appId) map[projectId] = appId;
      else delete map[projectId];
      await bb.storage.kv.set(PROJECT_APP_KEY, map);
      return { ok: true };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
