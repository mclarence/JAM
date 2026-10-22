use reqwest::Method;
use serde_json::Value;

use crate::connection::AppState;
use crate::error::{proxy_block, AppError, AppResult};

fn validate_path(path: &str) -> AppResult<()> {
    let ok = path.starts_with('/')
        && !path.contains("..")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("Invalid API path: {path}")))
    }
}

fn error_message(status: u16, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let mut parts: Vec<String> = Vec::new();
    if let Some(v) = &parsed {
        if let Some(msgs) = v.get("errorMessages").and_then(Value::as_array) {
            parts.extend(msgs.iter().filter_map(Value::as_str).map(String::from));
        }
        if let Some(errs) = v.get("errors").and_then(Value::as_object) {
            parts.extend(errs.iter().map(|(k, v)| {
                let text = v.as_str().map(String::from).unwrap_or_else(|| v.to_string());
                format!("{k}: {text}")
            }));
        }
        if parts.is_empty() {
            if let Some(m) = v.get("message").and_then(Value::as_str) {
                parts.push(m.to_string());
            }
        }
    }
    if !parts.is_empty() {
        return parts.join("; ");
    }
    match status {
        401 => "Unauthorized: your API token is invalid or expired".into(),
        403 => "Forbidden: you do not have permission for this action".into(),
        404 => "Not found".into(),
        429 => "Rate limited by Atlassian; please retry shortly".into(),
        s => format!("Request failed with HTTP {s}"),
    }
}

/// Proxies a JIRA Assets REST call. `path` is relative to the workspace API base.
#[tauri::command]
pub async fn assets_request(
    state: tauri::State<'_, AppState>,
    method: String,
    path: String,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
) -> AppResult<Value> {
    validate_path(&path)?;
    let method = match method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        m => return Err(AppError::Invalid(format!("Unsupported method {m}"))),
    };
    let conn = state.current()?;
    let url = format!("{}{}", conn.api_base, path);

    let mut req = state
        .client()
        .request(method, &url)
        .header("Authorization", conn.auth_header())
        .header("Accept", "application/json");
    if let Some(q) = &query {
        req = req.query(q);
    }
    if let Some(b) = &body {
        req = req.json(b);
    }

    let res = req.send().await?;
    let status = res.status();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    if let Some(e) = proxy_block(status.as_u16(), content_type.as_deref()) {
        return Err(e);
    }
    let text = res.text().await?;
    if !status.is_success() {
        return Err(AppError::Http {
            status: status.as_u16(),
            message: error_message(status.as_u16(), &text),
        });
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| AppError::Invalid(format!("Invalid JSON response: {e}")))
}
