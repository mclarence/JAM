//! Encryption for settings sync (docs/sync-protocol.md). Separate from the backup format in `crypto.rs`.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};

pub const VAULT_FORMAT: &str = "jam-sync-vault";
pub const BATCH_FORMAT: &str = "jam-sync-batch";
pub const PROTOCOL_VERSION: u32 = 1;

pub const KDF_MEM_KIB: u32 = 64 * 1024;
pub const KDF_ITERATIONS: u32 = 3;
const MAX_MEM_KIB: u32 = 256 * 1024;
const MIN_MEM_KIB: u32 = 8 * 1024;
const MAX_ITERATIONS: u32 = 10;

pub const MIN_PASSWORD_SCALARS: usize = 8;
pub const MAX_PASSWORD_BYTES: usize = 1024;
pub const MAX_ENVELOPE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PLAINTEXT_BYTES: usize = 4 * 1024 * 1024;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;
const ID_LEN: usize = 16;

pub type Key = Zeroizing<[u8; KEY_LEN]>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub alg: String,
    pub mem_ki_b: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Sealed {
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultDescriptor {
    pub format: String,
    pub version: u32,
    pub generation_id: String,
    pub created_at: String,
    pub kdf: KdfParams,
    pub wrap: Sealed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchEnvelope {
    pub format: String,
    pub version: u32,
    pub generation_id: String,
    pub scope: String,
    pub batch_id: String,
    pub nonce: String,
    pub ciphertext: String,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn malformed(what: &str) -> AppError {
    AppError::Invalid(format!("The sync {what} is malformed."))
}

pub fn random<const N: usize>() -> AppResult<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| AppError::Invalid(format!("Could not generate random bytes: {e}")))?;
    Ok(buf)
}

/// 128-bit random identifier as 32 lowercase hex characters.
pub fn random_id() -> AppResult<String> {
    Ok(hex(&random::<ID_LEN>()?))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn is_id(s: &str) -> bool {
    s.len() == ID_LEN * 2 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn is_scope(s: &str) -> bool {
    (1..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase())
}

pub fn validate_new_password(password: &str) -> AppResult<()> {
    if password.chars().count() < MIN_PASSWORD_SCALARS {
        return Err(AppError::Invalid(format!(
            "The sync password must be at least {MIN_PASSWORD_SCALARS} characters long."
        )));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(AppError::Invalid("The sync password is too long.".into()));
    }
    Ok(())
}

fn decode_exact<const N: usize>(s: &str, what: &str) -> AppResult<[u8; N]> {
    let bytes = b64().decode(s).map_err(|_| malformed(what))?;
    bytes.try_into().map_err(|_| malformed(what))
}

pub fn vault_aad(generation_id: &str) -> Vec<u8> {
    format!("jam-sync:v1:vault-key:{generation_id}").into_bytes()
}

pub fn batch_aad(generation_id: &str, scope: &str, batch_id: &str) -> Vec<u8> {
    format!("jam-sync:v1:batch:{generation_id}:{scope}:{batch_id}").into_bytes()
}

pub fn derive_wrap_key(password: &str, salt: &[u8], mem_kib: u32, iterations: u32) -> AppResult<Key> {
    let params = Params::new(mem_kib, iterations, 1, Some(KEY_LEN))
        .map_err(|e| AppError::Invalid(format!("Invalid key parameters: {e}")))?;
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|e| AppError::Invalid(format!("Key derivation failed: {e}")))?;
    Ok(key)
}

pub fn seal(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], aad: &[u8], plaintext: &[u8]) -> AppResult<Vec<u8>> {
    XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .map_err(|_| AppError::Invalid("Encryption failed".into()))
}

pub fn open(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], aad: &[u8], ciphertext: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad })
        .ok()
        .map(Zeroizing::new)
}

