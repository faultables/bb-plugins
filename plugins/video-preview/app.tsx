import { useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import {
  loadVideoBlob,
  mimeTypeForExtension,
  resolveVideoReadTarget,
} from "./video-source.js";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; url: string; mimeType: string }
  | { status: "error"; message: string };

function VideoFileOpener({ path, source, Original }: PluginFileOpenerProps) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const videoRef = useRef<HTMLVideoElement>(null);

  const target = useMemo(
    () => resolveVideoReadTarget(path, source),
    [path, source.environmentId, source.kind, source.projectId, source.threadId],
  );

  useEffect(() => {
    if (target === null) return;

    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: "loading" });

    void loadVideoBlob(target, controller.signal)
      .then(({ blob, mimeType }) => {
        if (controller.signal.aborted) return;
        // Use guessed mime as fallback if blob type is empty
        const effectiveMime = blob.type || mimeType || mimeTypeForExtension(path);
        const typedBlob = blob.type ? blob : new Blob([blob], { type: effectiveMime });
        objectUrl = URL.createObjectURL(typedBlob);
        setState({ status: "ready", url: objectUrl, mimeType: effectiveMime });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [reloadNonce, target, path]);

  if (target === null) return <Original />;

  if (state.status === "error") {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center" role="alert">
          <p className="text-sm text-destructive">
            Failed to load video: {state.message}
          </p>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => setReloadNonce((c) => c + 1)}
            >
              Retry
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md bg-secondary px-3 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
              onClick={() => {
                // Fallback to original (download) behavior
                window.location.href = target.url;
              }}
            >
              Download instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
        aria-label={`Loading ${path}`}
      >
        <span className="size-4 animate-spin rounded-full border-2 border-border border-t-foreground" />
        Loading video…
      </div>
    );
  }

  const fileName = path.split("/").pop() ?? path;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Video container - centers and constrains video */}
      <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-950 p-4">
        <video
          ref={videoRef}
          src={state.url}
          controls
          playsInline
          preload="metadata"
          className="max-h-full max-w-full rounded-md bg-black shadow-lg outline-none"
          style={{ maxHeight: "100%", maxWidth: "100%" }}
          onError={() => {
            const el = videoRef.current;
            const msg = el?.error
              ? `Media error code ${el.error.code}: ${el.error.message || "failed to decode"}`
              : "The browser could not play this video.";
            setState({ status: "error", message: msg });
          }}
        >
          <source src={state.url} type={state.mimeType} />
          Your browser does not support the video tag.
        </video>
      </div>

      {/* Footer bar with filename and actions */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <span className="truncate font-mono" title={path}>
          {fileName}
        </span>
        <div className="flex items-center gap-1.5">
          <a
            href={state.url}
            download={fileName}
            className="inline-flex h-7 items-center justify-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
          >
            Download
          </a>
          <button
            type="button"
            className="inline-flex h-7 items-center justify-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
              } else if (v.requestPictureInPicture) {
                v.requestPictureInPicture().catch(() => {});
              }
            }}
          >
            PiP
          </button>
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "video",
    title: "Video player",
    extensions: ["mp4", "m4v", "mov", "webm", "mkv", "ogv"],
    component: VideoFileOpener,
  });

  // Inline attachment previews — project attachments (ConversationAttachments)
  // and Tasks attachments (AttachmentsGrid) are otherwise rendered as download
  // pills. This content script upgrades video pills to inline <video> so mp4
  // plays instead of downloading.
  app.contentScripts.register({
    id: "video-attachments",
    mount({ signal }) {
      const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|wmv|mpeg|mpg|3gp|3g2)$/i;
      const objectUrls: string[] = [];

      function mimeForFileName(name: string): string {
        const ext = name.split(".").pop()?.toLowerCase() ?? "";
        switch (ext) {
          case "mp4":
          case "m4v":
            return "video/mp4";
          case "webm":
            return "video/webm";
          case "mov":
            return "video/quicktime";
          case "mkv":
            return "video/x-matroska";
          case "ogv":
          case "ogg":
            return "video/ogg";
          default:
            return "video/mp4";
        }
      }

      function isVideoFileName(name: string): boolean {
        return VIDEO_RE.test(name.trim());
      }

      function isVideoHref(href: string, label: string, downloadAttr: string | null): boolean {
        const candidates = [label, downloadAttr ?? ""];
        try {
          const url = new URL(href, location.href);
          const pathParam = url.searchParams.get("path");
          if (pathParam) candidates.push(pathParam);
        } catch {
          // ignore
        }
        return candidates.some((c) => VIDEO_RE.test(c.trim()));
      }

      function getLabel(link: HTMLAnchorElement): string {
        return (
          link.getAttribute("download")?.trim() ||
          link.textContent?.trim() ||
          "video"
        );
      }

      function hasVideoKey(key: string): boolean {
        return Array.from(document.querySelectorAll("[data-bb-video-key]")).some(
          (el) => el.getAttribute("data-bb-video-key") === key,
        );
      }

      function ensureVideoSection(
        attachmentsRoot: HTMLElement,
        before: HTMLElement,
        sectionClass: string,
      ): HTMLDivElement {
        let section = attachmentsRoot.querySelector(
          `:scope > .${sectionClass}`,
        ) as HTMLDivElement | null;
        if (!section) {
          section = document.createElement("div");
          section.className = `${sectionClass} flex flex-wrap gap-2`;
          attachmentsRoot.insertBefore(section, before);
        }
        return section;
      }

      function createCaption(label: string, href: string, downloadName: string | null): HTMLDivElement {
        const caption = document.createElement("div");
        caption.className =
          "flex items-center justify-between gap-2 px-2 py-1 text-xs text-white/70 bg-zinc-900";
        const name = document.createElement("span");
        name.className = "truncate font-mono";
        name.textContent = label;
        name.title = label;
        caption.appendChild(name);
        const dl = document.createElement("a");
        dl.href = href;
        dl.target = "_blank";
        dl.rel = "noreferrer";
        dl.textContent = "Download";
        if (downloadName) dl.download = downloadName;
        dl.className = "shrink-0 underline hover:text-white";
        caption.appendChild(dl);
        return caption;
      }

      function processProjectLink(link: HTMLAnchorElement) {
        if (link.dataset.bbVideoHandled === "1") return;
        const label = getLabel(link);
        if (!link.href.includes("/attachments/content")) return;
        if (!isVideoHref(link.href, label, link.getAttribute("download"))) return;
        if (!isVideoFileName(label) && !VIDEO_RE.test(new URL(link.href, location.href).searchParams.get("path") ?? "")) return;
        // Dedup by project attachment path
        let projectKey: string | null = null;
        try {
          projectKey = new URL(link.href, location.href).searchParams.get("path");
        } catch {}
        const dedupKey = projectKey ? `proj:${projectKey}` : `href:${link.href}`;
        if (hasVideoKey(dedupKey)) return;
        link.dataset.bbVideoHandled = "1";
        const filePathsContainer = link.parentElement;
        if (!filePathsContainer) return;
        const attachmentsRoot = filePathsContainer.parentElement as HTMLElement | null;
        if (!attachmentsRoot) return;
        const videoSection = ensureVideoSection(
          attachmentsRoot,
          filePathsContainer,
          "bb-video-attachments-section",
        );
        const item = document.createElement("div");
        item.dataset.bbVideoKey = dedupKey;
        item.className = "group relative overflow-hidden rounded-lg border bg-black";
        item.style.maxWidth = "380px";
        item.style.width = "100%";
        const video = document.createElement("video");
        video.src = link.href;
        video.controls = true;
        video.preload = "metadata";
        video.playsInline = true;
        video.className = "block w-full bg-black";
        video.style.maxHeight = "260px";
        video.style.width = "100%";
        video.title = label;
        video.addEventListener("error", () => {
          item.title = "Failed to load video — use download.";
          video.style.display = "none";
          const fallback = document.createElement("div");
          fallback.className = "p-2 text-xs text-white/80";
          fallback.textContent = `Failed to preview ${label}`;
          item.appendChild(fallback);
        });
        item.appendChild(video);
        item.appendChild(createCaption(label, link.href, label));
        videoSection.appendChild(item);
        link.style.opacity = "0.45";
        link.title = "Preview shown above — click to download";
      }

      function processTaskLink(link: HTMLAnchorElement) {
        if (link.dataset.bbVideoHandled === "1") return;
        if (!link.href.includes("/plugins/tasks/http/attachments/download")) return;
        const label = getLabel(link);
        if (!isVideoFileName(label)) return;
        // Dedup by attachmentId
        let attachmentId: string | null = null;
        try {
          attachmentId = new URL(link.href, location.href).searchParams.get("attachmentId");
        } catch {}
        const dedupKey = attachmentId ? `tasks:${attachmentId}` : `href:${link.href}`;
        if (hasVideoKey(dedupKey)) return;
        link.dataset.bbVideoHandled = "1";
        // fileCard is the outer div.flex... containing the anchor
        const fileCard = link.closest("div.flex") as HTMLElement | null;
        const filesContainer = fileCard?.parentElement as HTMLElement | null;
        // fallback to parent of link if structure differs
        const container = filesContainer ?? (link.parentElement as HTMLElement | null);
        if (!container) return;
        // Ensure a tasks video section at top of the files container
        let videoSection = container.querySelector(
          ":scope > .bb-tasks-video-section",
        ) as HTMLDivElement | null;
        // If container is the fileCard itself (unlikely), use its parent
        const sectionParent = filesContainer ? filesContainer : container;
        // For Tasks grid, the files container is the flex-wrap; we insert before first fileCard
        const anchorBefore = filesContainer ? (filesContainer.firstElementChild as HTMLElement | null) : null;
        if (!videoSection) {
          videoSection = document.createElement("div");
          videoSection.className = "bb-tasks-video-section flex flex-wrap gap-2 w-full mb-2";
          if (anchorBefore && sectionParent.contains(anchorBefore)) {
            sectionParent.insertBefore(videoSection, anchorBefore);
          } else {
            // If we cannot find a good anchor, prepend to container's parent (the AttachmentsGrid)
            const grid = container.closest("div.flex.flex-col") as HTMLElement | null;
            if (grid) {
              grid.prepend(videoSection);
            } else {
              sectionParent.prepend(videoSection);
            }
          }
        }
        const item = document.createElement("div");
        item.dataset.bbVideoKey = dedupKey;
        item.className = "group relative overflow-hidden rounded-lg border bg-black";
        item.style.maxWidth = "480px";
        item.style.width = "100%";
        const placeholder = document.createElement("div");
        placeholder.className = "flex items-center justify-center p-4 text-xs text-white/70";
        placeholder.textContent = `Loading ${label}…`;
        item.appendChild(placeholder);
        videoSection.appendChild(item);
        link.style.opacity = "0.4";
        link.title = "Preview loading above — click to download";
        // Fetch via blob to bypass Content-Disposition: attachment (and to get correct mime)
        // Use same-origin; tasks download is local-auth, no token needed.
        fetch(link.href, { credentials: "same-origin" })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.blob();
          })
          .then((blob) => {
            const mime = blob.type || mimeForFileName(label);
            const typed = blob.type ? blob : new Blob([blob], { type: mime });
            const url = URL.createObjectURL(typed);
            objectUrls.push(url);
            placeholder.remove();
            const video = document.createElement("video");
            video.src = url;
            video.controls = true;
            video.preload = "metadata";
            video.playsInline = true;
            video.className = "block w-full bg-black";
            video.style.maxHeight = "360px";
            video.title = label;
            video.addEventListener("error", () => {
              item.title = "Failed to load video — use download.";
            });
            item.prepend(video);
            item.appendChild(createCaption(label, link.href, label));
            link.title = "Preview shown above — click to download";
          })
          .catch((err) => {
            placeholder.textContent = `Failed to preview ${label}: ${err instanceof Error ? err.message : String(err)}`;
          });
      }

      function scan(root: ParentNode) {
        Array.from(
          root.querySelectorAll<HTMLAnchorElement>('a[href*="/attachments/content"]'),
        ).forEach((link) => processProjectLink(link));
        Array.from(
          root.querySelectorAll<HTMLAnchorElement>(
            'a[href*="/plugins/tasks/http/attachments/download"]',
          ),
        ).forEach((link) => processTaskLink(link));
      }

      scan(document);

      const observer = new MutationObserver((mutations) => {
        Array.from(mutations).forEach((m) => {
          Array.from(m.addedNodes).forEach((node) => {
            if (node instanceof HTMLElement) {
              if (node.matches('a[href*="/attachments/content"]')) {
                processProjectLink(node as HTMLAnchorElement);
              }
              if (node.matches('a[href*="/plugins/tasks/http/attachments/download"]')) {
                processTaskLink(node as HTMLAnchorElement);
              }
              scan(node);
            }
          });
        });
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      const onSignal = () => {
        observer.disconnect();
        Array.from(document.querySelectorAll(".bb-video-attachments-section, .bb-tasks-video-section")).forEach(
          (el) => el.remove(),
        );
        Array.from(
          document.querySelectorAll<HTMLAnchorElement>("a[data-bb-video-handled]"),
        ).forEach((a) => {
          delete a.dataset.bbVideoHandled;
          a.style.opacity = "";
          a.removeAttribute("title");
        });
        objectUrls.forEach((u) => URL.revokeObjectURL(u));
      };
      signal.addEventListener("abort", onSignal, { once: true });
      return () => {
        observer.disconnect();
        signal.removeEventListener("abort", onSignal);
        onSignal();
      };
    },
  });
});
