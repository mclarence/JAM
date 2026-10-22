use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};

pub const FORMAT: &str = "jira-assets-manager-settings";
const VERSION: u32 = 1;
// Binds the ciphertext to this file format so it cannot be replayed as something else.
const AAD: &[u8] = b"jira-assets-manager-settings:v1";

const M_COST_KIB: u32 = 64 * 1024;
const T_COST: u32 = 3;
const P_COST: u32 = 1;
// Upper bounds protect against a crafted file that asks for an enormous key derivation.
const MAX_M_COST_KIB: u32 = 256 * 1024;
const MAX_T_COST: u32 = 10;
const MAX_P_COST: u32 = 4;

pub const MIN_PASSPHRASE_CHARS: usize = 8;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    format: String,
    version: u32,
    encrypted: bool,
    kdf: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

pub fn is_envelope(v: &Value) -> bool {
    v.get("encrypted").and_then(Value::as_bool) == Some(true)
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn derive_key(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> AppResult<Zeroizing<[u8; 32]>> {
    let params = Params::new(m, t, p, Some(32)).map_err(|e| AppError::Invalid(format!("Invalid key parameters: {e}")))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|e| AppError::Invalid(format!("Key derivation failed: {e}")))?;
    Ok(key)
}

fn random<const N: usize>() -> AppResult<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| AppError::Invalid(format!("Could not generate random bytes: {e}")))?;
    Ok(buf)
}

/// Encrypts `plaintext` with a passphrase-derived key and returns the JSON envelope.
pub fn encrypt(plaintext: &[u8], passphrase: &str) -> AppResult<String> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(AppError::Invalid(format!(
            "The passphrase must be at least {MIN_PASSPHRASE_CHARS} characters long."
        )));
    }
    let salt = random::<SALT_LEN>()?;
    let nonce = random::<NONCE_LEN>()?;
    let key = derive_key(passphrase, &salt, M_COST_KIB, T_COST, P_COST)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|e| AppError::Invalid(e.to_string()))?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: AAD })
        .map_err(|_| AppError::Invalid("Encryption failed".into()))?;
    let envelope = Envelope {
        format: FORMAT.into(),
        version: VERSION,
        encrypted: true,
        kdf: "argon2id".into(),
        m_cost: M_COST_KIB,
        t_cost: T_COST,
        p_cost: P_COST,
        salt: b64().encode(salt),
        nonce: b64().encode(nonce),
        ciphertext: b64().encode(ciphertext),
    };
    serde_json::to_string_pretty(&envelope).map_err(|e| AppError::Invalid(e.to_string()))
}

pub fn decrypt(envelope: &Value, passphrase: &str) -> AppResult<Vec<u8>> {
    let malformed = || AppError::Invalid("The encrypted file is malformed.".into());
    let env: Envelope = serde_json::from_value(envelope.clone()).map_err(|_| malformed())?;
    if env.format != FORMAT || env.kdf != "argon2id" {
        return Err(malformed());
    }
    if env.version > VERSION {
        return Err(AppError::Invalid(
            "This export was created by a newer version of the app. Update the app and try again.".into(),
        ));
    }
    if env.m_cost > MAX_M_COST_KIB || env.t_cost > MAX_T_COST || env.p_cost > MAX_P_COST {
        return Err(malformed());
    }
    let salt = b64().decode(&env.salt).map_err(|_| malformed())?;
    let nonce = b64().decode(&env.nonce).map_err(|_| malformed())?;
    let ciphertext = b64().decode(&env.ciphertext).map_err(|_| malformed())?;
    if nonce.len() != NONCE_LEN || salt.len() < 8 {
        return Err(malformed());
    }
    let key = derive_key(passphrase, &salt, env.m_cost, env.t_cost, env.p_cost)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|e| AppError::Invalid(e.to_string()))?;
    cipher
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: &ciphertext, aad: AAD })
        .map_err(|_| AppError::PassphraseInvalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_wrong_passphrase() {
        let env = encrypt(b"{\"secret\":\"token\"}", "correct horse").unwrap();
        assert!(!env.contains("token"));
        let v: Value = serde_json::from_str(&env).unwrap();
        assert!(is_envelope(&v));
        assert_eq!(decrypt(&v, "correct horse").unwrap(), b"{\"secret\":\"token\"}");
        assert!(matches!(decrypt(&v, "wrong passphrase"), Err(AppError::PassphraseInvalid)));
    }

    #[test]
    fn rejects_short_passphrase_and_tampering() {
        assert!(encrypt(b"x", "short").is_err());
        let env = encrypt(b"hello", "long enough pass").unwrap();
        let mut v: Value = serde_json::from_str(&env).unwrap();
        let ct = v["ciphertext"].as_str().unwrap().to_string();
        let mut bytes = b64().decode(ct).unwrap();
        bytes[0] ^= 1;
        v["ciphertext"] = Value::String(b64().encode(bytes));
        assert!(matches!(decrypt(&v, "long enough pass"), Err(AppError::PassphraseInvalid)));
    }
}