/// Builds a vault descriptor from explicit inputs (used directly by the cross-platform test vectors).
pub fn wrap_vault(
    password: &str,
    generation_id: &str,
    created_at: &str,
    salt: &[u8; SALT_LEN],
    nonce: &[u8; NONCE_LEN],
    data_key: &[u8; KEY_LEN],
) -> AppResult<VaultDescriptor> {
    let wrap_key = derive_wrap_key(password, salt, KDF_MEM_KIB, KDF_ITERATIONS)?;
    let ciphertext = seal(&wrap_key, nonce, &vault_aad(generation_id), data_key)?;
    Ok(VaultDescriptor {
        format: VAULT_FORMAT.into(),
        version: PROTOCOL_VERSION,
        generation_id: generation_id.into(),
        created_at: created_at.into(),
        kdf: KdfParams {
            alg: "argon2id13".into(),
            mem_ki_b: KDF_MEM_KIB,
            iterations: KDF_ITERATIONS,
            parallelism: 1,
            salt: b64().encode(salt),
        },
        wrap: Sealed { nonce: b64().encode(nonce), ciphertext: b64().encode(ciphertext) },
    })
}

/// Creates a new vault generation with a fresh random data key.
pub fn create_vault(password: &str, created_at: &str) -> AppResult<(VaultDescriptor, Key)> {
    validate_new_password(password)?;
    let data_key: Key = Zeroizing::new(random::<KEY_LEN>()?);
    let desc = wrap_vault(password, &random_id()?, created_at, &random()?, &random()?, &data_key)?;
    Ok((desc, data_key))
}

pub fn parse_vault(bytes: &[u8]) -> AppResult<VaultDescriptor> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(malformed("vault"));
    }
    let desc: VaultDescriptor = serde_json::from_slice(bytes).map_err(|_| malformed("vault"))?;
    if desc.format != VAULT_FORMAT {
        return Err(malformed("vault"));
    }
    if desc.version > PROTOCOL_VERSION {
        return Err(AppError::Invalid(
            "The sync data was created by a newer version of the app. Update this app to continue syncing.".into(),
        ));
    }
    if desc.version != PROTOCOL_VERSION || !is_id(&desc.generation_id) {
        return Err(malformed("vault"));
    }
    Ok(desc)
}

/// Decrypts the vault data key. A wrong password and a tampered descriptor are indistinguishable.
pub fn unlock_vault(desc: &VaultDescriptor, password: &str) -> AppResult<Key> {
    let k = &desc.kdf;
    if k.alg != "argon2id13"
        || k.parallelism != 1
        || !(MIN_MEM_KIB..=MAX_MEM_KIB).contains(&k.mem_ki_b)
        || !(1..=MAX_ITERATIONS).contains(&k.iterations)
    {
        return Err(malformed("vault"));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(AppError::PassphraseInvalid);
    }
    let salt = decode_exact::<SALT_LEN>(&k.salt, "vault")?;
    let nonce = decode_exact::<NONCE_LEN>(&desc.wrap.nonce, "vault")?;
    let ciphertext = b64().decode(&desc.wrap.ciphertext).map_err(|_| malformed("vault"))?;
    let wrap_key = derive_wrap_key(password, &salt, k.mem_ki_b, k.iterations)?;
    let plain = open(&wrap_key, &nonce, &vault_aad(&desc.generation_id), &ciphertext).ok_or(AppError::PassphraseInvalid)?;
    let key: [u8; KEY_LEN] = plain.as_slice().try_into().map_err(|_| malformed("vault"))?;
    Ok(Zeroizing::new(key))
}

pub fn seal_batch_with_nonce(
    data_key: &[u8; KEY_LEN],
    generation_id: &str,
    scope: &str,
    batch_id: &str,
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
) -> AppResult<BatchEnvelope> {
    if !is_scope(scope) || !is_id(batch_id) || !is_id(generation_id) {
        return Err(AppError::Invalid("Invalid sync batch identifiers.".into()));
    }
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(AppError::Invalid("These settings are too large to sync in one batch.".into()));
    }
    let ciphertext = seal(data_key, nonce, &batch_aad(generation_id, scope, batch_id), plaintext)?;
    Ok(BatchEnvelope {
        format: BATCH_FORMAT.into(),
        version: PROTOCOL_VERSION,
        generation_id: generation_id.into(),
        scope: scope.into(),
        batch_id: batch_id.into(),
        nonce: b64().encode(nonce),
        ciphertext: b64().encode(ciphertext),
    })
}

