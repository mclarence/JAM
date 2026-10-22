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
        AppError::Network(e.to_string())
    }
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
