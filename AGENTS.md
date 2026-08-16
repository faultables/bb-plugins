# Repository Guidelines

npm workspace monorepo for BB plugins. The root package (`faultables-bb-plugins`) registers plugins in `.bb/plugins.json`; each plugin lives under `plugins/<name>`.

## Project Structure & Module Organization

- `plugins/app-store-connect/` — App Store Connect plugin (currently the only workspace).
  - `server.ts` — backend entry and RPC contract (`defineRpcContract` + Zod).
  - `app.tsx` — frontend entry (`definePluginApp`).
  - `components/ui/` — owned shadcn/BB UI (edit freely; add more with `npx shadcn add @bb/<name>`).
  - `lib/`, `hooks/` — shared helpers and React hooks.
  - `skills/` — agent skill docs (`SKILL.md`).
  - `package.json` — plugin manifest (`bb.server`, `bb.app`, branding, engines).
- Root `package.json` workspaces: `plugins/*`. Do not commit `node_modules/`, `dist/`, or secrets.

## Build, Test, and Development Commands

Run plugin commands from the plugin directory (or pass the path):

```
npm install
bb plugin install .
bb plugin reload app-store-connect
bb plugin build
bb plugin types
bb plugin types --check
```

`install` / `reload` load the plugin into BB. `build` writes `dist/` (`server.js`, `app.js`, `app.css`, `*.meta.json`) for git/npm installs. `types` syncs `@get-bb/plugin-sdk` to the running BB; `--check` is the CI gate.

## Coding Style & Naming Conventions

TypeScript ESM, `strict`, JSX. Two-space indent. Path alias `@/*` (e.g. `@/components/ui/button`). Components PascalCase; hooks `useX`; RPC methods camelCase. Put runtime imports in `dependencies` (BB inlines them). Keep React, `@get-bb/plugin-sdk`, and BB-shimmed packages in `devDependencies` only.

## Testing Guidelines

No automated test runner yet. Before a PR, typecheck (`tsc` / `bb plugin types --check`) and smoke the plugin in BB (`reload`, then exercise the changed RPC/UI). Add tests next to the code they cover if you introduce a runner.

## Commit & Pull Request Guidelines

Commits follow Conventional Commits, e.g. `feat: add TestFlight test settings management`. Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`. PRs should say which plugin changed, how you verified it in BB, and note any `package.json` / engines / SDK pin updates. Do not commit App Store Connect credentials or built `dist/` unless a publish path explicitly requires artifacts.
