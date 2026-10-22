use std::path::PathBuf;

use base64::Engine;

use crate::error::{AppError, AppResult};

fn decode(data_b64: &str) -> AppResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| AppError::Invalid(format!("Invalid PDF data: {e}")))
}

fn sanitize_file_name(name: &str) -> String {
    let stem: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    let stem = if stem.is_empty() { "labels".to_string() } else { stem };
    format!("{stem}.pdf")
}

/// Writes a PDF to a user-chosen path (from the save dialog).
#[tauri::command]
pub fn save_pdf(path: String, data_b64: String) -> AppResult<()> {
    let path = PathBuf::from(path);
    let is_pdf = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Err(AppError::Invalid("Only .pdf files can be written".into()));
    }
    std::fs::write(&path, decode(&data_b64)?)?;
    Ok(())
}

const MAX_JSON_BYTES: u64 = 5 * 1024 * 1024;

pub(crate) fn json_path(path: String) -> AppResult<PathBuf> {
    let path = PathBuf::from(path);
    let is_json = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if is_json {
        Ok(path)
    } else {
        Err(AppError::Invalid("Only .json files can be used here".into()))
    }
}

/// Reads a settings export from a user-chosen path (from the open dialog).
pub(crate) fn read_json_text(path: String) -> AppResult<String> {
    let path = json_path(path)?;
    if std::fs::metadata(&path)?.len() > MAX_JSON_BYTES {
        return Err(AppError::Invalid("File is too large to be a settings export".into()));
    }
    Ok(std::fs::read_to_string(&path)?)
}

/// Writes a PDF to the temp folder and opens it in the system viewer for printing.
#[tauri::command]
pub fn open_pdf(file_name: String, data_b64: String) -> AppResult<()> {
    let dir = std::env::temp_dir().join("jira-assets-manager");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(sanitize_file_name(&file_name));
    std::fs::write(&path, decode(&data_b64)?)?;
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| AppError::Io(e.to_string()))
}
