//! Encrypted vault — the single source of truth for all app data.
//!
//! On first run the user sets a master password. A key is derived from it with
//! **Argon2id** and used to **AES-256-GCM** encrypt a **protobuf** blob holding
//! every connection (including its secrets) and every custom snippet. The
//! ciphertext, salt and nonce are wrapped in a protobuf container (see
//! `vault_pb`) written to `vault.json`. The plaintext only ever exists in memory
//! while the vault is unlocked, and the derived key is zeroized on lock.
//!
//! Vaults written by older builds used a JSON container + JSON payload; `unlock`
//! transparently reads those and rewrites them in the protobuf format.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine as _};
#[cfg(desktop)]
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::store::{Connection, KnownHost, Settings, Snippet};
use crate::vault_pb::{VaultDataPb, VaultFilePb};
use prost::Message as _;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// On-disk vault format version written into every new/rewritten vault. `2` is
/// the protobuf container; version `1` was the legacy JSON envelope, which
/// `unlock` still reads (and migrates) but never writes.
const VAULT_FORMAT_VERSION: u32 = 2;

// Argon2id cost parameters. ~64 MiB / 3 passes is a comfortable desktop unlock
// (a few hundred ms) while being expensive to brute-force.
const M_COST_KIB: u32 = 65536;
const T_COST: u32 = 3;
const P_COST: u32 = 1;

/// Everything stored in the vault.
#[derive(Default, Serialize, Deserialize)]
pub struct VaultData {
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub known_hosts: Vec<KnownHost>,
    #[serde(default)]
    pub settings: Settings,
}

/// **Legacy** JSON container from vaults written before the protobuf migration.
/// Kept only so `unlock`/`import_from` can still read (and migrate) old files;
/// new vaults use `VaultFilePb`. Only `salt`/`nonce`/`ciphertext` are consumed —
/// the KDF params were always the hardcoded constants, never read back.
#[derive(Deserialize)]
#[allow(dead_code)]
struct VaultFile {
    version: u32,
    kdf: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

/// In-memory unlocked state.
struct Unlocked {
    key: Zeroizing<[u8; KEY_LEN]>,
    salt: [u8; SALT_LEN],
    data: VaultData,
}

/// Thread-safe vault handle held in Tauri state. `None` == locked.
#[derive(Default)]
pub struct Vault {
    inner: Mutex<Option<Unlocked>>,
}

/// On mobile there is no per-user config dir; the app's sandbox path is resolved
/// once at startup (see `lib.rs` setup hook) and stashed here for `vault_path()`.
#[cfg(mobile)]
static MOBILE_BASE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Record the sandbox directory the mobile vault lives in. Called from the Tauri
/// setup hook with `app.path().app_config_dir()`.
#[cfg(mobile)]
pub fn set_base_dir(dir: PathBuf) {
    let _ = MOBILE_BASE.set(dir);
}

fn vault_path() -> Result<PathBuf> {
    // Test override so unit tests never touch the real vault.
    if let Ok(p) = std::env::var("TR_VAULT_PATH") {
        return Ok(PathBuf::from(p));
    }

    // Mobile: use the app sandbox dir resolved at startup via Tauri's path API.
    #[cfg(mobile)]
    let dir = MOBILE_BASE
        .get()
        .cloned()
        .ok_or_else(|| anyhow!("app config directory not initialized"))?;

    // Desktop: keep the existing per-user config location so shipped vaults stay
    // exactly where they are.
    #[cfg(desktop)]
    let dir = ProjectDirs::from("com", "codework", "Vaulterm")
        .ok_or_else(|| anyhow!("could not determine a config directory"))?
        .config_local_dir()
        .to_path_buf();

    fs::create_dir_all(&dir).with_context(|| format!("creating {dir:?}"))?;
    Ok(dir.join("vault.json"))
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).map_err(|e| anyhow!("secure RNG failed: {e}"))?;
    Ok(buf)
}

