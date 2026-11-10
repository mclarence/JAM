//! Google OAuth (installed-app loopback flow with PKCE) and Drive `appDataFolder` storage for settings sync.
//! See docs/sync-protocol.md §7. Uses its own HTTP client: never the Jira client, its credentials, or its TLS bypass.

use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use url::Url;

use crate::error::{AppError, AppResult};
use crate::sync_crypto::{random, random_id, MAX_ENVELOPE_BYTES};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";
const SCOPES: &str = "https://www.googleapis.com/auth/drive.appdata openid email";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_RETRIES: u32 = 3;

/// OAuth client registration, supplied at build time (`JAM_GOOGLE_CLIENT_ID`, optional `JAM_GOOGLE_CLIENT_SECRET`).
/// Google issues a "secret" for desktop clients, but installed apps are public clients: it is not confidential.
#[derive(Clone)]
pub struct OAuthClient {
    pub id: String,
    pub secret: Option<String>,
}

pub fn oauth_client() -> Option<OAuthClient> {
    let id = option_env!("JAM_GOOGLE_CLIENT_ID").map(str::trim).filter(|s| !s.is_empty())?;
    let secret = option_env!("JAM_GOOGLE_CLIENT_SECRET").map(str::trim).filter(|s| !s.is_empty());
    Some(OAuthClient { id: id.into(), secret: secret.map(Into::into) })
}

pub fn http_client(proxy_url: Option<&str>) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("jam/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(60));
    if let Some(p) = proxy_url.map(str::trim).filter(|p| !p.is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(p).map_err(|e| AppError::Invalid(format!("Invalid proxy URL: {e}")))?);
    }
    Ok(builder.build()?)
}

fn b64url() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

pub struct SignInResult {
    pub refresh_token: String,
    pub email: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize)]
struct OAuthError {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

/// Runs the browser sign-in: opens the system browser and waits for the loopback redirect, `cancel`, or a timeout.
pub async fn sign_in(http: &reqwest::Client, client: &OAuthClient, cancel: oneshot::Receiver<()>) -> AppResult<SignInResult> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let redirect_uri = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let verifier = b64url().encode(random::<32>()?);
    let challenge = b64url().encode(Sha256::digest(verifier.as_bytes()));
    let state = random_id()?;

    let mut url = Url::parse(AUTH_URL).expect("valid auth URL");
    url.query_pairs_mut()
        .append_pair("client_id", &client.id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent select_account");
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
        .map_err(|e| AppError::Invalid(format!("Could not open the browser: {e}")))?;

    let code = tokio::select! {
        r = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_code(&listener, &state)) => {
            r.map_err(|_| AppError::SyncAuth("Google sign-in timed out. Try again.".into()))??
        }
        _ = cancel => return Err(AppError::Cancelled),
    };
    drop(listener);

    let mut form = vec![
        ("client_id", client.id.as_str()),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("grant_type", "authorization_code"),
    ];
    if let Some(secret) = client.secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let tokens = token_request(http, &form).await?;
    if !tokens.scope.as_deref().unwrap_or_default().split(' ').any(|s| s == "https://www.googleapis.com/auth/drive.appdata") {
        return Err(AppError::SyncAuth("Google Drive access was not granted. Sign in again and allow access to app data.".into()));
    }
    let refresh_token = tokens
        .refresh_token
        .ok_or_else(|| AppError::SyncAuth("Google did not return a refresh token. Try signing in again.".into()))?;
    let email = tokens.id_token.as_deref().and_then(email_from_id_token).unwrap_or_default();
    Ok(SignInResult { refresh_token, email })
}

/// The ID token comes straight from Google's token endpoint over TLS, so its claims are read without verifying the signature.
fn email_from_id_token(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = b64url().decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("email")?.as_str().map(Into::into)
}

