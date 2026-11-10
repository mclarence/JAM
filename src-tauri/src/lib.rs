mod backup;
mod connection;
mod crypto;
mod error;
mod files;
mod google;
mod http;
mod proxy;
mod sync;
mod sync_crypto;
mod updater;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(connection::AppState::new())
        .manage(updater::UpdaterState::default())
        .manage(sync::SyncManager::default())
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
            files::save_csv,
            backup::export_settings,
            backup::import_settings_read,
            backup::import_settings_connection,
            files::open_pdf,
            updater::check_update,
            updater::download_update,
            updater::install_update,
            sync::sync_get_status,
            sync::sync_sign_in,
            sync::sync_sign_in_cancel,
            sync::sync_disconnect,
            sync::sync_list_vaults,
            sync::sync_create_vault,
            sync::sync_unlock_vault,
            sync::sync_reset,
            sync::sync_pull,
            sync::sync_push,
            sync::sync_state_load,
            sync::sync_state_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