fn derive_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>> {
    let params = Params::new(M_COST_KIB, T_COST, P_COST, Some(KEY_LEN))
        .map_err(|e| anyhow!("argon2 params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key[..])
        .map_err(|e| anyhow!("key derivation failed: {e}"))?;
    Ok(key)
}

fn encrypt(key: &[u8], data: &VaultData) -> Result<([u8; NONCE_LEN], Vec<u8>)> {
    let plaintext = VaultDataPb::from(data).encode_to_vec();
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes: [u8; NONCE_LEN] = random_bytes()?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| anyhow!("encryption failed"))?;
    Ok((nonce_bytes, ciphertext))
}

fn write_vault(salt: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Result<()> {
    let vf = VaultFilePb {
        version: VAULT_FORMAT_VERSION,
        kdf: "argon2id".into(),
        m_cost: M_COST_KIB,
        t_cost: T_COST,
        p_cost: P_COST,
        salt: salt.to_vec(),
        nonce: nonce.to_vec(),
        ciphertext: ciphertext.to_vec(),
    };
    let bytes = vf.encode_to_vec();
    let path = vault_path()?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &bytes).with_context(|| format!("writing {tmp:?}"))?;
    fs::rename(&tmp, &path).with_context(|| format!("replacing {path:?}"))?;
    Ok(())
}

/// AES-256-GCM decrypt shared by the protobuf and legacy-JSON unlock paths. A
/// wrong key fails the authentication tag and surfaces as "incorrect master
/// password". `nonce` must be exactly `NONCE_LEN` bytes (callers validate it).
fn decrypt(key: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| anyhow!("incorrect master password"))
}

/// A leading `{` (after optional whitespace) marks the legacy JSON envelope;
/// a protobuf container starts with a field-tag byte (`0x0a` here), never `{`,
/// so this cleanly tells the two on-disk formats apart.
fn is_legacy_json(raw: &[u8]) -> bool {
    raw.iter()
        .find(|b| !b.is_ascii_whitespace())
        .map(|b| *b == b'{')
        .unwrap_or(false)
}

/// Decode + decrypt a protobuf vault container.
fn decode_protobuf(
    raw: &[u8],
    password: &str,
) -> Result<([u8; SALT_LEN], Zeroizing<[u8; KEY_LEN]>, VaultData)> {
    let vf = VaultFilePb::decode(raw).context("parsing vault file")?;
    if vf.salt.len() != SALT_LEN || vf.nonce.len() != NONCE_LEN {
        bail!("vault file is corrupt");
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&vf.salt);

    let key = derive_key(password, &salt)?;
    let plaintext = decrypt(&key[..], &vf.nonce, &vf.ciphertext)?;
    let data = VaultDataPb::decode(&plaintext[..])
        .context("decoding vault data")?
        .into();
    Ok((salt, key, data))
}

/// Decode + decrypt a legacy JSON vault container (base64 fields, JSON payload).
fn decode_legacy_json(
    raw: &[u8],
    password: &str,
) -> Result<([u8; SALT_LEN], Zeroizing<[u8; KEY_LEN]>, VaultData)> {
    let text = std::str::from_utf8(raw).context("parsing vault file")?;
    let vf: VaultFile = serde_json::from_str(text).context("parsing vault file")?;

    let salt_v = STANDARD.decode(&vf.salt).context("decoding salt")?;
    let nonce_v = STANDARD.decode(&vf.nonce).context("decoding nonce")?;
    let ciphertext = STANDARD.decode(&vf.ciphertext).context("decoding ciphertext")?;
    if salt_v.len() != SALT_LEN || nonce_v.len() != NONCE_LEN {
        bail!("vault file is corrupt");
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&salt_v);

    let key = derive_key(password, &salt)?;
    let plaintext = decrypt(&key[..], &nonce_v, &ciphertext)?;
    let data: VaultData = serde_json::from_slice(&plaintext).context("decoding vault data")?;
    Ok((salt, key, data))
}

impl Vault {
    /// Whether a vault file already exists on disk (i.e. not first run).
    pub fn exists() -> bool {
        vault_path().map(|p| p.exists()).unwrap_or(false)
    }

