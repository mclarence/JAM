use std::time::Duration;

use reqwest::cookie::Jar;
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::connection::{normalize_site, AppState, NetworkOptions};
use crate::error::{AppError, AppResult};

// No capability grants this label IPC access, so the remote login pages cannot call app commands.
const LOGIN_LABEL: &str = "proxy-login";
const API_GATEWAY: &str = "https://api.atlassian.com/";

fn parse_site(site_url: &str) -> AppResult<Url> {
    normalize_site(site_url)?
        .parse()
        .map_err(|_| AppError::Invalid("Invalid site URL".into()))
}

fn window_err(e: tauri::Error) -> AppError {
    AppError::Invalid(format!("Sign-in window error: {e}"))
}

#[tauri::command]
pub fn get_network_options(state: State<'_, AppState>) -> NetworkOptions {
    state.network()
}

#[tauri::command]
pub fn set_network_options(state: State<'_, AppState>, options: NetworkOptions) -> AppResult<()> {
    state.apply_network(options)
}

/// Opens a browser window so the user can complete the web filter's login page / SAML SSO.
#[tauri::command]
pub async fn proxy_sign_in_start(app: AppHandle, site_url: String) -> AppResult<()> {
    let site = parse_site(&site_url)?;
    if let Some(existing) = app.get_webview_window(LOGIN_LABEL) {
        existing.navigate(site).map_err(window_err)?;
        existing.set_focus().map_err(window_err)?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(site))
        .title("Sign in to your web proxy, then click Finish in JAM")
        .inner_size(1000.0, 760.0)
        .build()
        .map_err(window_err)?;
    Ok(())
}

fn copy_cookies(win: &WebviewWindow, jar: &Jar, url: &Url) -> AppResult<usize> {
    let cookies = win.cookies_for_url(url.clone()).map_err(window_err)?;
    for c in &cookies {
        jar.add_cookie_str(&format!("{}={}", c.name(), c.value()), url);
    }
    Ok(cookies.len())
}

/// Copies the session cookies from the sign-in window into the HTTP client, then closes the window.
#[tauri::command]
pub async fn proxy_sign_in_finish(app: AppHandle, state: State<'_, AppState>, site_url: String) -> AppResult<usize> {
    let site = parse_site(&site_url)?;
    let gateway: Url = API_GATEWAY.parse().map_err(|_| AppError::Invalid("Invalid gateway URL".into()))?;
    let win = app
        .get_webview_window(LOGIN_LABEL)
        .ok_or_else(|| AppError::Invalid("The sign-in window is not open. Start sign-in again.".into()))?;

    // Web filters usually issue the session cookie per destination host, so load the API gateway here as well.
    win.navigate(gateway.clone()).map_err(window_err)?;

    let jar = state.jar.clone();
    let total = tauri::async_runtime::spawn_blocking(move || -> AppResult<usize> {
        let mut gateway_cookies = 0;
        for _ in 0..12 {
            std::thread::sleep(Duration::from_millis(750));
            gateway_cookies = win.cookies_for_url(gateway.clone()).map_err(window_err)?.len();
            if gateway_cookies > 0 {
                break;
            }
        }
        let site_cookies = copy_cookies(&win, &jar, &site)?;
        copy_cookies(&win, &jar, &gateway)?;
        let _ = win.close();
        Ok(site_cookies + gateway_cookies)
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))??;
    Ok(total)
}

#[tauri::command]
pub async fn proxy_sign_in_cancel(app: AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window(LOGIN_LABEL) {
        win.close().map_err(window_err)?;
    }
    Ok(())
}
