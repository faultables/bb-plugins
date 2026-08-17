// bb-plugin-opencode-go — sidebar footer usage strip.
//
// Trusted content script: injects a compact OpenCode Go usage reading into
// BB's sidebar footer (the utility row next to Settings / bug report),
// mirroring the approach used by the usage-tracker plugin. Renders with plain
// DOM (no React root) so it survives host re-renders of the footer and never
// conflicts with bb's own React tree.
//
// The strip keeps the last successful snapshot in localStorage so values stay
// visible through temporary API failures, and re-mounts itself whenever the
// host rebuilds the footer menu (MutationObserver on the document).

const ROOT_ATTRIBUTE = "data-opencode-go-sidebar";
const CACHE_KEY = "bb:opencode-go:sidebar:last-known";
const AUTO_REFRESH_MS = 5 * 60_000;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

type UsageWindow = {
  status: string;
  percent: number;
  resetsAt: string;
};

type UsageSnapshot = {
  usage: {
    rolling: UsageWindow;
    weekly: UsageWindow;
    monthly: UsageWindow;
  } | null;
  limits: { rolling: number; weekly: number; monthly: number };
  source: "settings" | "env" | "auth-file";
  error: string | null;
};

interface RpcEnvelope {
  ok?: boolean;
  result?: UsageSnapshot;
  error?: { message?: string };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Lucide-style stroke SVG from path data (stroke = currentColor). */
function svgOutlined(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** The OpenCode logo as a filled tile: solid square with the brand's small
 * notch punched out in the surface color (favicon-style, legible at 16px). */
function logoGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 240 300");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const tile = document.createElementNS(SVG_NAMESPACE, "path");
  tile.setAttribute("d", "M240 300H0V0H240V300Z");
  tile.setAttribute("fill", "currentColor");
  const notch = document.createElementNS(SVG_NAMESPACE, "rect");
  notch.setAttribute("x", "72");
  notch.setAttribute("y", "90");
  notch.setAttribute("width", "96");
  notch.setAttribute("height", "48");
  notch.setAttribute("class", "opencode-go-sidebar__notch");
  svg.append(tile, notch);
  return svg;
}

function closeGlyph(): SVGSVGElement {
  return svgOutlined(["M7 7l10 10", "M17 7L7 17"]);
}

function formatUsedPercent(value: number): string {
  return String(Math.round(Number.isFinite(value) ? value : 0));
}

function formatResetTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return iso;
  if (ms <= 0) return "resets now";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function toneForPercent(percent: number): "ok" | "warn" | "high" {
  if (percent >= 90) return "high";
  if (percent >= 70) return "warn";
  return "ok";
}

function isValidSnapshot(value: unknown): value is UsageSnapshot {
  if (value === null || typeof value !== "object") return false;
  const snapshot = value as Partial<UsageSnapshot>;
  if (snapshot.usage === null || snapshot.usage === undefined) return true;
  const usage = snapshot.usage as Partial<UsageSnapshot["usage"]>;
  return (
    typeof usage?.rolling === "object" &&
    usage.rolling !== null &&
    typeof usage?.weekly === "object" &&
    usage.weekly !== null &&
    typeof usage?.monthly === "object" &&
    usage.monthly !== null
  );
}

function readCachedSnapshot(): UsageSnapshot | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    return isValidSnapshot(value) ? value : null;
  } catch {
    return null;
  }
}

function cacheSnapshot(snapshot: UsageSnapshot): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage is an optimization; the live strip still works without it.
  }
}

function progressRail(window: UsageWindow | null): HTMLSpanElement {
  const rail = element("span", "opencode-go-sidebar__rail");
  const fill = element("span", "opencode-go-sidebar__fill");
  const percent =
    window === null ? 0 : Math.max(0, Math.min(100, window.percent));
  fill.style.width = `${percent}%`;
  if (window !== null) fill.dataset.tone = toneForPercent(window.percent);
  if (window === null) rail.dataset.empty = "true";
  rail.append(fill);
  return rail;
}

