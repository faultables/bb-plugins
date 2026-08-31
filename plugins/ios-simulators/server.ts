// iOS Simulators — browse and control simulators served by baguette.
//
// The baguette server exposes `GET /simulators.json` (list, pre-split into
// running/available) and `POST /simulators/<udid>/<action>` (boot/shutdown).
// All requests proxy through this backend so the panel never hits CORS, and
// the server hostname is a declarative setting. A watchdog service starts
// `baguette serve --host <hostname host> --port <port>` when it is not running.
//
// Ownership of a spawned baguette is persisted by PID (KV) so it survives
// plugin reloads/server restarts: a spawned process that outlived its parent
// is still stoppable. SIGTERM is followed by SIGKILL because baguette may
// ignore the graceful signal.
//
// SimSlim integration: optionally drives `simslim` (https://github.com/mobai-app/simslim)
// to slim simulators (disable ~170 background daemons → ~4x RAM savings).
// All simslim calls are via CLI JSON mode and share the same `xcrun simctl`
// device set as baguette. Slim state is per-device launchd overrides, so a
// slimmed device boots slim thereafter.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const OWNER_KEY = "baguette-owner";
const MANUAL_STOP_KEY = "baguette-manual-stop";
const PROXY_PORT_KEY = "baguette-proxy-port";

