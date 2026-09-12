//! Desktop shell only: opens the production GTD web app in a native window.
//! No TaskService duplication, no second API base, no client-side `source`.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running GTD desktop");
}
