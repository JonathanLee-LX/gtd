//! Desktop shell only: opens the production GTD web app in a native window.
//! No TaskService duplication, no second API base, no client-side `source`.
//!
//! Session cookies are set by Better Auth over HTTPS and stored by the OS
//! WebView jar (first-party same origin as `tauri.conf.json` URLs). No extra
//! cookie/storage capability or `dataDirectory` is configured — see
//! `docs/desktop.md`.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running GTD desktop");
}