async fn wait_for_code(listener: &TcpListener, state: &str) -> AppResult<String> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buf = Vec::with_capacity(1024);
        let read = tokio::time::timeout(Duration::from_secs(10), async {
            let mut chunk = [0u8; 1024];
            while buf.len() < 8192 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut chunk).await?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Ok::<_, std::io::Error>(())
        })
        .await;
        if !matches!(read, Ok(Ok(()))) {
            continue;
        }
        let line = String::from_utf8_lossy(&buf);
        let target = line.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next()).unwrap_or("");
        let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else { continue };
        if url.path() != "/" {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
        if param("state").as_deref() != Some(state) {
            respond(&mut stream, "Sign-in failed", "This sign-in request was not started by JAM. Return to the app and try again.").await;
            continue;
        }
        if let Some(error) = param("error") {
            respond(&mut stream, "Sign-in cancelled", "You can close this window and return to JAM.").await;
            return Err(if error == "access_denied" {
                AppError::Cancelled
            } else {
                AppError::SyncAuth(format!("Google sign-in failed: {error}"))
            });
        }
        let Some(code) = param("code") else { continue };
        respond(&mut stream, "Signed in", "You can close this window and return to JAM.").await;
        return Ok(code);
    }
}

async fn respond(stream: &mut tokio::net::TcpStream, title: &str, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>{title}</title>\
         <body style=\"font-family:system-ui;text-align:center;padding:4em\"><h1>{title}</h1><p>{message}</p></body>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn token_request(http: &reqwest::Client, form: &[(&str, &str)]) -> AppResult<TokenResponse> {
    let resp = with_retry(|| http.post(TOKEN_URL).form(form)).await?;
    let status = resp.status();
    if status.is_success() {
        return resp.json().await.map_err(|_| AppError::SyncAuth("Google returned an invalid sign-in response.".into()));
    }
    let err: Option<OAuthError> = resp.json().await.ok();
    match err {
        Some(e) if e.error == "invalid_grant" => {
            Err(AppError::SyncAuth("Google sign-in has expired or was revoked. Sign in to Google again.".into()))
        }
        Some(e) => Err(AppError::SyncAuth(format!(
            "Google sign-in failed: {}",
            e.error_description.unwrap_or(e.error)
        ))),
        None => Err(AppError::Http { status: status.as_u16(), message: format!("Google sign-in failed (HTTP {status}).") }),
    }
}

/// Sends a request, retrying network errors, 429 and 5xx with jittered exponential backoff.
async fn with_retry(build: impl Fn() -> reqwest::RequestBuilder) -> AppResult<reqwest::Response> {
    let mut attempt = 0;
    loop {
        let result = build().send().await;
        let retryable = match &result {
            Ok(r) => r.status().as_u16() == 429 || r.status().is_server_error(),
            Err(e) => e.is_timeout() || e.is_connect() || e.is_request(),
        };
        if !retryable || attempt >= MAX_RETRIES {
            return Ok(result?);
        }
        let jitter = u64::from(random::<1>().map(|b| b[0]).unwrap_or(0)) * 4;
        tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt) + jitter)).await;
        attempt += 1;
    }
}

