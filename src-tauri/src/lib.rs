mod backup;
mod connection;
mod crypto;
mod error;
mod files;
mod http;
mod proxy;

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
            proxy::get_network_options,
            proxy::set_network_options,
            proxy::proxy_sign_in_start,
            proxy::proxy_sign_in_finish,
            proxy::proxy_sign_in_cancel,
            files::save_pdf,
            backup::export_settings,
            backup::import_settings_read,
            backup::import_settings_connection,
            files::open_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
