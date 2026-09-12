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

## Cookie / session（WebView）

Auth is the **same Better Auth cookie session** as the browser SPA. The desktop shell does **not** invent a second login path or mobile token.

### Why cookies work in this shell

| Fact | Implication |
| --- | --- |
| `devUrl` / `frontendDist` are the production **HTTPS** origin | WebView document origin = API origin (first-party) |
| Better Auth sets `SameSite=Lax`, `Secure` (HTTPS), `HttpOnly`, `Path=/` | First-party navigations and same-origin `fetch(..., { credentials: "include" })` send the session cookie |
| Default session lifetime | `session_token` max-age **7 days** (`expiresIn` default); renew on activity per Better Auth |
| Client API | `src/react-app/api.ts` always uses `credentials: "include"`; it never writes `source` on mutations |

`SameSite=None` is **not** required here: the shell is not a cross-site embed. Do **not** change auth cookies for desktop unless a real WebView smoke proves Lax+Secure unusable (then open a separate issue — mobile-token protocol is explicitly out of scope for Desktop v1).

### Tauri config: no extra cookie/storage knobs

No `tauri.conf.json` / capability change is required for cookie login:

- Server `Set-Cookie` is stored by the **OS WebView** cookie jar (WKWebView / WebView2 / WebKitGTK), not by Tauri IPC.
- We keep `withGlobalTauri: false` and **no** remote IPC — the SPA must not depend on injected Tauri APIs for auth.
- We do **not** set a custom `dataDirectory` / `useHttpsScheme` for this remote-URL shell; those knobs matter for custom-protocol (`tauri://` / localhost) apps and would only risk relocating storage. Persistence is the platform WebView default under the app data dir for identifier `dev.jonathanleelx.gtd`.

If a future build loads a **custom protocol** or a second origin, re-evaluate cookies (and likely fail closed into a dedicated auth issue).

### Session rules (what “still logged in” means)

- **In-window reload** (Cmd/Ctrl+R or location refresh): expect session cookie to remain; stay on `/today` (or redirect back after `/api/me`).
- **Quit app and reopen** within ~7 days: expect still logged in (OS WebView cookie jar persists).
- **After explicit sign-out**, or after session expiry / cleared WebView data: expect login page.
- **Incognito / cleared site data** in DevTools: expect login page (same as browser).

There is no automated desktop login test in CI (no production credentials in the agent/CI environment). Use the manual smoke below on a machine with the GUI WebView toolchain.

### Smoke checklist（手动）

Prereq: production account that can sign in on the web app; `pnpm desktop:dev` (or a local `desktop:build` package).

1. [ ] Open desktop shell → production login UI loads (URL bar / network shows `gtd.jonathanleelx.workers.dev`).
2. [ ] Sign in with the existing account → lands on **今日 / today**.
3. [ ] Complete **one** task on today (check → success feedback).
4. [ ] Soft refresh the WebView (reload) → still logged in; completed item stays completed (or reflects server state).
5. [ ] Optional: quit and relaunch the app → still logged in (documents OS cookie persistence).
6. [ ] Optional DevTools / network: login response `Set-Cookie` includes `Secure` and `SameSite=Lax` (name often `__Secure-better-auth.session_token`); subsequent `/api/*` requests include `Cookie`.
7. [ ] Confirm client never sends `source` in create/update bodies (server assigns `human` from the session). SPA already strips `source` in `task-cache` request helpers — do not add a desktop-only override.

**Pass criteria (issue #60):** steps 1–4 succeed; step 7 holds; no auth-protocol change.

**Fail → next step:** if Lax+Secure cookies are dropped by a specific OS WebView, capture OS + WebView version + `Set-Cookie` / request Cookie evidence and file a follow-up — do **not** silently switch to a mobile token in this shell.

## Design notes

- `frontendDist` and `devUrl` are both the production HTTPS URL so the shell never points at a second origin for business logic.
- `withGlobalTauri` is `false`; the SPA does not get injected Tauri globals.
- Do not add desktop-only API clients or rewrite `TaskService` here — keep the shell dumb.
