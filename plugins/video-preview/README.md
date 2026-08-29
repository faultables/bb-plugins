# bb-plugin-video-preview

A BB plugin that renders video files (mp4 etc.) inline instead of downloading them.

It registers a `fileOpener` for common video extensions — `mp4`, `m4v`, `mov`, `webm`, `mkv`, `ogv` — and renders them with a native `<video>` element (controls, PiP, download fallback). The original BB download/preview is still available via `Original` fallback when the source cannot be resolved.

## How it works

- `server.ts` — minimal backend (no RPC needed; just a placeholder `plugin` factory).
- `app.tsx` — frontend file opener that:
  1. resolves the file URL for all workspace / host / thread-storage sources (same logic as the built-in PDF preview)
  2. fetches the file as a Blob with `credentials: same-origin` so auth cookies are sent
  3. creates an object URL and renders `<video src={url} controls playsInline>`
  4. handles loading / error / retry states and offers a Download fallback
- `video-source.ts` — helpers `resolveVideoReadTarget` and `loadVideoBlob` (handles both `raw` blob routes and the `workspace-json` environment diff route which returns base64).

## Install

```sh
cd bb-plugin-video-preview
npm install
bb plugin install .
# or for dev loop:
bb plugin dev
```

After editing sources:

```sh
bb plugin reload video-preview
```

## Manifest

`package.json` → `bb` field:

- `bb.name` / `bb.description` — human identity
- `bb.branding.icon` — `Video`
- `bb.server` / `bb.app` — entries
- `engines.bb` / `engines.bbPluginSdk` — version floors

No settings, no CLI, no storage — the plugin is purely a viewer. Add settings later with `bb.settings.define` if you want to toggle extensions or autoplay.
