import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";

type VideoReadTarget =
  | { kind: "raw"; url: string }
  | { kind: "workspace-json"; url: string };

interface EnvironmentFileResponse {
  content: string;
  contentEncoding: "base64" | "utf8";
  mimeType: string;
}

function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function queryUrl(path: string, values: Record<string, string>): string {
  return `${path}?${new URLSearchParams(values).toString()}`;
}

export function resolveVideoReadTarget(
  path: string,
  source: PluginFileOpenerSource,
): VideoReadTarget | null {
  switch (source.kind) {
    case "workspace":
      if (source.threadId !== null) {
        return {
          kind: "raw",
          url: `/api/v1/threads/${encodeURIComponent(source.threadId)}/worktree/files/${encodePathSegments(path)}`,
        };
      }
      if (source.environmentId !== null) {
        return {
          kind: "workspace-json",
          url: queryUrl(
            `/api/v1/environments/${encodeURIComponent(source.environmentId)}/diff/file`,
            { target: "uncommitted", path, side: "new" },
          ),
        };
      }
      if (source.projectId !== null) {
        return {
          kind: "raw",
          url: queryUrl(
            `/api/v1/projects/${encodeURIComponent(source.projectId)}/files/content`,
            {
              path,
              ...(source.experimental_hostId
                ? { hostId: source.experimental_hostId }
                : {}),
            },
          ),
        };
      }
      return null;
    case "host":
      return source.threadId === null
        ? null
        : {
            kind: "raw",
            url: queryUrl(
              `/api/v1/threads/${encodeURIComponent(source.threadId)}/host-files/content`,
              { path },
            ),
          };
    case "thread-storage":
      return source.threadId === null
        ? null
        : {
            kind: "raw",
            url: `/api/v1/threads/${encodeURIComponent(source.threadId)}/thread-storage/files/${encodePathSegments(path)}`,
          };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

const VIDEO_MIME_PREFIX = "video/";
const ALLOWED_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/x-matroska",
  "video/ogg",
]);

function isVideoMime(mime: string): boolean {
  const normalized = normalizeMimeType(mime);
  if (ALLOWED_VIDEO_MIMES.has(normalized)) return true;
  // Accept any video/* as fallback, but reject application/octet-stream etc.
  return normalized.startsWith(VIDEO_MIME_PREFIX);
}

function parseEnvironmentFileResponse(value: unknown): EnvironmentFileResponse {
  if (!isRecord(value)) {
    throw new Error("The workspace returned an invalid file response.");
  }
  const { content, contentEncoding, mimeType } = value;
  if (
    typeof content !== "string" ||
    (contentEncoding !== "base64" && contentEncoding !== "utf8") ||
    typeof mimeType !== "string"
  ) {
    throw new Error("The workspace returned an invalid file response.");
  }
  return { content, contentEncoding, mimeType };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function requireOk(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  return response;
}

export async function loadVideoBlob(
  target: VideoReadTarget,
  signal: AbortSignal,
): Promise<{ blob: Blob; mimeType: string }> {
  const response = await requireOk(
    await fetch(target.url, { credentials: "same-origin", signal }),
  );

  if (target.kind === "raw") {
    const contentType = response.headers.get("content-type") ?? "";
    // Be lenient: many servers return application/octet-stream for video files
    // Do not throw here, just pass through. Let <video> handle it.
    // But if it's clearly a video mime, preserve it.
    const mimeType = contentType ? normalizeMimeType(contentType) : "video/mp4";
    const blob = await response.blob();
    // Ensure blob has a video mime if upstream gave octet-stream
    if (blob.type === "" || blob.type === "application/octet-stream") {
      return { blob: new Blob([blob], { type: mimeType || "video/mp4" }), mimeType };
    }
    return { blob, mimeType: blob.type || mimeType };
  }

  const file = parseEnvironmentFileResponse(await response.json());
  const mimeType = normalizeMimeType(file.mimeType) || "video/mp4";
  const bytes =
    file.contentEncoding === "base64"
      ? decodeBase64(file.content)
      : new TextEncoder().encode(file.content);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  // Preserve original mime if it's video-ish, else default to mp4
  const blobType = isVideoMime(mimeType) ? mimeType : "video/mp4";
  return { blob: new Blob([buffer], { type: blobType }), mimeType: blobType };
}

export function mimeTypeForExtension(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
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
