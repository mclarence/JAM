//! Settings-sync commands: Google account, vault enrollment, encrypted batch transport, and local engine state.
//! The merge engine runs in the webview (src/lib/sync); secrets (tokens, keys, passwords) never leave this module.
//! See docs/sync-protocol.md.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{oneshot, Mutex};
use zeroize::{Zeroize, Zeroizing};

use crate::connection::AppState;
use crate::error::{AppError, AppResult};
use crate::google::{self, Drive, DriveFile, OAuthClient};
use crate::sync_crypto::{self as sc, is_id, is_scope, random, random_id};

const KEYRING_SERVICE: &str = "com.jiraassets.manager";
const KEYRING_SYNC: &str = "sync";
const STATE_FILE: &str = "sync-state.bin";
const STATE_AAD: &[u8] = b"jam-sync:v1:local-state";
const VAULT_PREFIX: &str = "jam-sync-v1-vault-";
const MAX_STATE_BYTES: usize = 64 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY: usize = 8;

/// Device-local sync secrets, stored only in the OS keychain.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Creds {
    refresh_token: String,
    email: String,
    device_id: String,
    /// Encrypts the local engine state file.
    state_key: String,
    #[serde(default)]
    generation_id: Option<String>,
    #[serde(default)]
    data_key: Option<String>,
}

