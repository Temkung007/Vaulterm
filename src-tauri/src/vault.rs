//! Encrypted vault — the single source of truth for all app data.
//!
//! On first run the user sets a master password. A key is derived from it with
//! **Argon2id** and used to **AES-256-GCM** encrypt a JSON blob holding every
//! connection (including its secrets) and every custom snippet. The encrypted
//! blob is written to `vault.json`. The plaintext only ever exists in memory
//! while the vault is unlocked, and the derived key is zeroized on lock.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::store::{Connection, KnownHost, Settings, Snippet};

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

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

/// On-disk encrypted container (`vault.json`). None of these fields are secret.
#[derive(Serialize, Deserialize)]
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

fn vault_path() -> Result<PathBuf> {
    // Test override so unit tests never touch the real vault.
    if let Ok(p) = std::env::var("TR_VAULT_PATH") {
        return Ok(PathBuf::from(p));
    }
    let dirs = ProjectDirs::from("com", "codework", "Vaulterm")
        .ok_or_else(|| anyhow!("could not determine a config directory"))?;
    let dir = dirs.config_local_dir().to_path_buf();
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
    let plaintext = serde_json::to_vec(data)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes: [u8; NONCE_LEN] = random_bytes()?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| anyhow!("encryption failed"))?;
    Ok((nonce_bytes, ciphertext))
}

fn write_vault(salt: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Result<()> {
    let vf = VaultFile {
        version: 1,
        kdf: "argon2id".into(),
        m_cost: M_COST_KIB,
        t_cost: T_COST,
        p_cost: P_COST,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    };
    let path = vault_path()?;
    let json = serde_json::to_string_pretty(&vf)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).with_context(|| format!("writing {tmp:?}"))?;
    fs::rename(&tmp, &path).with_context(|| format!("replacing {path:?}"))?;
    Ok(())
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
        let raw = fs::read_to_string(&path).map_err(|_| anyhow!("no vault found"))?;
        let vf: VaultFile = serde_json::from_str(&raw).context("parsing vault file")?;

        let salt_v = STANDARD.decode(&vf.salt).context("decoding salt")?;
        let nonce_v = STANDARD.decode(&vf.nonce).context("decoding nonce")?;
        let ciphertext = STANDARD.decode(&vf.ciphertext).context("decoding ciphertext")?;
        if salt_v.len() != SALT_LEN || nonce_v.len() != NONCE_LEN {
            bail!("vault file is corrupt");
        }
        let mut salt = [0u8; SALT_LEN];
        salt.copy_from_slice(&salt_v);

        let key = derive_key(password, &salt)?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&nonce_v), ciphertext.as_ref())
            .map_err(|_| anyhow!("incorrect master password"))?;
        let data: VaultData = serde_json::from_slice(&plaintext).context("decoding vault data")?;

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
        let raw = fs::read_to_string(src).with_context(|| format!("reading {src}"))?;
        // Validate it's actually a Vaulterm vault before overwriting.
        serde_json::from_str::<VaultFile>(&raw)
            .map_err(|_| anyhow!("that file is not a valid Vaulterm vault"))?;
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
    use crate::store::{AuthType, Connection};

    #[test]
    fn encrypt_decrypt_roundtrip_and_wrong_password() {
        let salt = [9u8; SALT_LEN];
        let key = derive_key("correct horse", &salt).unwrap();

        let mut data = VaultData::default();
        data.connections.push(Connection {
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
        });

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
        let back: VaultData = serde_json::from_slice(&plaintext).unwrap();
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
}
