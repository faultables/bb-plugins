# faultables BB Plugins

A monorepo of [bb](https://getbb.app) plugins maintained by faultables. Each
plugin lives under `plugins/<name>` and is registered in `.bb/plugins.json`.

## Plugins

| Plugin | Description |
| --- | --- |
| [iOS Simulators](./plugins/ios-simulators/) | Browse, boot, and watch iOS simulators served by [baguette](https://github.com/tddworks/baguette) — with optional [SimSlim](https://github.com/mobai-app/simslim) slimming (~4× RAM). |
| [App Store Connect](./plugins/app-store-connect/) | List and browse your App Store Connect apps. |
| [OpenCode Go](./plugins/opencode-go/) | Track your OpenCode Go usage and limits. |
| [Video Preview](./plugins/video-preview/) | Preview video files (mp4, webm, mov) inline instead of downloading — file opener + inline Tasks/timeline attachments. |
| [Chief of Staff](./plugins/chief-of-staff/) | Delegates your backlog: one agent thread per item, routine questions answered, operator decisions escalated. |

## Requirements

- [bb](https://getbb.app) (0.38+)
- Node.js 20+ and npm
- [baguette](https://github.com/tddworks/baguette) (for iOS Simulators only)
- [SimSlim](https://github.com/mobai-app/simslim) (optional, for iOS Simulators — `brew install mobai-app/tap/simslim` for ~4× simulator RAM savings)
- [asc](https://github.com/rorkai/App-Store-Connect-CLI) (for App Store Connect)

## Installation

Install individual plugins from this repository:

```sh
# from a clone
bb plugin install git:https://github.com/faultables/bb-plugins.git --plugin ios-simulators
bb plugin install git:https://github.com/faultables/bb-plugins.git --plugin app-store-connect
bb plugin install git:https://github.com/faultables/bb-plugins.git --plugin video-preview
bb plugin install git:https://github.com/faultables/bb-plugins.git --plugin chief-of-staff

# or from a local checkout
bb plugin install path:. --plugin ios-simulators
```

## iOS Simulators

The plugin manages the [baguette](https://github.com/tddworks/baguette) simulator
server, with optional [SimSlim](https://github.com/mobai-app/simslim) integration:

- **Right panel** — from any thread, open the right panel → *Actions* →
  *iOS Simulators* for the simulator list. Running simulators can be opened
  inline (live stream), shut down, or booted; the active simulator view shows
  the device and its OS (e.g. `iPhone 13 (iOS 26.5)`).
- **Watchdog** — keeps baguette running in the background
  (`baguette serve --host <hostname> --port <port>`), with a manual
  Start/Stop control and a status banner in the panel. **Stop** also shuts
  down any booted simulators (including slimmed ones) to free RAM — slim
  overrides are persistent so the next boot stays slim.
- **Inline embedding over HTTPS** — baguette sends
  `Content-Security-Policy: frame-ancestors 'none'`, so the plugin serves its
  pages through a local reverse proxy that strips the header and tunnels the
  stream's WebSocket. When bb itself is served over HTTPS (e.g. behind a
  Cloudflare tunnel), point an HTTPS hostname at the proxy
  (`http://127.0.0.1:55865`) and set it as the *HTTPS view URL*; otherwise the
  panel falls back to opening the simulator in a new tab.
- **On-demand proxy** — the reverse proxy is not started at plugin load; it
  boots lazily on the first status/view call, binds a stable loopback port
  (reused across plugin reloads so ingress configs keep working), and shuts
  down with the plugin.
- **SimSlim** — when `simslim` is installed, the panel shows a fleet bar
  (`X booted · Y GB total · ~4× RAM per slim sim`), per-sim badges
  (`Slim 170/170` / `Stock 0/170` + RAM), and **Slim** / **Restore stock**
  actions (with `except: siri,search` / `keep: com.apple.apsd` options).
  `simslim on` disables ~170 background daemons and reboots slim (e.g.
  `176 procs · 2.6 GB` → `71 procs · 1.1 GB`). Fleet refreshes are
  event-driven — after any boot/shutdown/slim and on `baguette-status`
  changes, no polling.

### Settings

Configured under **Extensions → Plugins → iOS Simulators** or via
`bb plugin config ios-simulators set <key> <value>`:

- `hostname` — where the baguette simulator server listens
  (default `127.0.0.1:8421`); also drives the watchdog's bind host.
- `autoStart` — spawn `baguette serve` when it is not running (default `true`).
- `viewUrl` — optional HTTPS hostname that reaches the simulator server, for
  inline embedding when bb is served over HTTPS (e.g. `sim.example.com`).

## App Store Connect

Browse App Store Connect apps and their TestFlight builds, groups, and test
notes from a bb panel.

## OpenCode Go

Track your [OpenCode Go](https://opencode.ai/docs/go) subscription usage and
limits from bb or the terminal (`bb opencode-go usage`):

- **Sidebar** — the *OpenCode Go* nav panel (full detail) with a live
  `5h / 7d / 1m` usage summary on its sidebar row.
- **Threads** — the same panel via a thread's *Actions* menu.

Each surface shows the three usage windows — rolling 5 hours, weekly, and
monthly — as progress toward the dollar limits (defaults `$12` / `$30` /
`$60`), the limit status, and the reset time.

The API key resolves in order of: plugin setting `apiKey`, the
`OPENCODE_GO_API_KEY` env var, then the opencode CLI auth file
(`~/.local/share/opencode/auth.json`), so it works out of the box if you use
OpenCode Go with the opencode CLI.

### Settings

Configured under **Extensions → Plugins → OpenCode Go** or via
`bb plugin config opencode-go set <key> <value>`:

- `apiKey` — OpenCode Go API key (optional when the opencode CLI auth file
  exists).
- `rollingLimitDollars` / `weeklyLimitDollars` / `monthlyLimitDollars` —
  displayed dollar limits (defaults `12` / `30` / `60`).

## Agent Presets (Tasks)

Trackable `bb tasks` agent presets live in [`presets/tasks-presets.json`](./presets/tasks-presets.json) (git source of truth, `name` is the key). The `presets/sync.sh` helper keeps them in sync with the local `tasks` SQLite DB:

```sh
./presets/sync.sh export  # dump DB → JSON
./presets/sync.sh import  # upsert JSON → DB (by name, idempotent)
./presets/sync.sh diff    # show drift
```

Add a preset to the JSON, commit, and teammates run `import`; or run `export` after editing in the UI and commit the diff.

## Development

```sh
npm install                       # workspace deps (run at the repo root)
bb plugin install ./plugins/<name>   # register a plugin in bb

# per plugin (from its directory)
bb plugin build                   # writes dist/ (server.js, app.js, …)
bb plugin types --check           # CI gate: SDK declarations match the running bb
bb plugin reload <name>           # reload the plugin in a running bb
```

There is no automated test runner yet; verify with `tsc --noEmit` and smoke
the changed RPC/UI in bb (`reload`, then exercise the surface).