pub fn seal_batch(data_key: &[u8; KEY_LEN], generation_id: &str, scope: &str, batch_id: &str, plaintext: &[u8]) -> AppResult<BatchEnvelope> {
    seal_batch_with_nonce(data_key, generation_id, scope, batch_id, &random()?, plaintext)
}

/// Decrypts a batch, checking that it belongs to the expected generation/scope/ID (also bound by the AAD).
pub fn open_batch(
    data_key: &[u8; KEY_LEN],
    bytes: &[u8],
    generation_id: &str,
    scope: &str,
    batch_id: &str,
) -> AppResult<Zeroizing<Vec<u8>>> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(malformed("batch"));
    }
    let env: BatchEnvelope = serde_json::from_slice(bytes).map_err(|_| malformed("batch"))?;
    if env.format != BATCH_FORMAT {
        return Err(malformed("batch"));
    }
    if env.version > PROTOCOL_VERSION {
        return Err(AppError::Invalid(
            "The sync data was created by a newer version of the app. Update this app to continue syncing.".into(),
        ));
    }
    if env.version != PROTOCOL_VERSION || env.generation_id != generation_id || env.scope != scope || env.batch_id != batch_id {
        return Err(malformed("batch"));
    }
    let nonce = decode_exact::<NONCE_LEN>(&env.nonce, "batch")?;
    let ciphertext = b64().decode(&env.ciphertext).map_err(|_| malformed("batch"))?;
    let plain = open(data_key, &nonce, &batch_aad(generation_id, scope, batch_id), &ciphertext)
        .ok_or_else(|| AppError::Invalid("A sync batch failed authentication (it may be damaged or tampered with).".into()))?;
    if plain.len() > MAX_PLAINTEXT_BYTES {
        return Err(malformed("batch"));
    }
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/sync/crypto-vectors.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json")
    }

    fn bytes<const N: usize>(v: &Value) -> [u8; N] {
        b64().decode(v.as_str().unwrap()).unwrap().try_into().unwrap()
    }

    #[test]
    fn matches_shared_vectors() {
        let f = fixture();
        let password = f["password"].as_str().unwrap();
        let gen = f["generationId"].as_str().unwrap();
        let data_key: [u8; 32] = bytes(&f["dataKey"]);
        let desc = wrap_vault(password, gen, f["createdAt"].as_str().unwrap(), &bytes(&f["salt"]), &bytes(&f["wrapNonce"]), &data_key).unwrap();
        let expected: VaultDescriptor = serde_json::from_value(f["vault"].clone()).unwrap();
        assert_eq!(desc, expected);
        assert_eq!(unlock_vault(&expected, password).unwrap().as_ref(), &data_key);

        let b = &f["batch"];
        let env = seal_batch_with_nonce(
            &data_key,
            gen,
            b["scope"].as_str().unwrap(),
            b["batchId"].as_str().unwrap(),
            &bytes(&b["nonce"]),
            b["plaintext"].as_str().unwrap().as_bytes(),
        )
        .unwrap();
        let expected: BatchEnvelope = serde_json::from_value(b["envelope"].clone()).unwrap();
        assert_eq!(env, expected);
    }

    #[test]
    fn rejects_wrong_password_and_tampering() {
        let f = fixture();
        let vault: VaultDescriptor = serde_json::from_value(f["vault"].clone()).unwrap();
        assert!(matches!(unlock_vault(&vault, "wrong password 1234"), Err(AppError::PassphraseInvalid)));

        let mut moved = vault.clone();
        moved.generation_id = "0".repeat(32);
        assert!(matches!(unlock_vault(&moved, f["password"].as_str().unwrap()), Err(AppError::PassphraseInvalid)));

        let mut huge = vault.clone();
        huge.kdf.mem_ki_b = MAX_MEM_KIB + 1;
        assert!(matches!(unlock_vault(&huge, f["password"].as_str().unwrap()), Err(AppError::Invalid(_))));
        let mut par = vault;
        par.kdf.parallelism = 2;
        assert!(matches!(unlock_vault(&par, f["password"].as_str().unwrap()), Err(AppError::Invalid(_))));

        let key: [u8; 32] = bytes(&f["dataKey"]);
        let b = &f["batch"];
        let gen = f["generationId"].as_str().unwrap();
        let (scope, id) = (b["scope"].as_str().unwrap(), b["batchId"].as_str().unwrap());
        let raw = serde_json::to_vec(&b["envelope"]).unwrap();
        let plain = open_batch(&key, &raw, gen, scope, id).unwrap();
        assert_eq!(plain.as_slice(), b["plaintext"].as_str().unwrap().as_bytes());
        // A batch relabelled as another scope must not authenticate.
        let mut relabelled = b["envelope"].clone();
        relabelled["scope"] = "desktop".into();
        let raw = serde_json::to_vec(&relabelled).unwrap();
        assert!(open_batch(&key, &raw, gen, "desktop", id).is_err());
        let mut newer = b["envelope"].clone();
        newer["version"] = 2.into();
        let err = open_batch(&key, &serde_json::to_vec(&newer).unwrap(), gen, scope, id).unwrap_err();
        assert!(err.to_string().contains("newer version"));
    }

    #[test]
    fn password_rules_count_unicode_scalars() {
        assert!(validate_new_password("1234567").is_err());
        assert!(validate_new_password("12345678").is_ok());
        // 8 emoji: 8 scalars, 32 bytes.
        assert!(validate_new_password(&"🔐".repeat(8)).is_ok());
        assert!(validate_new_password(&"é".repeat(7)).is_err());
        assert!(validate_new_password(&"a".repeat(MAX_PASSWORD_BYTES + 1)).is_err());
    }

    #[test]
    fn round_trip_random_vault() {
        let (desc, key) = create_vault("12345678", "2026-01-01T00:00:00Z").unwrap();
        let parsed = parse_vault(&serde_json::to_vec(&desc).unwrap()).unwrap();
        assert_eq!(unlock_vault(&parsed, "12345678").unwrap().as_ref(), key.as_ref());
        let id = random_id().unwrap();
        let env = seal_batch(&key, &desc.generation_id, "shared", &id, b"{}").unwrap();
        let raw = serde_json::to_vec(&env).unwrap();
        assert_eq!(open_batch(&key, &raw, &desc.generation_id, "shared", &id).unwrap().as_slice(), b"{}");
    }

    /// Prints a fresh vector set; run with `cargo test print_vectors -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_vectors() {
        let password = "Pässwörd 🔐 with spaces";
        let gen = "0123456789abcdef0123456789abcdef";
        let created = "2026-01-01T00:00:00Z";
        let salt = [7u8; 16];
        let wrap_nonce = [9u8; 24];
        let key = [42u8; 32];
        let desc = wrap_vault(password, gen, created, &salt, &wrap_nonce, &key).unwrap();
        let plaintext = r#"{"format":"jam-sync-changes","version":1,"deviceId":"fedcba9876543210fedcba9876543210","platform":"desktop","createdAt":"2026-01-01T00:00:00Z","records":[{"key":"theme","versionId":"00112233445566778899aabbccddeeff","parents":[],"deleted":false,"value":"dark"}]}"#;
        let batch_id = "ffeeddccbbaa99887766554433221100";
        let nonce = [3u8; 24];
        let env = seal_batch_with_nonce(&key, gen, "shared", batch_id, &nonce, plaintext.as_bytes()).unwrap();
        let out = serde_json::json!({
            "password": password, "generationId": gen, "createdAt": created,
            "salt": b64().encode(salt), "wrapNonce": b64().encode(wrap_nonce), "dataKey": b64().encode(key),
            "vault": desc,
            "batch": {"scope": "shared", "batchId": batch_id, "nonce": b64().encode(nonce), "plaintext": plaintext, "envelope": env},
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap());
    }
}
