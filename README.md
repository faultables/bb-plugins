# faultables BB Plugins

A monorepo of [bb](https://getbb.app) plugins maintained by faultables. Each
plugin lives under `plugins/<name>` and is registered in `.bb/plugins.json`.

## Plugins

| Plugin | Description |
| --- | --- |
| [iOS Simulators](./plugins/ios-simulators/) | Browse, boot, and watch iOS simulators served by [baguette](https://github.com/tddworks/baguette). |
| [App Store Connect](./plugins/app-store-connect/) | List and browse your App Store Connect apps. |
| [OpenCode Go](./plugins/opencode-go/) | Track your OpenCode Go usage and limits. |

## Requirements

- [bb](https://getbb.app) (0.38+)
- Node.js 20+ and npm
- [baguette](https://github.com/tddworks/baguette) (for iOS Simulators only)
- [asc](https://github.com/rorkai/App-Store-Connect-CLI) (for App Store Connect)

## Installation

Install individual plugins from this repository:

```sh
# from a clone
bb plugin install git:https://github.com/faultables/bb-plugins.git --plugin ios-simulators
bb plugin install git:https://github.com/faultables/bb-plugins.git --plugin app-store-connect

# or from a local checkout
bb plugin install path:. --plugin ios-simulators
```

## iOS Simulators

The plugin manages the [baguette](https://github.com/tddworks/baguette) simulator
server:

- **Right panel** — from any thread, open the right panel → *Actions* →
  *iOS Simulators* for the simulator list. Running simulators can be opened
  inline (live stream), shut down, or booted; the active simulator view shows
  the device and its OS (e.g. `iPhone 13 (iOS 26.5)`).
- **Watchdog** — keeps baguette running in the background
  (`baguette serve --host <hostname> --port <port>`), with a manual
  Start/Stop control and a status banner in the panel.
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