function detailWindowRow(
  label: string,
  window: UsageWindow | null,
): HTMLDivElement {
  const row = element("div", "opencode-go-sidebar__window");
  const heading = element("div", "opencode-go-sidebar__window-heading");
  heading.append(
    element("span", undefined, label),
    element(
      "strong",
      undefined,
      window === null ? "—" : `${formatUsedPercent(window.percent)}%`,
    ),
  );
  row.append(heading, progressRail(window));
  row.append(
    element(
      "span",
      "opencode-go-sidebar__reset",
      window === null ? "No limit reported" : formatResetTime(window.resetsAt),
    ),
  );
  return row;
}

function detailsCard(
  snapshot: UsageSnapshot,
  onClose: () => void,
): HTMLDivElement {
  const card = element("div", "opencode-go-sidebar__details");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "OpenCode Go usage limits");

  const header = element("div", "opencode-go-sidebar__details-header");
  const identity = element("div", "opencode-go-sidebar__details-identity");
  const mark = element("span", "opencode-go-sidebar__details-mark");
  mark.append(logoGlyph());
  const title = element("div");
  title.append(
    element("strong", undefined, "OpenCode Go"),
    element(
      "span",
      undefined,
      snapshot.usage === null ? "No usage data" : "Subscription usage",
    ),
  );
  identity.append(mark, title);

  const close = element("button", "opencode-go-sidebar__close");
  close.type = "button";
  close.setAttribute("aria-label", "Close usage details");
  close.append(closeGlyph());
  close.addEventListener("click", onClose);
  header.append(identity, close);

  const windows = element("div", "opencode-go-sidebar__windows");
  const usage = snapshot.usage;
  windows.append(
    detailWindowRow("5h", usage?.rolling ?? null),
    detailWindowRow("Weekly", usage?.weekly ?? null),
    detailWindowRow("Monthly", usage?.monthly ?? null),
  );
  card.append(header, windows);

  if (usage === null) {
    const message =
      snapshot.error ??
      "No usage data yet — set an API key in plugin settings or sign in with the opencode CLI, then reopen this panel.";
    card.append(element("p", "opencode-go-sidebar__message", message));
  }

  return card;
}

function visibleSidebarFooterMenu(): HTMLElement | null {
  const footers = Array.from(
    document.querySelectorAll<HTMLElement>('[data-sidebar="footer"]'),
  );
  const footer =
    footers.find((candidate) => candidate.getClientRects().length > 0) ??
    footers[0] ??
    null;
  return footer?.querySelector<HTMLElement>('[data-sidebar="menu"]') ?? null;
}

