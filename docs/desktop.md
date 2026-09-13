# Desktop shell（Tauri）

Desktop v1 is a **thin native window** that loads the **production** GTD web app at the same origin:

`https://gtd.jonathanleelx.workers.dev`

There is no second API base URL, no duplicated `TaskService`, and the client must not set `source` (unchanged — server still sets `human` for the web session).

Non-goals for this scaffold: store listing, deep links, push, offline, Capacitor.

## Prerequisites

- Node 22+ and pnpm (same as the web app)
- [Rust toolchain](https://rustup.rs/) (stable; **1.88+** recommended for current Tauri 2 crates)
- Tauri system deps for your OS: [Prerequisites](https://v2.tauri.app/start/prerequisites/)
  - **macOS**: Xcode CLT
  - **Windows**: WebView2 (usually present) + MSVC build tools
  - **Linux**: `webkit2gtk` / `libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `patchelf`, GTK 3, etc. (see Tauri docs)

This repository commits the `src-tauri/` scaffold; you do not need to run `create-tauri-app` again.

## Install

From the repo root:

```sh
pnpm install
```

That pulls `@tauri-apps/cli` (devDependency). Rust crates download on first `desktop:dev` / `desktop:build`.

## Dev（打开现网）

```sh
pnpm desktop:dev
```

Opens a native window pointed at production (`build.devUrl` / `frontendDist` in `src-tauri/tauri.conf.json`). Log in with your production account as usual.

There is **no** local Vite/Worker process for the desktop shell — the window is the live site.

## Build / package

```sh
pnpm desktop:build
```

Artifacts land under `src-tauri/target/release/bundle/` (platform-specific: `.dmg` / `.msi` / `.AppImage` / etc.).

Full `tauri build` needs the OS GUI webview toolchain above. CI for this repo currently only runs `pnpm test` + `tsc -b` for the Workers/SPA app; desktop packaging is local / optional.

## Layout

| Path | Role |
| --- | --- |
| `src-tauri/` | Tauri 2 Rust shell |
| `src-tauri/tauri.conf.json` | Window + production URL |
| `src-tauri/src/` | Minimal `run()` — no business commands |
| `src-tauri/capabilities/default.json` | `core:default` only; **no** remote IPC grant |

## Design notes

- `frontendDist` and `devUrl` are both the production HTTPS URL so the shell never points at a second origin for business logic.
- `withGlobalTauri` is `false`; the SPA does not get injected Tauri globals.
- Do not add desktop-only API clients or rewrite `TaskService` here — keep the shell dumb.