export const rpcContract = defineRpcContract({
  listSimulators: {
    input: z.null(),
    output: z.object({
      baseUrl: z.string(),
      simulators: z.array(
        z
          .object({
            name: z.string(),
            runtime: z.string(),
            state: z.string(),
            udid: z.string(),
          })
          .strict(),
      ),
    }),
  },
  runAction: {
    input: z
      .object({
        udid: z.string().min(1),
        action: z.enum(["boot", "shutdown"]),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        message: z.string(),
      })
      .strict(),
  },
  getBaguetteStatus: {
    input: z.null(),
    output: z
      .object({
        running: z.boolean(),
        autoStart: z.boolean(),
        spawned: z.boolean(),
        stopped: z.boolean(),
        pid: z.number().int().nullable(),
        viewBaseUrl: z.string().nullable(),
        error: z.string().nullable(),
      })
      .strict(),
  },
  startBaguette: {
    input: z.null(),
    output: z
      .object({
        ok: z.boolean(),
        message: z.string(),
      })
      .strict(),
  },
  stopBaguette: {
    input: z.null(),
    output: z
      .object({
        ok: z.boolean(),
        message: z.string(),
      })
      .strict(),
  },
  // SimSlim RPCs
  getSimSlimStatus: {
    input: z.null(),
    output: z.object({
      installed: z.boolean(),
      version: z.string().nullable(),
      path: z.string().nullable(),
      managedTotal: z.number().int().nullable(),
      error: z.string().nullable(),
    }),
  },
  getSimSlimFleet: {
    input: z.null(),
    output: z.object({
      sims: z.array(
        z.object({
          udid: z.string(),
          name: z.string(),
          state: z.string(),
          osVersion: z.string().optional(),
          managedDisabled: z.number().int().nullable().optional(),
          managedTotal: z.number().int().optional(),
          statusError: z.string().optional(),
          memory: z
            .object({
              processes: z.number().int(),
              bytes: z.number().int(),
              cpu: z.number(),
            })
            .nullable()
            .optional(),
          memoryError: z.string().optional(),
          diskBytes: z.number().int().nullable().optional(),
        }),
      ),
      totalBytes: z.number().int(),
      error: z.string().nullable(),
    }),
  },
  getSimSlimProfiles: {
    input: z.null(),
    output: z.object({
      profiles: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          downside: z.string().optional(),
          approxMemoryMB: z.number().int().optional(),
          labels: z.array(z.string()),
        }),
      ),
      error: z.string().nullable(),
    }),
  },
  getSimSlimSimulatorInfo: {
    input: z.object({ udid: z.string().min(1) }).strict(),
    output: z.object({
      udid: z.string(),
      booted: z.boolean(),
      managedDisabled: z.number().int().nullable(),
      managedTotal: z.number().int().nullable(),
      verdict: z.string().nullable(),
      memory: z
        .object({ processes: z.number().int(), bytes: z.number().int(), cpu: z.number() })
        .nullable(),
      memoryError: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
  runSlimOn: {
    input: z
      .object({
        udid: z.string().min(1),
        except: z.string().optional(),
        keep: z.string().optional(),
        preserveBootState: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  runSlimOff: {
    input: z
      .object({ udid: z.string().min(1), preserveBootState: z.boolean().optional() })
      .strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
});

// Accept a bare host:port, an explicit http(s) URL, and stray trailing
// slashes; normalize into a fetch-ready base URL.
function normalizeBaseUrl(hostname: string): string {
  const trimmed = hostname.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

// The port baguette listens on, derived from the hostname setting.
function extractPort(hostname: string): number {
  try {
    const port = new URL(normalizeBaseUrl(hostname)).port;
    const parsed = Number(port);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return 8421;
}

// The host part of the hostname setting (e.g. "127.0.0.1"). Used to
// advertise the proxy at an address the browser can actually reach.
function extractHost(hostname: string): string {
  try {
    return new URL(normalizeBaseUrl(hostname)).hostname;
  } catch {
    const bare = hostname.trim().replace(/^https?:\/\//i, "").split(":")[0];
    return bare.length > 0 ? bare : "127.0.0.1";
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      { once: true },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHealthy(host: string, port: number): Promise<boolean> {
  return fetchWithTimeout(`http://${host}:${port}/simulators.json`, {
    headers: { accept: "application/json" },
    method: "GET",
  }, 2000)
    .then((response) => response.ok)
    .catch(() => false);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// SIGTERM first; baguette may ignore it, so escalate to SIGKILL.
async function killBaguettePid(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true; // already gone
  }
  await delay(1500);
  if (!isAlive(pid)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  return !isAlive(pid);
}

function resolveListenerPids(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(
        stdout
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0),
      );
    });
  });
}

function isBaguetteCommand(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "comm=", "-p", String(pid)], (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(stdout.trim().toLowerCase().includes("baguette"));
    });
  });
}

function resolveBaguette(): string {
  const candidates = [
    "baguette",
    "/opt/homebrew/bin/baguette",
    "/usr/local/bin/baguette",
    join(homedir(), ".local/bin/baguette"),
  ];
  for (const candidate of candidates) {
    if (!candidate.includes("/")) return candidate; // rely on PATH
    if (existsSync(candidate)) return candidate;
  }
  return "baguette";
}

// ---- SimSlim helpers ----

function resolveSimSlim(): string | null {
  const candidates = [
    join(homedir(), "go/bin/simslim"),
    "/opt/homebrew/bin/simslim",
    "/usr/local/bin/simslim",
    join(homedir(), ".local/bin/simslim"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // fall back to PATH lookup — execFile will fail if not found, caller handles
  return "simslim";
}

function execSimSlim(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  const bin = resolveSimSlim() ?? "simslim";
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const out = String(stdout ?? "") + String(stderr ?? "");
        // Attach output for caller to surface
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        (err as any).output = out;
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function shutdownBootedSimulators(): Promise<{ shutdown: number; errors: string[] }> {
  // Best-effort: shutdown every Booted device so "Stop baguette" also frees the ~1-4 GB per slim simulator.
  // Prefer simctl directly — works whether or not simslim is installed and avoids an extra binary lookup.
  // Slim overrides are persistent, so a later boot stays slim.
  let bootedUdids: string[] = [];
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile("xcrun", ["simctl", "list", "devices", "-j"], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      });
    });
    const parsed = JSON.parse(out) as { devices: Record<string, { udid: string; state: string }[]> };
    for (const list of Object.values(parsed.devices)) {
      for (const d of list) if (String(d.state).toLowerCase() === "booted") bootedUdids.push(d.udid);
    }
  } catch (e) {
    // Fallback: try simslim top --json if simctl parsing fails
    try {
      const { stdout } = await execSimSlim(["top", "--json"], 5000);
      const top = JSON.parse(stdout) as { sims: { udid: string }[] | null };
      bootedUdids = (top.sims ?? []).map((s) => s.udid);
    } catch {
      return { shutdown: 0, errors: [String((e as Error)?.message ?? e).slice(0, 200)] };
    }
  }
  if (bootedUdids.length === 0) return { shutdown: 0, errors: [] };
  const errors: string[] = [];
  let shutdown = 0;
  await Promise.all(
    bootedUdids.map(
      (udid) =>
        new Promise<void>((resolve) => {
          // Use simctl — simslim shutdown is the same but simctl is always present
          execFile("xcrun", ["simctl", "shutdown", udid], { timeout: 30_000 }, (err) => {
            if (!err) shutdown++;
            else errors.push(`${udid.slice(0, 8)}: ${String((err as any)?.message ?? err).slice(0, 120)}`);
            resolve();
          });
        }),
    ),
  );
  return { shutdown, errors };
}

async function simSlimVersion(): Promise<{ installed: boolean; version: string | null; path: string | null; error: string | null }> {
  const bin = resolveSimSlim();
  const path = bin && existsSync(bin) ? bin : bin;
  try {
    const { stdout } = await execSimSlim(["version"], 5000);
    const v = stdout.trim().split("\n")[0]?.trim() ?? null;
    return { installed: true, version: v && v.length ? v : "unknown", path, error: null };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/no such file|not found|ENOENT/i.test(msg)) return { installed: false, version: null, path: null, error: null };
    return { installed: false, version: null, path: null, error: msg.slice(0, 300) };
  }
}