impl Drop for Creds {
    fn drop(&mut self) {
        self.refresh_token.zeroize();
        self.state_key.zeroize();
        if let Some(k) = self.data_key.as_mut() {
            k.zeroize();
        }
    }
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn key32(b64_key: &str) -> AppResult<Zeroizing<[u8; 32]>> {
    let bytes = Zeroizing::new(b64().decode(b64_key).map_err(|_| AppError::Keyring("Stored sync key is invalid.".into()))?);
    let key: [u8; 32] = bytes.as_slice().try_into().map_err(|_| AppError::Keyring("Stored sync key is invalid.".into()))?;
    Ok(Zeroizing::new(key))
}

fn load_creds() -> AppResult<Option<Creds>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_SYNC)?;
    match entry.get_password() {
        Ok(json) => Ok(serde_json::from_str(&Zeroizing::new(json)).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn save_creds(creds: &Creds) -> AppResult<()> {
    let json = Zeroizing::new(serde_json::to_string(creds).map_err(|e| AppError::Invalid(e.to_string()))?);
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_SYNC)?.set_password(&json)?;
    Ok(())
}

fn delete_creds() -> AppResult<()> {
    match keyring::Entry::new(KEYRING_SERVICE, KEYRING_SYNC)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn vault_name(generation_id: &str) -> String {
    format!("{VAULT_PREFIX}{generation_id}.json")
}

fn batch_prefix(generation_id: &str) -> String {
    format!("jam-sync-v1-batch-{generation_id}-")
}

fn batch_name(generation_id: &str, scope: &str, batch_id: &str) -> String {
    format!("{}{scope}-{batch_id}.json", batch_prefix(generation_id))
}

/// Parses `<scope>-<batchId>.json` after the generation prefix.
fn parse_batch_name<'a>(name: &'a str, prefix: &str) -> Option<(&'a str, &'a str)> {
    let rest = name.strip_prefix(prefix)?.strip_suffix(".json")?;
    let (scope, batch_id) = rest.split_once('-')?;
    (is_scope(scope) && is_id(batch_id)).then_some((scope, batch_id))
}

fn is_newer_version(e: &AppError) -> bool {
    matches!(e, AppError::Invalid(m) if m.starts_with("The sync data was created by a newer version"))
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    creds: Option<Creds>,
    drive: Option<Arc<Drive>>,
}

pub struct SyncManager {
    inner: Mutex<Inner>,
    sign_in_cancel: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl Default for SyncManager {
    fn default() -> Self {
        Self { inner: Mutex::new(Inner::default()), sign_in_cancel: std::sync::Mutex::new(None) }
    }
}

fn client() -> AppResult<OAuthClient> {
    google::oauth_client().ok_or_else(|| AppError::Invalid("Settings sync is not configured in this build of JAM.".into()))
}

fn http(app: &AppState) -> AppResult<reqwest::Client> {
    google::http_client(app.network().proxy_url.as_deref())
}

impl Inner {
    fn ensure_loaded(&mut self) -> AppResult<()> {
        if !self.loaded {
            self.creds = load_creds()?;
            self.loaded = true;
        }
        Ok(())
    }

    fn creds(&mut self) -> AppResult<&Creds> {
        self.ensure_loaded()?;
        self.creds.as_ref().ok_or_else(|| AppError::SyncAuth("Sign in to Google to use settings sync.".into()))
    }

    fn drive(&mut self, app: &AppState) -> AppResult<Arc<Drive>> {
        if let Some(d) = &self.drive {
            return Ok(d.clone());
        }
        let token = self.creds()?.refresh_token.clone();
        let drive = Arc::new(Drive::new(http(app)?, client()?, token));
        self.drive = Some(drive.clone());
        Ok(drive)
    }

    /// The enrolled generation and its data key.
    fn vault(&mut self) -> AppResult<(String, Zeroizing<[u8; 32]>)> {
        let creds = self.creds()?;
        match (&creds.generation_id, &creds.data_key) {
            (Some(g), Some(k)) => Ok((g.clone(), key32(k)?)),
            _ => Err(AppError::Invalid("Unlock settings sync with your sync password first.".into())),
        }
    }

    fn status(&mut self) -> AppResult<SyncStatus> {
        self.ensure_loaded()?;
        let c = self.creds.as_ref();
        Ok(SyncStatus {
            configured: google::oauth_client().is_some(),
            signed_in: c.is_some(),
            email: c.map(|c| c.email.clone()),
            generation_id: c.and_then(|c| c.generation_id.clone()),
            device_id: c.map(|c| c.device_id.clone()),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    configured: bool,
    signed_in: bool,
    email: Option<String>,
    /// Set once this device has unlocked (enrolled in) a vault.
    generation_id: Option<String>,
    device_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    generation_id: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledBatch {
    batch_id: String,
    scope: String,
    /// Decrypted batch JSON. Empty when the batch failed authentication; the engine rejects it.
    plaintext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    batches: Vec<PulledBatch>,
    listed: Vec<String>,
    stale: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetResult {
    status: SyncStatus,
    /// Old-generation files that could not be deleted.
    cleanup_failures: usize,
}

fn state_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    Ok(dir.join(STATE_FILE))
}

fn delete_state(app: &AppHandle) -> AppResult<()> {
    match std::fs::remove_file(state_path(app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn check_created_at(created_at: &str) -> AppResult<()> {
    if created_at.is_empty() || created_at.len() > 64 {
        return Err(AppError::Invalid("Invalid timestamp.".into()));
    }
    Ok(())
}

/// Vault descriptors in the account, newest first (by Drive creation time).
async fn list_vault_files(drive: &Drive) -> AppResult<Vec<DriveFile>> {
    let mut files: Vec<DriveFile> = drive
        .list(VAULT_PREFIX)
        .await?
        .into_iter()
        .filter(|f| f.name.strip_prefix(VAULT_PREFIX).and_then(|r| r.strip_suffix(".json")).is_some_and(is_id))
        .collect();
    files.sort_by(|a, b| b.created_time.cmp(&a.created_time).then_with(|| a.name.cmp(&b.name)));
    Ok(files)
}

/// The device's generation is stale if its descriptor is gone or a newer generation exists.
async fn is_stale(drive: &Drive, generation_id: &str) -> AppResult<bool> {
    let files = list_vault_files(drive).await?;
    let own = vault_name(generation_id);
    let Some(mine) = files.iter().find(|f| f.name == own) else { return Ok(true) };
    Ok(files.iter().any(|f| f.name != own && f.created_time > mine.created_time))
}

async fn derive_blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Invalid(e.to_string()))?
}

#[tauri::command]
pub async fn sync_get_status(sync: State<'_, SyncManager>) -> AppResult<SyncStatus> {
    sync.inner.lock().await.status()
}

#[tauri::command]
pub async fn sync_sign_in(app: AppHandle, sync: State<'_, SyncManager>, conn: State<'_, AppState>) -> AppResult<SyncStatus> {
    let client = client()?;
    let http = http(&conn)?;
    let (tx, rx) = oneshot::channel();
    *sync.sign_in_cancel.lock().expect("cancel lock poisoned") = Some(tx);
    let result = google::sign_in(&http, &client, rx).await;
    sync.sign_in_cancel.lock().expect("cancel lock poisoned").take();
    let signed_in = result?;

    let mut inner = sync.inner.lock().await;
    inner.ensure_loaded()?;
    let same_account = inner.creds.as_ref().is_some_and(|c| !signed_in.email.is_empty() && c.email == signed_in.email);
    let creds = match inner.creds.take() {
        Some(mut c) if same_account => {
            c.refresh_token = signed_in.refresh_token.clone();
            c.clone()
        }
        previous => {
            // A different account has a different vault: forget the old enrollment and engine state.
            if let Some(p) = previous {
                google::revoke(&http, &p.refresh_token).await;
            }
            delete_state(&app)?;
            Creds {
                refresh_token: signed_in.refresh_token.clone(),
                email: signed_in.email.clone(),
                device_id: random_id()?,
                state_key: b64().encode(random::<32>()?),
                generation_id: None,
                data_key: None,
            }
        }
    };
    save_creds(&creds)?;
    inner.creds = Some(creds);
    inner.drive = None;
    inner.status()
}

#[tauri::command]
pub fn sync_sign_in_cancel(sync: State<'_, SyncManager>) {
    if let Some(tx) = sync.sign_in_cancel.lock().expect("cancel lock poisoned").take() {
        let _ = tx.send(());
    }
}

/// Signs out of Google and forgets this device's enrollment and engine state. Settings and cloud data are kept.
#[tauri::command]
pub async fn sync_disconnect(app: AppHandle, sync: State<'_, SyncManager>, conn: State<'_, AppState>) -> AppResult<SyncStatus> {
    let mut inner = sync.inner.lock().await;
    inner.ensure_loaded()?;
    if let Some(c) = inner.creds.take() {
        if let Ok(http) = http(&conn) {
            google::revoke(&http, &c.refresh_token).await;
        }
    }
    inner.drive = None;
    delete_creds()?;
    delete_state(&app)?;
    inner.status()
}

#[tauri::command]
pub async fn sync_list_vaults(sync: State<'_, SyncManager>, conn: State<'_, AppState>) -> AppResult<Vec<VaultInfo>> {
    let drive = sync.inner.lock().await.drive(&conn)?;
    let mut vaults = Vec::new();
    for f in list_vault_files(&drive).await? {
        let desc = sc::parse_vault(&drive.download(&f.id).await?)?;
        if f.name == vault_name(&desc.generation_id) {
            vaults.push(VaultInfo { generation_id: desc.generation_id, created_at: desc.created_at });
        }
    }
    Ok(vaults)
}

async fn create_and_upload(drive: &Drive, password: String, created_at: String) -> AppResult<(String, Zeroizing<[u8; 32]>)> {
    let password = Zeroizing::new(password);
    let (desc, key) = derive_blocking(move || sc::create_vault(&password, &created_at)).await?;
    let bytes = serde_json::to_vec(&desc).map_err(|e| AppError::Invalid(e.to_string()))?;
    drive.upload(&vault_name(&desc.generation_id), &bytes).await?;
    Ok((desc.generation_id, key))
}

fn enroll(inner: &mut Inner, app: &AppHandle, generation_id: String, key: &[u8; 32]) -> AppResult<SyncStatus> {
    let mut creds = inner.creds()?.clone();
    if creds.generation_id.as_deref() != Some(generation_id.as_str()) {
        delete_state(app)?;
    }
    creds.generation_id = Some(generation_id);
    creds.data_key = Some(b64().encode(key));
    save_creds(&creds)?;
    inner.creds = Some(creds);
    inner.status()
}

/// Creates the account's first vault. Fails if one already exists (unlock or reset it instead).
#[tauri::command]
pub async fn sync_create_vault(
    app: AppHandle,
    sync: State<'_, SyncManager>,
    conn: State<'_, AppState>,
    password: String,
    created_at: String,
) -> AppResult<SyncStatus> {
    check_created_at(&created_at)?;
    sc::validate_new_password(&password)?;
    let mut inner = sync.inner.lock().await;
    let drive = inner.drive(&conn)?;
    if !list_vault_files(&drive).await?.is_empty() {
        return Err(AppError::Invalid(
            "Settings sync is already set up for this Google account. Enter its sync password instead.".into(),
        ));
    }
    let (generation_id, key) = create_and_upload(&drive, password, created_at).await?;
    enroll(&mut inner, &app, generation_id, &key)
}

#[tauri::command]
pub async fn sync_unlock_vault(
    app: AppHandle,
    sync: State<'_, SyncManager>,
    conn: State<'_, AppState>,
    generation_id: String,
    password: String,
) -> AppResult<SyncStatus> {
    if !is_id(&generation_id) {
        return Err(AppError::Invalid("Invalid sync vault.".into()));
    }
    let mut inner = sync.inner.lock().await;
    let drive = inner.drive(&conn)?;
    let file = list_vault_files(&drive)
        .await?
        .into_iter()
        .find(|f| f.name == vault_name(&generation_id))
        .ok_or_else(|| AppError::Invalid("That sync vault no longer exists.".into()))?;
    let desc = sc::parse_vault(&drive.download(&file.id).await?)?;
    if desc.generation_id != generation_id {
        return Err(AppError::Invalid("The sync vault is malformed.".into()));
    }
    let password = Zeroizing::new(password);
    let key = derive_blocking(move || sc::unlock_vault(&desc, &password)).await?;
    enroll(&mut inner, &app, generation_id, &key)
}

/// Starts a new vault generation with a new password and permanently deletes all older sync data.
/// Every other device must re-enter the new password. Local settings are untouched.
#[tauri::command]
pub async fn sync_reset(
    app: AppHandle,
    sync: State<'_, SyncManager>,
    conn: State<'_, AppState>,
    password: String,
    created_at: String,
) -> AppResult<ResetResult> {
    check_created_at(&created_at)?;
    sc::validate_new_password(&password)?;
    let mut inner = sync.inner.lock().await;
    let drive = inner.drive(&conn)?;
    let old_vaults = list_vault_files(&drive).await?;
    let (generation_id, key) = create_and_upload(&drive, password, created_at).await?;
    let status = enroll(&mut inner, &app, generation_id.clone(), &key)?;

    let mut failures = 0;
    let old_batches = drive.list("jam-sync-v1-batch-").await.unwrap_or_default();
    let keep = batch_prefix(&generation_id);
    for f in old_batches.iter().filter(|f| !f.name.starts_with(&keep)).chain(old_vaults.iter()) {
        if drive.delete(&f.id).await.is_err() {
            failures += 1;
        }
    }
    Ok(ResetResult { status, cleanup_failures: failures })
}

/// Lists this generation's batches for `scopes` and downloads/decrypts the ones not in `known`.
#[tauri::command]
pub async fn sync_pull(
    sync: State<'_, SyncManager>,
    conn: State<'_, AppState>,
    scopes: Vec<String>,
    known: Vec<String>,
) -> AppResult<PullResult> {
    let (drive, generation_id, key) = {
        let mut inner = sync.inner.lock().await;
        let drive = inner.drive(&conn)?;
        let (g, k) = inner.vault()?;
        (drive, g, k)
    };
    if is_stale(&drive, &generation_id).await? {
        return Ok(PullResult { batches: vec![], listed: vec![], stale: true });
    }
    let prefix = batch_prefix(&generation_id);
    let known: std::collections::HashSet<String> = known.into_iter().collect();
    let mut listed = Vec::new();
    let mut todo: Vec<(String, String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for f in drive.list(&prefix).await? {
        let Some((scope, batch_id)) = parse_batch_name(&f.name, &prefix) else { continue };
        if !scopes.iter().any(|s| s == scope) || !seen.insert(batch_id.to_string()) {
            continue;
        }
        listed.push(batch_id.to_string());
        if !known.contains(batch_id) {
            todo.push((f.id.clone(), scope.to_string(), batch_id.to_string()));
        }
    }

    let mut batches = Vec::with_capacity(todo.len());
    for chunk in todo.chunks(DOWNLOAD_CONCURRENCY) {
        let mut set = tokio::task::JoinSet::new();
        for (file_id, scope, batch_id) in chunk.iter().cloned() {
            let drive = drive.clone();
            set.spawn(async move { (scope, batch_id, drive.download(&file_id).await) });
        }
        while let Some(joined) = set.join_next().await {
            let (scope, batch_id, bytes) = joined.map_err(|e| AppError::Invalid(e.to_string()))?;
            let plaintext = match sc::open_batch(&key, &bytes?, &generation_id, &scope, &batch_id) {
                Ok(p) => String::from_utf8(p.to_vec()).unwrap_or_default(),
                Err(e) if is_newer_version(&e) => return Err(e),
                Err(_) => String::new(),
            };
            batches.push(PulledBatch { batch_id, scope, plaintext });
        }
    }
    Ok(PullResult { batches, listed, stale: false })
}

/// Encrypts and uploads one batch. Idempotent: an already-uploaded batch is skipped.
#[tauri::command]
pub async fn sync_push(
    sync: State<'_, SyncManager>,
    conn: State<'_, AppState>,
    batch_id: String,
    scope: String,
    plaintext: String,
) -> AppResult<()> {
    let plaintext = Zeroizing::new(plaintext);
    let (drive, generation_id, key) = {
        let mut inner = sync.inner.lock().await;
        let drive = inner.drive(&conn)?;
        let (g, k) = inner.vault()?;
        (drive, g, k)
    };
    let name = batch_name(&generation_id, &scope, &batch_id);
    let envelope = sc::seal_batch(&key, &generation_id, &scope, &batch_id, plaintext.as_bytes())?;
    if drive.list(&name).await?.iter().any(|f| f.name == name) {
        return Ok(());
    }
    if is_stale(&drive, &generation_id).await? {
        return Err(AppError::SyncStale);
    }
    let bytes = serde_json::to_vec(&envelope).map_err(|e| AppError::Invalid(e.to_string()))?;
    drive.upload(&name, &bytes).await
}

fn state_cipher(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.into())
}

/// Loads the engine state (JSON), or `None` if there is none or it cannot be decrypted.
#[tauri::command]
pub async fn sync_state_load(app: AppHandle, sync: State<'_, SyncManager>) -> AppResult<Option<String>> {
    let mut inner = sync.inner.lock().await;
    inner.ensure_loaded()?;
    let Some(creds) = inner.creds.as_ref() else { return Ok(None) };
    let key = key32(&creds.state_key)?;
    let bytes = match std::fs::read(state_path(&app)?) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if bytes.len() < 24 || bytes.len() > MAX_STATE_BYTES {
        return Ok(None);
    }
    let (nonce, ciphertext) = bytes.split_at(24);
    let Ok(plain) = state_cipher(&key).decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad: STATE_AAD }) else {
        return Ok(None);
    };
    Ok(String::from_utf8(plain).ok())
}

/// Atomically replaces the encrypted engine state.
#[tauri::command]
pub async fn sync_state_save(app: AppHandle, sync: State<'_, SyncManager>, state: String) -> AppResult<()> {
    if state.len() > MAX_STATE_BYTES {
        return Err(AppError::Invalid("The sync state is too large.".into()));
    }
    let key = {
        let mut inner = sync.inner.lock().await;
        key32(&inner.creds()?.state_key)?
    };
    let nonce = random::<24>()?;
    let ciphertext = state_cipher(&key)
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: state.as_bytes(), aad: STATE_AAD })
        .map_err(|_| AppError::Invalid("Encryption failed".into()))?;
    let path = state_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let mut data = nonce.to_vec();
    data.extend_from_slice(&ciphertext);
    std::fs::write(&tmp, &data)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_names_round_trip() {
        let g = "0123456789abcdef0123456789abcdef";
        let b = "ffeeddccbbaa99887766554433221100";
        let name = batch_name(g, "desktop", b);
        assert_eq!(name, format!("jam-sync-v1-batch-{g}-desktop-{b}.json"));
        assert_eq!(parse_batch_name(&name, &batch_prefix(g)), Some(("desktop", b)));
        assert_eq!(parse_batch_name(&format!("jam-sync-v1-batch-{g}-Bad-{b}.json"), &batch_prefix(g)), None);
        assert_eq!(parse_batch_name(&format!("jam-sync-v1-batch-{g}-shared-xyz.json"), &batch_prefix(g)), None);
    }

    #[test]
    fn detects_newer_version_errors() {
        let key = [7u8; 32];
        let g = "0123456789abcdef0123456789abcdef";
        let b = "ffeeddccbbaa99887766554433221100";
        let mut env = serde_json::to_value(sc::seal_batch(&key, g, "shared", b, b"{}").unwrap()).unwrap();
        env["version"] = 2.into();
        let err = sc::open_batch(&key, env.to_string().as_bytes(), g, "shared", b).unwrap_err();
        assert!(is_newer_version(&err));
        assert!(!is_newer_version(&AppError::PassphraseInvalid));
    }
}
