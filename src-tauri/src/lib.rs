mod connection;
mod error;
mod files;
mod http;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(connection::AppState::new())
        .invoke_handler(tauri::generate_handler![
            connection::connect,
            connection::get_connection,
            connection::disconnect,
            http::assets_request,
            files::save_pdf,
            files::open_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