pub async fn revoke(http: &reqwest::Client, token: &str) {
    let _ = http.post(REVOKE_URL).form(&[("token", token)]).send().await;
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_time: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileList {
    #[serde(default)]
    files: Vec<DriveFile>,
    next_page_token: Option<String>,
}

/// Authorized access to the hidden Drive app-data folder.
pub struct Drive {
    http: reqwest::Client,
    client: OAuthClient,
    refresh_token: String,
    access: Mutex<Option<(String, Instant)>>,
}

impl Drive {
    pub fn new(http: reqwest::Client, client: OAuthClient, refresh_token: String) -> Self {
        Self { http, client, refresh_token, access: Mutex::new(None) }
    }

    async fn token(&self, force: bool) -> AppResult<String> {
        let mut access = self.access.lock().await;
        if let Some((token, expires)) = access.as_ref() {
            if !force && Instant::now() < *expires {
                return Ok(token.clone());
            }
        }
        let mut form = vec![
            ("client_id", self.client.id.as_str()),
            ("refresh_token", self.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ];
        if let Some(secret) = self.client.secret.as_deref() {
            form.push(("client_secret", secret));
        }
        let t = token_request(&self.http, &form).await?;
        let lifetime = t.expires_in.unwrap_or(3600).saturating_sub(120);
        *access = Some((t.access_token.clone(), Instant::now() + Duration::from_secs(lifetime)));
        Ok(t.access_token)
    }

    /// Sends an authorized request, refreshing the access token once on 401.
    async fn send(&self, build: impl Fn(&str) -> reqwest::RequestBuilder) -> AppResult<reqwest::Response> {
        let token = self.token(false).await?;
        let resp = with_retry(|| build(&token)).await?;
        if resp.status().as_u16() != 401 {
            return Ok(resp);
        }
        let token = self.token(true).await?;
        with_retry(|| build(&token)).await
    }

    async fn check(resp: reqwest::Response) -> AppResult<reqwest::Response> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let detail: serde_json::Value = resp.json().await.unwrap_or_default();
        let message = detail["error"]["message"].as_str().unwrap_or("request failed").to_string();
        Err(match status.as_u16() {
            401 => AppError::SyncAuth("Google sign-in has expired or was revoked. Sign in to Google again.".into()),
            403 if message.to_ascii_lowercase().contains("scope") || message.to_ascii_lowercase().contains("permission") => {
                AppError::SyncAuth("JAM no longer has access to Google Drive app data. Sign in to Google again.".into())
            }
            s => AppError::Http { status: s, message: format!("Google Drive: {message} (HTTP {s})") },
        })
    }

    /// Lists app-data files whose names start with `prefix`.
    pub async fn list(&self, prefix: &str) -> AppResult<Vec<DriveFile>> {
        let query = format!("name contains '{}' and trashed = false", prefix.replace('\\', "\\\\").replace('\'', "\\'"));
        let mut files = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let resp = self
                .send(|token| {
                    let mut q = vec![
                        ("spaces", "appDataFolder"),
                        ("q", query.as_str()),
                        ("pageSize", "1000"),
                        ("fields", "nextPageToken,files(id,name,createdTime)"),
                    ];
                    if let Some(p) = page.as_deref() {
                        q.push(("pageToken", p));
                    }
                    self.http.get(FILES_URL).bearer_auth(token).query(&q)
                })
                .await?;
            let list: FileList = Self::check(resp).await?.json().await?;
            files.extend(list.files.into_iter().filter(|f| f.name.starts_with(prefix)));
            match list.next_page_token {
                Some(p) => page = Some(p),
                None => return Ok(files),
            }
        }
    }

    /// Downloads a file, refusing anything larger than the protocol's envelope limit.
    pub async fn download(&self, id: &str) -> AppResult<Vec<u8>> {
        let url = format!("{FILES_URL}/{id}");
        let mut resp = Self::check(self.send(|token| self.http.get(&url).bearer_auth(token).query(&[("alt", "media")])).await?).await?;
        if resp.content_length().is_some_and(|n| n > MAX_ENVELOPE_BYTES as u64) {
            return Err(AppError::Invalid("A sync file is too large.".into()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await? {
            if body.len() + chunk.len() > MAX_ENVELOPE_BYTES {
                return Err(AppError::Invalid("A sync file is too large.".into()));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    pub async fn upload(&self, name: &str, content: &[u8]) -> AppResult<()> {
        let boundary = format!("jam-{}", random_id()?);
        let metadata = serde_json::json!({ "name": name, "parents": ["appDataFolder"], "mimeType": "application/json" });
        let mut body = Vec::with_capacity(content.len() + 512);
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n").as_bytes());
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json\r\n\r\n").as_bytes());
        body.extend_from_slice(content);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let content_type = format!("multipart/related; boundary={boundary}");
        let resp = self
            .send(|token| {
                self.http
                    .post(UPLOAD_URL)
                    .bearer_auth(token)
                    .header(reqwest::header::CONTENT_TYPE, content_type.as_str())
                    .body(body.clone())
            })
            .await?;
        Self::check(resp).await?;
        Ok(())
    }

    /// Permanently deletes a file (app-data files cannot be trashed). Missing files count as deleted.
    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let url = format!("{FILES_URL}/{id}");
        let resp = self.send(|token| self.http.delete(&url).bearer_auth(token)).await?;
        if resp.status().as_u16() == 404 {
            return Ok(());
        }
        Self::check(resp).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_email_from_id_token() {
        let payload = b64url().encode(br#"{"email":"a@example.com","sub":"1"}"#);
        assert_eq!(email_from_id_token(&format!("h.{payload}.s")).as_deref(), Some("a@example.com"));
        assert_eq!(email_from_id_token("garbage"), None);
    }

    #[tokio::test]
    async fn loopback_rejects_wrong_state_and_returns_code() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = tokio::spawn(async move {
            for path in ["/favicon.ico", "/?state=wrong&code=evil", "/?state=expected&code=good"] {
                let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
                let mut out = String::new();
                let _ = s.read_to_string(&mut out).await;
            }
        });
        assert_eq!(wait_for_code(&listener, "expected").await.unwrap(), "good");
        client.await.unwrap();
    }
}