    pub fn is_unlocked(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    /// First-run: set the master password and write an empty encrypted vault.
    pub fn create(&self, password: &str) -> Result<()> {
        if Vault::exists() {
            bail!("a vault already exists on this machine");
        }
        if password.is_empty() {
            bail!("master password must not be empty");
        }
        let salt: [u8; SALT_LEN] = random_bytes()?;
        let key = derive_key(password, &salt)?;
        let data = VaultData::default();
        let (nonce, ciphertext) = encrypt(&key[..], &data)?;
        write_vault(&salt, &nonce, &ciphertext)?;
        *self.inner.lock().unwrap() = Some(Unlocked { key, salt, data });
        Ok(())
    }

    /// Decrypt the vault with the master password. A wrong password fails the
    /// AES-GCM authentication tag and surfaces as "incorrect master password".
    pub fn unlock(&self, password: &str) -> Result<()> {
        let path = vault_path()?;
        let raw = fs::read(&path).map_err(|_| anyhow!("no vault found"))?;

        let legacy = is_legacy_json(&raw);
        let (salt, key, data) = if legacy {
            decode_legacy_json(&raw, password)?
        } else {
            decode_protobuf(&raw, password)?
        };

        // Transparently migrate a legacy JSON vault to the protobuf format now
        // that we hold the derived key — same salt and password, new container.
        if legacy {
            let (nonce, ciphertext) = encrypt(&key[..], &data)?;
            write_vault(&salt, &nonce, &ciphertext)?;
        }

        *self.inner.lock().unwrap() = Some(Unlocked { key, salt, data });
        Ok(())
    }

    /// Re-lock: drop the decrypted data and zeroize the key.
    pub fn lock(&self) {
        *self.inner.lock().unwrap() = None;
    }

    /// Change the master password: verify `current`, then re-key the vault with
    /// a fresh salt derived from `new` and re-encrypt. Must be unlocked.
    pub fn change_password(&self, current: &str, new: &str) -> Result<()> {
        if new.is_empty() {
            bail!("new master password must not be empty");
        }
        let mut guard = self.inner.lock().unwrap();
        let u = guard.as_mut().ok_or_else(|| anyhow!("the vault is locked"))?;

        // Verify the current password by re-deriving the key with the stored salt.
        let check = derive_key(current, &u.salt)?;
        if check[..] != u.key[..] {
            bail!("current master password is incorrect");
        }

        let new_salt: [u8; SALT_LEN] = random_bytes()?;
        let new_key = derive_key(new, &new_salt)?;
        let (nonce, ciphertext) = encrypt(&new_key[..], &u.data)?;
        write_vault(&new_salt, &nonce, &ciphertext)?;
        u.key = new_key;
        u.salt = new_salt;
        Ok(())
    }

    /// Back up the (already-encrypted) vault file to `dest`. Safe to store
    /// anywhere — it still needs the master password to open.
    pub fn export_to(&self, dest: &str) -> Result<()> {
        let src = vault_path()?;
        if !src.exists() {
            bail!("there is no vault to export yet");
        }
        fs::copy(&src, dest).with_context(|| format!("exporting vault to {dest}"))?;
        Ok(())
    }

    /// Replace the current vault with a backup file, then lock. The user must
    /// unlock with the *backup's* master password afterwards.
    pub fn import_from(&self, src: &str) -> Result<()> {
        let raw = fs::read(src).with_context(|| format!("reading {src}"))?;
        // Validate it's actually a Vaulterm vault (either format) before overwriting.
        let valid = if is_legacy_json(&raw) {
            std::str::from_utf8(&raw)
                .ok()
                .and_then(|t| serde_json::from_str::<VaultFile>(t).ok())
                .is_some()
        } else {
            VaultFilePb::decode(&raw[..])
                .map(|vf| {
                    vf.salt.len() == SALT_LEN
                        && vf.nonce.len() == NONCE_LEN
                        && !vf.ciphertext.is_empty()
                })
                .unwrap_or(false)
        };
        if !valid {
            bail!("that file is not a valid Vaulterm vault");
        }
        let dest = vault_path()?;
        let tmp = dest.with_extension("json.tmp");
        fs::write(&tmp, &raw).with_context(|| format!("writing {tmp:?}"))?;
        fs::rename(&tmp, &dest).with_context(|| format!("replacing {dest:?}"))?;
        *self.inner.lock().unwrap() = None; // force a re-unlock with the new password
        Ok(())
    }

    /// Read the decrypted data. Errors if locked.
    pub fn read<R>(&self, f: impl FnOnce(&VaultData) -> R) -> Result<R> {
        let guard = self.inner.lock().unwrap();
        let u = guard.as_ref().ok_or_else(|| anyhow!("the vault is locked"))?;
        Ok(f(&u.data))
    }

    /// Mutate the decrypted data and persist (re-encrypt) it. Errors if locked.
    pub fn write<R>(&self, f: impl FnOnce(&mut VaultData) -> R) -> Result<R> {
        let mut guard = self.inner.lock().unwrap();
        let u = guard.as_mut().ok_or_else(|| anyhow!("the vault is locked"))?;
        let result = f(&mut u.data);
        let (nonce, ciphertext) = encrypt(&u.key[..], &u.data)?;
        write_vault(&u.salt, &nonce, &ciphertext)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{AuthType, ConnAction, Connection, KnownHost, Settings, Snippet};

    // Serialize tests that mutate the process-wide TR_VAULT_PATH env var so they
    // don't race one another (env vars are shared across the test threads).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A sample password-auth connection carrying a secret, reused by tests.
    fn sample_connection() -> Connection {
        Connection {
            id: "1".into(),
            name: "prod".into(),
            host: "secret-host.internal".into(),
            port: 22,
            username: "root".into(),
            auth_type: AuthType::Password,
            key_path: None,
            jump: None,
            group: None,
            favorite: false,
            color: None,
            startup_commands: None,
            actions: None,
            secret: Some("s3cr3t-password".into()),
            key_text: None,
        }
    }

    #[test]
    fn encrypt_decrypt_roundtrip_and_wrong_password() {
        let salt = [9u8; SALT_LEN];
        let key = derive_key("correct horse", &salt).unwrap();

        let mut data = VaultData::default();
        data.connections.push(sample_connection());

        let (nonce, ciphertext) = encrypt(&key[..], &data).unwrap();

        // Ciphertext must not leak plaintext (host or password).
        assert!(!leaks(&ciphertext, b"secret-host.internal"));
        assert!(!leaks(&ciphertext, b"s3cr3t-password"));

        // Wrong password -> different key -> auth tag fails.
        let wrong = derive_key("wrong password", &salt).unwrap();
        let wrong_cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&wrong[..]));
        assert!(wrong_cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .is_err());

        // Right password decrypts and round-trips the data.
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .unwrap();
        let back: VaultData = VaultDataPb::decode(&plaintext[..]).unwrap().into();
        assert_eq!(back.connections.len(), 1);
        assert_eq!(back.connections[0].secret.as_deref(), Some("s3cr3t-password"));
    }

