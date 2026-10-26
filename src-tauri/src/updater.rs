use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::connection::AppState;
use crate::error::{AppError, AppResult};

const STABLE_ENDPOINT: &str = "https://github.com/mclarence/JAM/releases/latest/download/latest.json";
const NIGHTLY_ENDPOINT: &str = "https://github.com/mclarence/JAM/releases/download/nightly/latest.json";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Nightly,
}

impl UpdateChannel {
    fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => STABLE_ENDPOINT,
            Self::Nightly => NIGHTLY_ENDPOINT,
        }
    }
}

#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<Vec<u8>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum DownloadEvent {
    Progress { downloaded: u64, total: Option<u64> },
    Finished,
}

fn update_err(e: impl std::fmt::Display) -> AppError {
    AppError::Update(e.to_string())
}

fn is_nightly(pre: &str) -> bool {
    pre.starts_with("nightly.")
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, AppState>,
    updater: State<'_, UpdaterState>,
    channel: UpdateChannel,
) -> AppResult<Option<UpdateInfo>> {
    let endpoint: Url = channel.endpoint().parse().map_err(update_err)?;
    let network = state.network();

    let mut builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(update_err)?
        .timeout(Duration::from_secs(30))
        // Nightly and stable versions are not ordered against each other, so switching channels always offers the other build.
        .version_comparator(|current, remote| {
            if is_nightly(current.pre.as_str()) != is_nightly(remote.version.pre.as_str()) {
                return true;
            }
            remote.version > current
        });
    if let Some(p) = network.proxy_url.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        builder = builder.proxy(p.parse().map_err(|_| AppError::Invalid("Invalid proxy URL".into()))?);
    }

    let found = builder.build().map_err(update_err)?.check().await.map_err(update_err)?;
    *updater.downloaded.lock().expect("updater lock poisoned") = None;
    let info = found.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone(),
    });
    *updater.pending.lock().expect("updater lock poisoned") = found;
    Ok(info)
}

#[tauri::command]
pub async fn download_update(updater: State<'_, UpdaterState>, on_event: Channel<DownloadEvent>) -> AppResult<()> {
    let update = updater
        .pending
        .lock()
        .expect("updater lock poisoned")
        .clone()
        .ok_or_else(|| AppError::Update("No update is available. Check for updates first.".into()))?;

    let mut received: u64 = 0;
    let progress = on_event.clone();
    let finished = on_event;
    let bytes = update
        .download(
            move |chunk, total| {
                received += chunk as u64;
                let _ = progress.send(DownloadEvent::Progress { downloaded: received, total });
            },
            move || {
                let _ = finished.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(update_err)?;
    // A channel switch during the download replaces the pending update, so the bytes would no longer match it.
    let still_pending = updater
        .pending
        .lock()
        .expect("updater lock poisoned")
        .as_ref()
        .is_some_and(|p| p.download_url == update.download_url);
    if !still_pending {
        return Err(AppError::Update("The update changed while downloading.".into()));
    }
    *updater.downloaded.lock().expect("updater lock poisoned") = Some(bytes);
    Ok(())
}

/// Installs the downloaded update and relaunches. On Windows the installer ends the process itself.
#[tauri::command]
pub fn install_update(app: AppHandle, updater: State<'_, UpdaterState>) -> AppResult<()> {
    let update = updater.pending.lock().expect("updater lock poisoned").clone();
    let bytes = updater.downloaded.lock().expect("updater lock poisoned").take();
    let (Some(update), Some(bytes)) = (update, bytes) else {
        return Err(AppError::Update("The update has not been downloaded yet.".into()));
    };
    update.install(bytes).map_err(update_err)?;
    app.restart()
}