interface BaguetteOwner {
  pid: number;
  port: number;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hostname: {
      type: "string",
      label: "Simulator server hostname",
      description: "Host and port of the baguette simulator server.",
      default: "127.0.0.1:8421",
    },
    autoStart: {
      type: "boolean",
      label: "Start baguette automatically",
      description: "Run `baguette serve --host <hostname>` when it is not running.",
      default: true,
    },
    viewUrl: {
      type: "string",
      label: "HTTPS view URL",
      description:
        "Optional HTTPS base URL (no scheme) that reaches the simulator server, e.g. sim.example.com. Required to embed the simulator inline when bb is served over HTTPS.",
      default: "",
    },
  });

  let baguette: ChildProcess | null = null;
  let baguetteError: string | null = null;
  let backoffUntil = 0;
  let proxyServer: HttpServer | null = null;
  let proxyPort: number | null = null;

  // baguette sends `Content-Security-Policy: frame-ancestors 'none'`, which
  // blocks embedding its pages in an iframe. Serve it through a reverse proxy
  // that strips that header (and X-Frame-Options) and tunnels the stream's
  // WebSocket upgrade to baguette. The proxy is a loopback service: the
  // Cloudflare tunnel ingress targets 127.0.0.1, and the frontend reaches it
  // through the tunnel's HTTPS hostname (viewUrl).
  const targetOriginFor = async (): Promise<string> => {
    const { hostname } = await settings.get();
    return normalizeBaseUrl(hostname);
  };

  // baguette rejects requests carrying an Origin (or Referer) it does not
  // trust, returning 403. Browsers always send Origin for POSTs and WS
  // handshakes, so strip both before forwarding.
  const forwardHeaders = (req: IncomingMessage, target: URL) => {
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: target.host,
    };
    delete headers.origin;
    delete headers.referer;
    return headers;
  };

  const proxyRequest = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const origin = await targetOriginFor();
      const target = new URL(origin + (req.url ?? "/"));
      const transport =
        target.protocol === "https:" ? httpsRequest : httpRequest;
      const proxyReq = transport(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          method: req.method,
          path: target.pathname + target.search,
          headers: forwardHeaders(req, target),
        },
        (proxyRes) => {
          const headers = { ...proxyRes.headers };
          delete headers["content-security-policy"];
          delete headers["content-security-policy-report-only"];
          delete headers["x-frame-options"];
          res.writeHead(proxyRes.statusCode ?? 502, headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("proxy error");
        } else {
          res.destroy();
        }
      });
      req.pipe(proxyReq);
    } catch {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("proxy error");
      }
    }
  };

  const proxyUpgrade = (req: IncomingMessage, socket: any, head: Buffer) => {
    void (async () => {
      try {
        const origin = await targetOriginFor();
        const target = new URL(origin + (req.url ?? "/"));
        const proxySocket = netConnect({
          host: target.hostname,
          port: Number(target.port) || (target.protocol === "https:" ? 443 : 80),
        });
        proxySocket.once("connect", () => {
          const headers = forwardHeaders(req, target);
          const headText = `${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${Object.entries(headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\r\n")}\r\n\r\n`;
          proxySocket.write(headText);
          proxySocket.write(head);
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });
        const teardown = () => {
          proxySocket.destroy();
          socket.destroy();
        };
        proxySocket.on("error", teardown);
        socket.on("error", teardown);
        socket.on("close", teardown);
        proxySocket.on("close", teardown);
      } catch {
        socket.destroy();
      }
    })();
  };

  const ensureProxy = async (): Promise<void> => {
    if (proxyServer !== null) return;

    const listen = (server: HttpServer, port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          const address = server.address();
          const bound =
            typeof address === "object" && address !== null ? address.port : null;
          if (bound === null) reject(new Error("proxy could not bind"));
          else resolve(bound);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });

    // Prefer the previously bound port so the frontend's cached view URL stays
    // valid across reloads; fall back to a fresh random port if it is taken.
    const stored = await bb.storage.kv.get<{ port: number }>(PROXY_PORT_KEY);
    const candidates = stored?.port ? [stored.port, 0] : [0];
    for (const candidate of candidates) {
      const server = createHttpServer((req, res) => {
        void proxyRequest(req, res);
      });
      server.on("upgrade", proxyUpgrade);
      try {
        const bound = await listen(server, candidate);
        proxyServer = server;
        proxyPort = bound;
        await bb.storage.kv.set(PROXY_PORT_KEY, { port: bound });
        bb.log.info(`baguette proxy listening on 127.0.0.1:${bound}`);
        return;
      } catch {
        // EADDRINUSE (or bind failure) — drop this server, try the next.
        server.removeAllListeners();
      }
    }
    proxyPort = null;
  };

  const publishStatus = (running: boolean) => {
    bb.realtime.publish("baguette-status", {
      running,
      spawned: baguette !== null,
      pid: baguette?.pid ?? null,
      error: baguetteError,
    });
  };

  const ownedPid = async (): Promise<number | null> => {
    if (baguette !== null && baguette.pid !== undefined && isAlive(baguette.pid)) {
      return baguette.pid;
    }
    const owner = await bb.storage.kv.get<BaguetteOwner>(OWNER_KEY);
    if (owner && isAlive(owner.pid)) return owner.pid;
    return null;
  };

  const clearOwnership = async () => {
    await bb.storage.kv.delete(OWNER_KEY);
  };

  const spawnBaguette = async (port: number, host: string): Promise<string | null> => {
    if (baguette !== null) return null;
    const command = resolveBaguette();
    let child: ChildProcess;
    try {
      child = spawn(
        command,
        ["serve", "--host", host, "--port", String(port)],
        { stdio: "ignore" },
      );
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      baguetteError = message;
      bb.log.warn(`could not start baguette: ${message}`);
      return message;
    }
    if (child.pid === undefined) {
      const message = "baguette started without a pid";
      baguetteError = message;
      bb.log.warn(message);
      return message;
    }
    baguette = child;
    baguetteError = null;
    await bb.storage.kv.set(OWNER_KEY, { pid: child.pid, port });
    await bb.storage.kv.delete(MANUAL_STOP_KEY);
    child.once("error", (error) => {
      baguetteError = String(error.message ?? error);
      bb.log.warn(`baguette spawn failed: ${baguetteError}`);
    });
    child.once("exit", () => {
      void (async () => {
        if (baguette === child) baguette = null;
        const owner = await bb.storage.kv.get<BaguetteOwner>(OWNER_KEY);
        if (owner?.pid === child.pid) await clearOwnership();
        publishStatus(false);
      })();
    });
    bb.log.info(`spawned baguette (pid ${child.pid})`);
    publishStatus(true);
    return null;
  };

  // Watchdog: keep baguette running (if autoStart) and surface its status.
  bb.background.service("baguette-watchdog", {
    async start(signal) {
      while (!signal.aborted) {
        const { hostname, autoStart } = await settings.get();
        const port = extractPort(hostname);
        const bindHost = extractHost(hostname);
        const healthy = await isHealthy(bindHost, port);
        const manualStop = await bb.storage.kv.get<{ port: number }>(MANUAL_STOP_KEY);

        if (healthy) {
          baguetteError = null;
          publishStatus(true);
        } else {
          if (baguette !== null && baguette.exitCode !== null) {
            baguette = null;
          }
          const now = Date.now();
          const suppressAutoStart = manualStop?.port === port;
          if (autoStart && !suppressAutoStart && baguette === null && now >= backoffUntil) {
            const failed = await spawnBaguette(port, bindHost);
            if (failed !== null) backoffUntil = now + 60_000;
          } else {
            publishStatus(false);
          }
        }

        await sleep(15_000, signal);
      }
    },
  });

  bb.rpc.register(rpcContract, {
    async listSimulators() {
      const { hostname } = await settings.get();
      const baseUrl = normalizeBaseUrl(hostname);
      let response: Response;
      try {
        response = await fetchWithTimeout(`${baseUrl}/simulators.json`, {
          headers: { accept: "application/json" },
        });
      } catch {
        return { baseUrl, simulators: [] };
      }
      if (!response.ok) return { baseUrl, simulators: [] };
      const json = (await response.json().catch(() => null)) as {
        running?: SimulatorDto[];
        available?: SimulatorDto[];
      } | null;
      const simulators = [
        ...(json?.running ?? []),
        ...(json?.available ?? []),
      ];
      return { baseUrl, simulators };
    },

    async runAction({ udid, action }) {
      const { hostname } = await settings.get();
      const baseUrl = normalizeBaseUrl(hostname);
      try {
        const response = await fetchWithTimeout(
          `${baseUrl}/simulators/${encodeURIComponent(udid)}/${action}`,
          { method: "POST" },
        );
        if (response.ok) {
          return {
            ok: true,
            message: `${action === "boot" ? "Booted" : "Shut down"} ${udid}`,
          };
        }
        const text = await response.text().catch(() => "");
        return {
          ok: false,
          message: `Server replied ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
        };
      } catch {
        return {
          ok: false,
          message: `Could not reach ${baseUrl}`,
        };
      }
    },

    async getBaguetteStatus() {
      await ensureProxy();
      const { hostname, autoStart } = await settings.get();
      const port = extractPort(hostname);
      const running = await isHealthy(extractHost(hostname), port);
      const owned = await ownedPid();
      const manualStop = await bb.storage.kv.get<{ port: number }>(MANUAL_STOP_KEY);
      return {
        running,
        autoStart,
        spawned: owned !== null,
        stopped: manualStop?.port === port,
        pid: owned,
        viewBaseUrl:
          proxyPort !== null ? `http://127.0.0.1:${proxyPort}` : null,
        error: baguetteError,
      };
    },

    async startBaguette() {
      const { hostname } = await settings.get();
      const port = extractPort(hostname);
      const bindHost = extractHost(hostname);
      await bb.storage.kv.delete(MANUAL_STOP_KEY);
      if (await isHealthy(bindHost, port)) {
        return { ok: true, message: "Baguette is already running." };
      }
      const failed = await spawnBaguette(port, bindHost);
      return failed === null
        ? { ok: true, message: "Starting baguette…" }
        : { ok: false, message: `Could not start baguette: ${failed}` };
    },

    async stopBaguette() {
      const { hostname } = await settings.get();
      const port = extractPort(hostname);
      const target = await ownedPid();

      // Shutdown booted simulators first — frees the per-sim ~1-4 GB (slim simulators included).
      // Slim overrides are persistent, so a later boot stays slim.
      const sims = await shutdownBootedSimulators();
      const simMsg = sims.shutdown > 0 ? ` Shut down ${sims.shutdown} simulator${sims.shutdown === 1 ? "" : "s"}.` : "";
      const simErr = sims.errors.length ? ` (${sims.errors.slice(0, 2).join("; ")})` : "";

      if (target !== null) {
        const dead = await killBaguettePid(target);
        baguette = null;
        await clearOwnership();
        await bb.storage.kv.set(MANUAL_STOP_KEY, { port });
        if (!dead) {
          return { ok: false, message: "Could not stop baguette." + simMsg };
        }
        publishStatus(false);
        return { ok: true, message: `Stopped baguette.${simMsg}${simErr}` };
      }

      // Not owned by us — stop any baguette process listening on the port.
      const listeners = await resolveListenerPids(port);
      const targets: number[] = [];
      for (const listener of listeners) {
        if (await isBaguetteCommand(listener)) targets.push(listener);
      }
      if (targets.length === 0) {
        return {
          ok: false,
          message: sims.shutdown > 0 ? `Baguette is not running.${simMsg}` : "Baguette is not running.",
        };
      }
      for (const listener of targets) {
        await killBaguettePid(listener);
      }
      await bb.storage.kv.set(MANUAL_STOP_KEY, { port });
      publishStatus(false);
      return { ok: true, message: `Stopped baguette.${simMsg}${simErr}` };
    },

    // ---- SimSlim ----

    async getSimSlimStatus() {
      const v = await simSlimVersion();
      let managedTotal: number | null = null;
      if (v.installed) {
        try {
          const { stdout } = await execSimSlim(["profiles", "--json"], 5000);
          const parsed = JSON.parse(stdout) as any[];
          // managedTotal is deduped union; approximate as sum unique labels length
          // but simslim's list --json gives managedTotal per device, so just take first profile set size alternative
          // Use 170 fallback: count unique labels across all categories
          const labels = new Set<string>();
          for (const p of parsed) for (const l of (p.labels ?? [])) labels.add(l);
          managedTotal = labels.size || 170;
        } catch {
          managedTotal = 170;
        }
      }
      return { installed: v.installed, version: v.version, path: v.path, managedTotal, error: v.error };
    },

    async getSimSlimFleet() {
      try {
        const { stdout } = await execSimSlim(["top", "--json"], 8000);
        const parsed = JSON.parse(stdout) as { sims: any[] | null; totalBytes: number };
        return { sims: parsed.sims ?? [], totalBytes: parsed.totalBytes ?? 0, error: null };
      } catch (e: any) {
        const msg = String(e?.output ?? e?.message ?? e).slice(0, 500);
        if (/no such file|not found|ENOENT/i.test(msg)) return { sims: [], totalBytes: 0, error: "simslim not installed" };
        return { sims: [], totalBytes: 0, error: msg };
      }
    },

    async getSimSlimProfiles() {
      try {
        const { stdout } = await execSimSlim(["profiles", "--json"], 5000);
        const parsed = JSON.parse(stdout) as any[];
        return {
          profiles: parsed.map((p) => ({
            id: String(p.id),
            name: String(p.name),
            description: String(p.description ?? ""),
            downside: p.downside ? String(p.downside) : undefined,
            approxMemoryMB: typeof p.approxMemoryMB === "number" ? p.approxMemoryMB : undefined,
            labels: Array.isArray(p.labels) ? p.labels.map(String) : [],
          })),
          error: null,
        };
      } catch (e: any) {
        return { profiles: [], error: String(e?.output ?? e?.message ?? e).slice(0, 400) };
      }
    },

    async getSimSlimSimulatorInfo({ udid }) {
      // Must be booted to read launchd overrides + memory
      try {
        // status + measure in parallel (status gives verdict/managedDisabled, measure gives memory)
        const [statusRes, measureRes] = await Promise.allSettled([
          execSimSlim(["status", udid, "--json"], 8000),
          execSimSlim(["measure", udid, "--json"], 8000),
        ]);
        let managedDisabled: number | null = null;
        let managedTotal: number | null = null;
        let verdict: string | null = null;
        let memory: { processes: number; bytes: number; cpu: number } | null = null;
        let memoryError: string | null = null;
        let booted = true;
        let error: string | null = null;

        if (statusRes.status === "fulfilled") {
          try {
            const s = JSON.parse(statusRes.value.stdout);
            managedDisabled = typeof s.managedDisabled === "number" ? s.managedDisabled : null;
            managedTotal = typeof s.managedTotal === "number" ? s.managedTotal : null;
            verdict = typeof s.verdict === "string" ? s.verdict : null;
          } catch {}
        } else {
          const msg = String((statusRes.reason as any)?.output ?? (statusRes.reason as any)?.message ?? "");
          if (/must be booted|does not appear to be booted|Shutdown/i.test(msg)) {
            booted = false;
            error = null; // not an error, just shutdown
          } else error = msg.slice(0, 300);
        }

        if (measureRes.status === "fulfilled") {
          try {
            const m = JSON.parse(measureRes.value.stdout);
            if (typeof m.bytes === "number") memory = { processes: m.processes ?? 0, bytes: m.bytes, cpu: m.cpu ?? 0 };
          } catch {}
        } else {
          const msg = String((measureRes.reason as any)?.output ?? (measureRes.reason as any)?.message ?? "");
          if (/must be booted|does not appear to be booted/i.test(msg)) {
            booted = false;
          } else memoryError = msg.slice(0, 300);
        }

        return { udid, booted, managedDisabled, managedTotal, verdict, memory, memoryError, error };
      } catch (e: any) {
        return { udid, booted: false, managedDisabled: null, managedTotal: null, verdict: null, memory: null, memoryError: null, error: String(e?.message ?? e).slice(0, 300) };
      }
    },

    async runSlimOn({ udid, except, keep, preserveBootState }) {
      const args = ["on", udid];
      if (except && except.trim().length) args.push("--except", except.trim());
      if (keep && keep.trim().length) args.push("--keep", keep.trim());
      if (preserveBootState) args.push("--preserve-boot-state");
      try {
        // Slimming boots + ~170 launchctl calls + reboot → up to 10m default
        await execSimSlim(args, 15 * 60_000);
        return { ok: true, message: `Slimmed ${udid}` };
      } catch (e: any) {
        const out = String(e?.output ?? e?.stderr ?? e?.stdout ?? e?.message ?? e).slice(0, 800);
        return { ok: false, message: out || "Slim failed" };
      }
    },

    async runSlimOff({ udid, preserveBootState }) {
      const args = ["off", udid];
      if (preserveBootState) args.push("--preserve-boot-state");
      try {
        await execSimSlim(args, 15 * 60_000);
        return { ok: true, message: `Restored ${udid} to stock` };
      } catch (e: any) {
        const out = String(e?.output ?? e?.stderr ?? e?.stdout ?? e?.message ?? e).slice(0, 800);
        return { ok: false, message: out || "Restore failed" };
      }
    },
  });

  bb.onDispose(async () => {
    const childPid = baguette?.pid;
    if (childPid !== undefined && isAlive(childPid)) {
      await killBaguettePid(childPid);
    }
    baguette = null;
    const owner = await bb.storage.kv.get<BaguetteOwner>(OWNER_KEY);
    if (owner && owner.pid !== childPid && isAlive(owner.pid)) {
      await killBaguettePid(owner.pid);
    }
    await clearOwnership();
    if (proxyServer !== null) {
      proxyServer.close();
      proxyServer = null;
      proxyPort = null;
    }
  });
}

interface SimulatorDto {
  name: string;
  runtime: string;
  state: string;
  udid: string;
}
