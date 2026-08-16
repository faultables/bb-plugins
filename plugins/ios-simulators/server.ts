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
  updateSettings: {
    input: z
      .object({
        hostname: z.string().min(1).optional(),
        autoStart: z.boolean().optional(),
        viewUrl: z.string().optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }).strict(),
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

    async updateSettings({ hostname, autoStart, viewUrl }) {
      const current = await settings.get();
      await bb.sdk.plugins.updateSettings({
        pluginId: bb.pluginId,
        values: {
          hostname: hostname ?? current.hostname,
          autoStart: autoStart ?? current.autoStart,
          viewUrl: viewUrl ?? current.viewUrl,
        },
      });
      return { ok: true };
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

      if (target !== null) {
        const dead = await killBaguettePid(target);
        baguette = null;
        await clearOwnership();
        await bb.storage.kv.set(MANUAL_STOP_KEY, { port });
        if (!dead) {
          return { ok: false, message: "Could not stop baguette." };
        }
        publishStatus(false);
        return { ok: true, message: "Stopped baguette." };
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
          message: "Baguette is not running.",
        };
      }
      for (const listener of targets) {
        await killBaguettePid(listener);
      }
      await bb.storage.kv.set(MANUAL_STOP_KEY, { port });
      publishStatus(false);
      return { ok: true, message: "Stopped baguette." };
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