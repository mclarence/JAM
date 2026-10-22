use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not connected. Configure the JIRA connection in Settings.")]
    NotConnected,
    #[error("{message}")]
    Http { status: u16, message: String },
    #[error("Network error: {0}")]
    Network(String),
    #[error("{0}")]
    Certificate(String),
    #[error("{0}")]
    ProxyAuth(String),
    #[error("This file is encrypted. Enter the passphrase it was exported with.")]
    PassphraseRequired,
    #[error("Incorrect passphrase, or the file is damaged.")]
    PassphraseInvalid,
    #[error("Secure storage error: {0}")]
    Keyring(String),
    #[error("{0}")]
    Invalid(String),
    #[error("File error: {0}")]
    Io(String),
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            AppError::NotConnected => "notConnected",
            AppError::Http { status: 401, .. } | AppError::Http { status: 403, .. } => "unauthorized",
            AppError::Http { .. } => "http",
            AppError::Network(_) => "network",
            AppError::Certificate(_) => "certificate",
            AppError::ProxyAuth(_) => "proxyAuth",
            AppError::PassphraseRequired => "passphraseRequired",
            AppError::PassphraseInvalid => "passphraseInvalid",
            AppError::Keyring(_) => "keyring",
            AppError::Invalid(_) => "invalid",
            AppError::Io(_) => "io",
        }
    }

    fn status(&self) -> Option<u16> {
        match self {
            AppError::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("status", &self.status())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        // reqwest's Display omits the cause, which is where TLS failures are reported.
        let mut detail = e.to_string();
        let mut source = std::error::Error::source(&e);
        while let Some(s) = source {
            detail.push_str(": ");
            detail.push_str(&s.to_string());
            source = s.source();
        }
        let lower = detail.to_ascii_lowercase();
        if lower.contains("certificate") || lower.contains("unknownissuer") || lower.contains("invalid peer") {
            return AppError::Certificate(format!(
                "The server's TLS certificate is not trusted (a web filter may be inspecting HTTPS traffic). \
                 Install the filter's root CA in your OS certificate store, or enable \"Ignore certificate errors\" under Advanced. ({detail})"
            ));
        }
        AppError::Network(detail)
    }
}

/// A web filter's login or block page comes back as HTML (or 407) instead of the JSON API response.
pub fn proxy_block(status: u16, content_type: Option<&str>) -> Option<AppError> {
    let html = content_type.is_some_and(|c| c.to_ascii_lowercase().contains("text/html"));
    if status == 407 || (html && (status < 400 || status == 403)) {
        return Some(AppError::ProxyAuth(
            "Your web proxy is asking you to sign in (or blocked the request). Use \"Sign in to web proxy\" in Settings > Connection."
                .into(),
        ));
    }
    None
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Keyring(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
