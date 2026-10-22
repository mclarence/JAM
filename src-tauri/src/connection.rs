use std::sync::{Arc, RwLock};

use base64::Engine;
use reqwest::cookie::Jar;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::error::{proxy_block, AppError, AppResult};

const KEYRING_SERVICE: &str = "com.jiraassets.manager";
const KEYRING_USER: &str = "connection";
const KEYRING_NETWORK: &str = "network";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Basic,
    Bearer,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnection {
    pub site_url: String,
    pub auth_type: AuthType,
    pub email: String,
    pub secret: String,
    pub cloud_id: String,
    pub workspace_id: String,
    pub api_base: String,
}

impl StoredConnection {
    pub fn auth_header(&self) -> String {
        auth_header(self.auth_type, &self.email, &self.secret)
    }

    pub fn info(&self) -> ConnectionInfo {
        ConnectionInfo {
            site_url: self.site_url.clone(),
            auth_type: self.auth_type,
            email: self.email.clone(),
            cloud_id: self.cloud_id.clone(),
            workspace_id: self.workspace_id.clone(),
        }
    }
}

/// Connection details safe to expose to the webview (no secret).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub site_url: String,
    pub auth_type: AuthType,
    pub email: String,
    pub cloud_id: String,
    pub workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInput {
    pub site_url: String,
    pub auth_type: AuthType,
    #[serde(default)]
    pub email: String,
    /// When omitted, the previously stored secret is reused.
    pub secret: Option<String>,
}

/// Transport settings for networks with TLS-inspecting web filters.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkOptions {
    pub accept_invalid_certs: bool,
    /// Overrides the system proxy; needed when the system uses a PAC script, which reqwest cannot read.
    pub proxy_url: Option<String>,
}

pub struct AppState {
    client: RwLock<reqwest::Client>,
    /// Holds web proxy session cookies captured from the sign-in window.
    pub jar: Arc<Jar>,
    network: RwLock<NetworkOptions>,
    pub connection: RwLock<Option<StoredConnection>>,
}

fn build_client(opts: &NetworkOptions, jar: Arc<Jar>) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("jira-assets-manager/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(60))
        .cookie_provider(jar);
    if opts.accept_invalid_certs {
        builder = builder.danger_accept_invalid_certs(true);
    }
    if let Some(p) = opts.proxy_url.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        let proxy = reqwest::Proxy::all(p).map_err(|e| AppError::Invalid(format!("Invalid proxy URL: {e}")))?;
        builder = builder.proxy(proxy);
    }
    Ok(builder.build()?)
}

impl AppState {
    pub fn new() -> Self {
        let jar = Arc::new(Jar::default());
        let network = load_network_options().unwrap_or_default();
        let client = build_client(&network, jar.clone())
            .or_else(|_| build_client(&NetworkOptions::default(), jar.clone()))
            .expect("failed to build HTTP client");
        Self {
            client: RwLock::new(client),
            jar,
            network: RwLock::new(network),
            connection: RwLock::new(load_from_keyring().ok().flatten()),
        }
    }

    pub fn client(&self) -> reqwest::Client {
        self.client.read().expect("client lock poisoned").clone()
    }

    pub fn network(&self) -> NetworkOptions {
        self.network.read().expect("network lock poisoned").clone()
    }

    pub fn apply_network(&self, opts: NetworkOptions) -> AppResult<()> {
        let client = build_client(&opts, self.jar.clone())?;
        save_network_options(&opts)?;
        *self.client.write().expect("client lock poisoned") = client;
        *self.network.write().expect("network lock poisoned") = opts;
        Ok(())
    }

    pub fn current(&self) -> AppResult<StoredConnection> {
        self.connection
            .read()
            .map_err(|_| AppError::Invalid("connection lock poisoned".into()))?
            .clone()
            .ok_or(AppError::NotConnected)
    }

    pub(crate) fn set(&self, value: Option<StoredConnection>) {
        if let Ok(mut guard) = self.connection.write() {
            *guard = value;
        }
    }
}

fn auth_header(auth_type: AuthType, email: &str, secret: &str) -> String {
    match auth_type {
        AuthType::Basic => {
            let raw = format!("{email}:{secret}");
            format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
        }
        AuthType::Bearer => format!("Bearer {secret}"),
    }
}

/// Only Atlassian Cloud sites are accepted so credentials are never sent elsewhere.
pub fn normalize_site(input: &str) -> AppResult<String> {
    let trimmed = input.trim().trim_end_matches('/');
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| AppError::Invalid("Invalid site URL".into()))?;
    if url.scheme() != "https" {
        return Err(AppError::Invalid("Site URL must use https".into()));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::Invalid("Invalid site URL".into()))?
        .to_ascii_lowercase();
    if !host.ends_with(".atlassian.net") {
        return Err(AppError::Invalid(
            "Site URL must be an Atlassian Cloud site (https://<your-site>.atlassian.net)".into(),
        ));
    }
    Ok(format!("https://{host}"))
}

fn load_from_keyring() -> AppResult<Option<StoredConnection>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
    match entry.get_password() {
        Ok(json) => Ok(serde_json::from_str(&json).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn load_network_options() -> AppResult<NetworkOptions> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_NETWORK)?;
    match entry.get_password() {
        Ok(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
        Err(keyring::Error::NoEntry) => Ok(NetworkOptions::default()),
        Err(e) => Err(e.into()),
    }
}

fn save_network_options(opts: &NetworkOptions) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_NETWORK)?;
    let json = serde_json::to_string(opts).map_err(|e| AppError::Invalid(e.to_string()))?;
    entry.set_password(&json)?;
    Ok(())
}