    fn leaks(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    // Exercises the real file lifecycle (create -> write -> change password ->
    // unlock with new, old rejected) using an isolated vault path.
    #[test]
    fn change_password_rekeys_vault() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = std::env::temp_dir().join("vaulterm-selftest-vault.json");
        std::env::set_var("TR_VAULT_PATH", &path);
        let _ = std::fs::remove_file(&path);

        let v = Vault::default();
        v.create("oldpass123").unwrap();
        v.write(|d| {
            d.snippets.push(crate::store::Snippet {
                id: "1".into(),
                label: "x".into(),
                command: "echo hi".into(),
                category: "Custom".into(),
            })
        })
        .unwrap();

        v.change_password("oldpass123", "newpass456").unwrap();
        v.lock();

        assert!(v.unlock("oldpass123").is_err(), "old password must no longer work");
        assert!(
            v.change_password("nope", "x").is_err() || !v.is_unlocked(),
            "locked vault can't change password"
        );
        v.unlock("newpass456").unwrap();
        v.read(|d| assert_eq!(d.snippets.len(), 1)).unwrap();

        let _ = std::fs::remove_file(&path);
        std::env::remove_var("TR_VAULT_PATH");
    }

    // A vault written by an older build (JSON envelope + JSON payload) must still
    // open, and be rewritten in the protobuf format on first unlock.
    #[test]
    fn legacy_json_vault_unlocks_and_migrates_to_protobuf() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = std::env::temp_dir().join("vaulterm-legacy-migrate-vault.json");
        std::env::set_var("TR_VAULT_PATH", &path);
        let _ = std::fs::remove_file(&path);

        // Hand-build a legacy vault exactly as old builds did: JSON payload,
        // AES-256-GCM, JSON envelope with base64 salt/nonce/ciphertext.
        let password = "legacy-pass";
        let salt = [7u8; SALT_LEN];
        let key = derive_key(password, &salt).unwrap();

        let mut data = VaultData::default();
        data.connections.push(sample_connection());
        data.snippets.push(Snippet {
            id: "s1".into(),
            label: "hello".into(),
            command: "echo hi".into(),
            category: "Custom".into(),
        });

