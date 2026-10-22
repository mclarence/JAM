use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::connection::{AppState, AuthType, ConnectionInfo, StoredConnection};
use crate::error::{AppError, AppResult};
use crate::{crypto, files};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    path: String,
    /// Settings document built by the frontend (never contains credentials).
    settings: String,
    include_connection: bool,
    passphrase: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPreview {
    site_url: String,
    auth_type: AuthType,
    email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// Settings JSON with any connection data stripped, so the token never reaches the webview.
    settings: String,
    encrypted: bool,
    connection: Option<ConnectionPreview>,
}

fn non_empty(p: Option<String>) -> Option<String> {
    p.filter(|s| !s.is_empty())
}

/// Writes settings to disk. API connection data is added here (the token lives only in Rust) and forces encryption.
#[tauri::command]
pub async fn export_settings(state: State<'_, AppState>, request: ExportRequest) -> AppResult<()> {
    let path = files::json_path(request.path)?;
    let passphrase = non_empty(request.passphrase);
    if request.include_connection && passphrase.is_none() {
        return Err(AppError::Invalid(
            "A passphrase is required when exporting API connection settings.".into(),
        ));
    }

    let mut doc: Value = serde_json::from_str(&request.settings)
        .map_err(|e| AppError::Invalid(format!("Invalid settings data: {e}")))?;
    let obj = doc
        .as_object_mut()
        .ok_or_else(|| AppError::Invalid("Invalid settings data".into()))?;
    obj.remove("connection");
    if request.include_connection {
        let conn = state.current()?;
        obj.insert(
            "connection".into(),
            serde_json::to_value(&conn).map_err(|e| AppError::Invalid(e.to_string()))?,
        );
    }
    let plaintext = serde_json::to_string_pretty(&doc).map_err(|e| AppError::Invalid(e.to_string()))?;

    let output = match passphrase {
        Some(pass) => tauri::async_runtime::spawn_blocking(move || crypto::encrypt(plaintext.as_bytes(), &pass))
            .await
            .map_err(|e| AppError::Invalid(e.to_string()))??,
        None => plaintext,
    };
    std::fs::write(path, output)?;
    Ok(())
}

struct Opened {
    doc: Value,
    encrypted: bool,
}

fn open_file(path: String, passphrase: Option<String>) -> AppResult<Opened> {
    let text = files::read_json_text(path)?;
    let raw: Value = serde_json::from_str(&text).map_err(|_| AppError::Invalid("The file is not valid JSON.".into()))?;
    if !crypto::is_envelope(&raw) {
        return Ok(Opened { doc: raw, encrypted: false });
    }
    let pass = non_empty(passphrase).ok_or(AppError::PassphraseRequired)?;
    let plain = crypto::decrypt(&raw, &pass)?;
    let doc = serde_json::from_slice(&plain)
        .map_err(|_| AppError::Invalid("The decrypted content is not valid settings data.".into()))?;
    Ok(Opened { doc, encrypted: true })
}

/// Connection data is only honoured when it came out of an encrypted file.
fn extract_connection(opened: &Opened) -> Option<StoredConnection> {
    if !opened.encrypted {
        return None;
    }
    let conn = serde_json::from_value::<StoredConnection>(opened.doc.get("connection")?.clone()).ok()?;
    conn.validate_imported().ok()
}

async fn open_blocking(path: String, passphrase: Option<String>) -> AppResult<Opened> {
    tauri::async_runtime::spawn_blocking(move || open_file(path, passphrase))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))?
}

/// Reads (and if needed decrypts) a settings file for the import dialog.
#[tauri::command]
pub async fn import_settings_read(path: String, passphrase: Option<String>) -> AppResult<ImportPreview> {
    let mut opened = open_blocking(path, passphrase).await?;
    let connection = extract_connection(&opened).map(|c| ConnectionPreview {
        site_url: c.site_url,
        auth_type: c.auth_type,
        email: c.email,
    });
    if let Some(o) = opened.doc.as_object_mut() {
        o.remove("connection");
    }
    Ok(ImportPreview {
        settings: opened.doc.to_string(),
        encrypted: opened.encrypted,
        connection,
    })
}

/// Replaces the stored API connection with the one from an encrypted settings file.
#[tauri::command]
pub async fn import_settings_connection(
    state: State<'_, AppState>,
    path: String,
    passphrase: Option<String>,
) -> AppResult<ConnectionInfo> {
    let opened = open_blocking(path, passphrase).await?;
    let conn = extract_connection(&opened)
        .ok_or_else(|| AppError::Invalid("The file does not contain a valid API connection.".into()))?;
    crate::connection::save_to_keyring(&conn)?;
    let info = conn.info();
    state.set(Some(conn));
    Ok(info)
}