pub(crate) fn save_to_keyring(conn: &StoredConnection) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
    let json = serde_json::to_string(conn).map_err(|e| AppError::Invalid(e.to_string()))?;
    entry.set_password(&json)?;
    Ok(())
}

fn delete_from_keyring() -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

async fn get_json(client: &reqwest::Client, url: &str, auth: Option<&str>) -> AppResult<Value> {
    let mut req = client.get(url).header("Accept", "application/json");
    if let Some(a) = auth {
        req = req.header("Authorization", a);
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
    if !status.is_success() {
        let message = match status.as_u16() {
            401 => "Unauthorized: check your email and API token".to_string(),
            403 => "Forbidden: this account lacks access to JIRA Assets".to_string(),
            404 => format!("Not found: {url}"),
            s => format!("Request failed with HTTP {s}"),
        };
        return Err(AppError::Http { status: status.as_u16(), message });
    }
    Ok(res.json::<Value>().await?)
}

/// Spec server URL first; classic (unscoped) API tokens are only accepted on the legacy gateway path.
fn api_base_candidates(cloud_id: &str, workspace_id: &str) -> [String; 2] {
    [
        format!("https://api.atlassian.com/ex/jira/{cloud_id}/jsm/assets/workspace/{workspace_id}/v1"),
        format!("https://api.atlassian.com/jsm/assets/workspace/{workspace_id}/v1"),
    ]
}

impl StoredConnection {
    /// Checks a connection read from a file so a crafted export cannot send the token to another host.
    pub fn validate_imported(mut self) -> AppResult<Self> {
        let bad = |what: &str| AppError::Invalid(format!("The imported connection is invalid: {what}."));
        self.site_url = normalize_site(&self.site_url)?;
        self.email = self.email.trim().to_string();
        let id_ok = |s: &str| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !id_ok(&self.cloud_id) || !id_ok(&self.workspace_id) {
            return Err(bad("unexpected workspace identifiers"));
        }
        if !api_base_candidates(&self.cloud_id, &self.workspace_id).contains(&self.api_base) {
            return Err(bad("unexpected API address"));
        }
        if self.secret.trim().is_empty() || (self.auth_type == AuthType::Basic && self.email.is_empty()) {
            return Err(bad("missing credentials"));
        }
        Ok(self)
    }
}

async fn discover(client: &reqwest::Client, input: &ConnectInput, secret: &str) -> AppResult<StoredConnection> {
    let site_url = normalize_site(&input.site_url)?;
    if input.auth_type == AuthType::Basic && input.email.trim().is_empty() {
        return Err(AppError::Invalid("Email is required for basic auth".into()));
    }
    let auth = auth_header(input.auth_type, input.email.trim(), secret);

    let tenant = get_json(client, &format!("{site_url}/_edge/tenant_info"), None).await?;
    let cloud_id = tenant
        .get("cloudId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Invalid("Could not resolve cloudId for this site".into()))?
        .to_string();

    // Scoped tokens only work on the gateway; classic tokens may only work on the site URL.
    let gateway_url = format!("https://api.atlassian.com/ex/jira/{cloud_id}/rest/servicedeskapi/assets/workspace");
    let workspace_urls = match input.auth_type {
        AuthType::Basic => vec![gateway_url, format!("{site_url}/rest/servicedeskapi/assets/workspace")],
        AuthType::Bearer => vec![gateway_url],
    };
    let mut ws_result = None;
    for url in &workspace_urls {
        match get_json(client, url, Some(&auth)).await {
            Ok(v) => {
                ws_result = Some(Ok(v));
                break;
            }
            Err(e @ AppError::Http { status: 401 | 403 | 404, .. }) => ws_result = Some(Err(e)),
            Err(e) => return Err(e),
        }
    }
    let ws = ws_result.unwrap_or(Err(AppError::NotConnected))?;
    let workspace_id = ws
        .get("values")
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .and_then(|v| v.get("workspaceId"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Invalid("No Assets workspace found for this site".into()))?
        .to_string();

    let candidates = api_base_candidates(&cloud_id, &workspace_id);
    let mut last_err = None;
    for base in candidates {
        match get_json(client, &format!("{base}/objectschema/list?maxResults=1"), Some(&auth)).await {
            Ok(_) => {
                return Ok(StoredConnection {
                    site_url,
                    auth_type: input.auth_type,
                    email: input.email.trim().to_string(),
                    secret: secret.to_string(),
                    cloud_id,
                    workspace_id,
                    api_base: base,
                })
            }
            Err(e @ AppError::Http { status: 401 | 403 | 404, .. }) => last_err = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or(AppError::NotConnected))
}

#[tauri::command]
pub async fn connect(state: tauri::State<'_, AppState>, input: ConnectInput) -> AppResult<ConnectionInfo> {
    let secret = match input.secret.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None => state.current().map(|c| c.secret).map_err(|_| AppError::Invalid("API token is required".into()))?,
    };
    let conn = discover(&state.client(), &input, &secret).await?;
    save_to_keyring(&conn)?;
    let info = conn.info();
    state.set(Some(conn));
    Ok(info)
}

#[tauri::command]
pub fn get_connection(state: tauri::State<'_, AppState>) -> Option<ConnectionInfo> {
    state.current().ok().map(|c| c.info())
}

#[tauri::command]
pub fn disconnect(state: tauri::State<'_, AppState>) -> AppResult<()> {
    delete_from_keyring()?;
    state.set(None);
    Ok(())
}
