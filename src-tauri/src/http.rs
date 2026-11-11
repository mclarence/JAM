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

pub struct Failure {
    pub error: AppError,
    /// Server-requested delay from a `Retry-After` header (seconds form only).
    pub retry_after: Option<std::time::Duration>,
}

impl From<AppError> for Failure {
    fn from(error: AppError) -> Self {
        Self { error, retry_after: None }
    }
}

fn parse_method(method: &str) -> AppResult<Method> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "DELETE" => Ok(Method::DELETE),
        m => Err(AppError::Invalid(format!("Unsupported method {m}"))),
    }
}

/// The account a long-running job started with; requests fail if the connection changes mid-job.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Principal {
    pub cloud_id: String,
    pub workspace_id: String,
    pub email: String,
}

/// Sends one authenticated request to the connected workspace's Assets API and parses the JSON response.
pub(crate) async fn send(
    state: &AppState,
    expect: Option<&Principal>,
    method: &str,
    path: &str,
    query: Option<&[(String, String)]>,
    body: Option<&Value>,
) -> Result<Value, Failure> {
    validate_path(path)?;
    let method = parse_method(method)?;
    let conn = state.current()?;
    if let Some(p) = expect {
        if p.cloud_id != conn.cloud_id || p.workspace_id != conn.workspace_id || !p.email.eq_ignore_ascii_case(&conn.email) {
            return Err(AppError::Invalid("The Jira connection changed while collecting report data. Refresh again.".into()).into());
        }
    }
    let url = format!("{}{}", conn.api_base, path);

    let mut req = state
        .client()
        .request(method, &url)
        .header("Authorization", conn.auth_header())
        .header("Accept", "application/json");
    if let Some(q) = query {
        req = req.query(q);
    }
    if let Some(b) = body {
        req = req.json(b);
    }

    let res = req.send().await.map_err(AppError::from)?;
    let status = res.status();
    let header = |name: reqwest::header::HeaderName| res.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let content_type = header(reqwest::header::CONTENT_TYPE);
    let retry_after = header(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|s| std::time::Duration::from_secs(s.min(600)));
    if let Some(e) = proxy_block(status.as_u16(), content_type.as_deref()) {
        return Err(e.into());
    }
    let text = res.text().await.map_err(AppError::from)?;
    if !status.is_success() {
        return Err(Failure {
            error: AppError::Http { status: status.as_u16(), message: error_message(status.as_u16(), &text) },
            retry_after,
        });
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| AppError::Invalid(format!("Invalid JSON response: {e}")).into())
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
    send(&state, None, &method, &path, query.as_deref(), body.as_ref()).await.map_err(|f| f.error)
}