        let inner_json = serde_json::to_vec(&data).unwrap();
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
        let nonce = [3u8; NONCE_LEN];
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), inner_json.as_ref())
            .unwrap();
        let legacy = serde_json::json!({
            "version": 1,
            "kdf": "argon2id",
            "m_cost": M_COST_KIB,
            "t_cost": T_COST,
            "p_cost": P_COST,
            "salt": STANDARD.encode(salt),
            "nonce": STANDARD.encode(nonce),
            "ciphertext": STANDARD.encode(&ciphertext),
        });
        std::fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();
        assert!(is_legacy_json(&std::fs::read(&path).unwrap()), "fixture must be JSON");

        // Unlock reads the legacy vault and exposes its data...
        let v = Vault::default();
        v.unlock(password).unwrap();
        v.read(|d| {
            assert_eq!(d.connections.len(), 1);
            assert_eq!(d.connections[0].host, "secret-host.internal");
            assert_eq!(d.connections[0].secret.as_deref(), Some("s3cr3t-password"));
            assert_eq!(d.snippets.len(), 1);
        })
        .unwrap();

        // ...and rewrites it in place as a protobuf container (version 2).
        let raw = std::fs::read(&path).unwrap();
        assert!(!is_legacy_json(&raw), "vault should be migrated to protobuf");
        let vf = VaultFilePb::decode(&raw[..]).expect("valid protobuf container");
        assert_eq!(vf.version, VAULT_FORMAT_VERSION);
        assert_eq!(vf.salt.len(), SALT_LEN);
        assert_eq!(vf.nonce.len(), NONCE_LEN);

        // Re-unlocking now goes through the protobuf path and still works.
        v.lock();
        v.unlock(password).unwrap();
        v.read(|d| assert_eq!(d.connections[0].secret.as_deref(), Some("s3cr3t-password")))
            .unwrap();

        let _ = std::fs::remove_file(&path);
        std::env::remove_var("TR_VAULT_PATH");
    }

    // Every field survives a VaultData -> protobuf -> VaultData round trip,
    // including the Option<Vec<ConnAction>> <-> repeated collapse and enums.
    #[test]
    fn protobuf_roundtrips_all_fields() {
        let mut data = VaultData::default();
        data.connections.push(Connection {
            id: "c1".into(),
            name: "prod".into(),
            host: "10.0.0.1".into(),
            port: 2222,
            username: "root".into(),
            auth_type: AuthType::Key,
            key_path: Some("C:/keys/id".into()),
            jump: Some("c2".into()),
            group: Some("Work".into()),
            favorite: true,
            color: Some("#ff0000".into()),
            startup_commands: Some("tmux a".into()),
            actions: Some(vec![ConnAction {
                name: "deploy".into(),
                command: "./deploy.sh".into(),
            }]),
            secret: Some("pw".into()),
            key_text: Some("-----KEY-----".into()),
        });
        data.connections.push(Connection {
            id: "c2".into(),
            name: "bare".into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth_type: AuthType::KeyText,
            key_path: None,
            jump: None,
            group: None,
            favorite: false,
            color: None,
            startup_commands: None,
            actions: None,
            secret: None,
            key_text: None,
        });
        data.snippets.push(Snippet {
            id: "s1".into(),
            label: "l".into(),
            command: "cmd".into(),
            category: "Cat".into(),
        });
        data.known_hosts.push(KnownHost {
            host: "h".into(),
            port: 22,
            fingerprint: "SHA256:x".into(),
            algo: "ssh-ed25519".into(),
        });
        data.settings = Settings {
            auto_lock_minutes: 15,
            mcp_enabled: true,
            mcp_token: Some("tok".into()),
        };

        let bytes = VaultDataPb::from(&data).encode_to_vec();
        let back: VaultData = VaultDataPb::decode(&bytes[..]).unwrap().into();

        assert_eq!(back.connections.len(), 2);
        let c = &back.connections[0];
        assert_eq!(c.id, "c1");
        assert_eq!(c.port, 2222);
        assert!(matches!(c.auth_type, AuthType::Key));
        assert_eq!(c.key_path.as_deref(), Some("C:/keys/id"));
        assert_eq!(c.jump.as_deref(), Some("c2"));
        assert_eq!(c.group.as_deref(), Some("Work"));
        assert!(c.favorite);
        assert_eq!(c.color.as_deref(), Some("#ff0000"));
        assert_eq!(c.startup_commands.as_deref(), Some("tmux a"));
        assert_eq!(c.actions.as_ref().unwrap().len(), 1);
        assert_eq!(c.actions.as_ref().unwrap()[0].name, "deploy");
        assert_eq!(c.secret.as_deref(), Some("pw"));
        assert_eq!(c.key_text.as_deref(), Some("-----KEY-----"));

        let bare = &back.connections[1];
        assert!(matches!(bare.auth_type, AuthType::KeyText));
        assert!(bare.key_path.is_none());
        assert!(bare.actions.is_none(), "empty actions must decode back to None");
        assert!(bare.secret.is_none());

        assert_eq!(back.snippets[0].category, "Cat");
        assert_eq!(back.known_hosts[0].fingerprint, "SHA256:x");
        assert_eq!(back.settings.auto_lock_minutes, 15);
        assert!(back.settings.mcp_enabled);
        assert_eq!(back.settings.mcp_token.as_deref(), Some("tok"));
    }
}