export function mountSidebarUsageStrip(
  signal: AbortSignal,
  pluginId: string,
): () => void {
  let root: HTMLLIElement | null = null;
  let snapshot = readCachedSnapshot();
  let detailsOpen = false;
  let isLoading = false;
  let lastLoadedAt = 0;
  let requestController: AbortController | null = null;
  let ensureFrame: number | null = null;
  let detailsPortal: HTMLDivElement | null = null;
  let positionFrame: number | null = null;
  let disposed = false;

  const removeDetailsPortal = (): void => {
    detailsPortal?.remove();
    detailsPortal = null;
  };

  const positionDetails = (): void => {
    if (detailsPortal === null || root === null) return;
    const anchor = root.getBoundingClientRect();
    const card = detailsPortal.getBoundingClientRect();
    const edge = 8;
    const gap = 6;
    const left = Math.min(
      Math.max(edge, anchor.left + edge),
      Math.max(edge, window.innerWidth - card.width - edge),
    );
    const top = Math.max(edge, anchor.top - card.height - gap);
    detailsPortal.style.left = `${left}px`;
    detailsPortal.style.top = `${top}px`;
    detailsPortal.style.visibility = "visible";
  };

  const scheduleDetailsPosition = (): void => {
    if (positionFrame !== null || detailsPortal === null) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = null;
      positionDetails();
    });
  };

  const render = (): void => {
    removeDetailsPortal();
    if (root === null) return;
    const content: Node[] = [];

    if (detailsOpen) {
      detailsPortal = detailsCard(snapshot ?? {
        usage: null,
        limits: { rolling: 12, weekly: 30, monthly: 60 },
        source: "auth-file",
        error: null,
      }, () => {
        detailsOpen = false;
        render();
      });
      document.body.append(detailsPortal);
    }

    const strip = element("div", "opencode-go-sidebar__strip");
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", "OpenCode Go usage");

    const usage = snapshot?.usage ?? null;
    const primary = usage?.rolling ?? null;
    const summary =
      usage === null
        ? "—"
        : `${formatUsedPercent(usage.rolling.percent)}%/${formatUsedPercent(usage.weekly.percent)}%/${formatUsedPercent(usage.monthly.percent)}%`;

    const toggle = element("button", "opencode-go-sidebar__provider");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(detailsOpen));
    toggle.setAttribute(
      "aria-label",
      `OpenCode Go usage: ${summary}. Click for 5-hour, weekly and monthly details.`,
    );
    toggle.title = `OpenCode Go · ${summary} · Click for details`;

    const mark = element("span", "opencode-go-sidebar__mark");
    mark.append(logoGlyph());
    const reading = element(
      "span",
      "opencode-go-sidebar__reading",
      isLoading && usage === null ? "…" : summary,
    );
    if (primary !== null) reading.dataset.tone = toneForPercent(primary.percent);
    toggle.append(mark, reading);
    toggle.addEventListener("click", () => {
      detailsOpen = !detailsOpen;
      render();
    });
    strip.append(toggle);

    content.push(strip);
    root.replaceChildren(...content);
    scheduleDetailsPosition();
  };

  const ensureMounted = (): void => {
    if (disposed) return;
    const footerMenu = visibleSidebarFooterMenu();
    if (footerMenu === null) {
      root?.remove();
      root = null;
      removeDetailsPortal();
      return;
    }
    if (root !== null && root.parentElement === footerMenu) return;
    root?.remove();
    root = element("li", "opencode-go-sidebar");
    root.setAttribute(ROOT_ATTRIBUTE, "");
    root.setAttribute("data-sidebar", "menu-item");
    footerMenu.append(root);
    render();
  };

  const scheduleEnsureMounted = (): void => {
    if (ensureFrame !== null || disposed) return;
    ensureFrame = requestAnimationFrame(() => {
      ensureFrame = null;
      ensureMounted();
    });
  };

  const load = async (): Promise<void> => {
    if (isLoading || disposed) return;
    isLoading = true;
    render();
    requestController = new AbortController();
    const abortRequest = () => requestController?.abort();
    signal.addEventListener("abort", abortRequest, { once: true });

    try {
      const response = await fetch(
        `/api/v1/plugins/${pluginId}/rpc/getUsage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // getUsage takes a single z.null() input; JSON null is the body.
          body: JSON.stringify(null),
          credentials: "same-origin",
          signal: requestController.signal,
        },
      );
      const payload = (await response.json()) as RpcEnvelope;
      if (
        !response.ok ||
        payload === null ||
        typeof payload !== "object" ||
        payload.ok === false ||
        payload.result === undefined
      ) {
        throw new Error(
          payload?.error?.message ?? `Usage request failed (HTTP ${response.status})`,
        );
      }
      snapshot = payload.result;
      cacheSnapshot(snapshot);
      lastLoadedAt = Date.now();
    } catch {
      // Keep the last cached snapshot visible when a background refresh fails.
    } finally {
      signal.removeEventListener("abort", abortRequest);
      requestController = null;
      isLoading = false;
      render();
    }
  };

  const observer = new MutationObserver(scheduleEnsureMounted);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  ensureMounted();
  void load();

  const refreshInterval = window.setInterval(() => void load(), AUTO_REFRESH_MS);
  const refreshIfStale = (): void => {
    if (Date.now() - lastLoadedAt > 60_000) void load();
  };
  window.addEventListener("focus", refreshIfStale, { signal });
  window.addEventListener("resize", scheduleDetailsPosition, { signal });
  window.addEventListener("scroll", scheduleDetailsPosition, {
    signal,
    capture: true,
  });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) refreshIfStale();
    },
    { signal },
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (detailsOpen && event.target instanceof Node) {
        const insideRoot = root?.contains(event.target) ?? false;
        const insidePortal = detailsPortal?.contains(event.target) ?? false;
        if (insideRoot || insidePortal) return;
        detailsOpen = false;
        render();
      }
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && detailsOpen) {
        detailsOpen = false;
        render();
      }
    },
    { signal },
  );

  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    if (ensureFrame !== null) cancelAnimationFrame(ensureFrame);
    if (positionFrame !== null) cancelAnimationFrame(positionFrame);
    window.clearInterval(refreshInterval);
    requestController?.abort();
    removeDetailsPortal();
    root?.remove();
    root = null;
  };
}