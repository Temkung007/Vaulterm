//! Shared data types. Everything here is persisted *inside* the encrypted
//! vault (see `vault.rs`); nothing in this module touches the disk directly.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    /// Password auth; secret = the password.
    Password,
    /// Public-key auth from a key file on disk; secret = key passphrase.
    Key,
    /// Public-key auth from key text pasted into the app; secret = passphrase.
    KeyText,
}

/// A saved SSH connection. Secrets (`secret`, `key_text`) live only inside the
/// encrypted vault and in memory while unlocked — they are stripped via
/// [`Connection::public`] before any copy is handed to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// Connection id of a jump host to route through (ProxyJump). None = direct.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump: Option<String>,
    // --- organization (non-secret) ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Commands to type into the shell right after connecting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_commands: Option<String>,
    /// One-click named commands to run on the server (e.g. "deploy"). Non-secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<ConnAction>>,
    /// Password or key passphrase. Never sent to the frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// Pasted private-key text (KeyText auth). Never sent to the frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_text: Option<String>,
}

/// A named command that can be run on the server in one click (e.g. "deploy").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnAction {
    pub name: String,
    pub command: String,
}

impl Connection {
    /// A copy with all secrets removed — safe to serialize to the frontend.
    pub fn public(&self) -> Connection {
        Connection {
            secret: None,
            key_text: None,
            ..self.clone()
        }
    }
}

/// A user-defined command snippet (the built-in Ubuntu pack lives in the
/// frontend; only the user's own snippets are persisted in the vault).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub category: String,
}

/// A trusted SSH host key (trust-on-first-use). Stored encrypted in the vault;
/// a later connection whose key fingerprint differs is rejected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    #[serde(default)]
    pub algo: String,
}

/// User preferences (persisted in the vault).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Lock the vault after this many minutes of inactivity (0 = never).
    #[serde(default)]
    pub auto_lock_minutes: u32,
    /// Whether the local MCP server (AI access to saved connections) is enabled.
    #[serde(default)]
    pub mcp_enabled: bool,
    /// Bearer token the MCP client must present. Generated on first enable and
    /// persisted so the client config stays valid across launches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_token: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(auth: AuthType, key_path: Option<&str>) -> Connection {
        Connection {
            id: "abc".into(),
            name: "My Server".into(),
            host: "example.com".into(),
            port: 2222,
            username: "root".into(),
            auth_type: auth,
            key_path: key_path.map(Into::into),
            jump: None,
            group: None,
            favorite: false,
            color: None,
            startup_commands: None,
            actions: None,
            secret: Some("hunter2".into()),
            key_text: None,
        }
    }

    // The frontend consumes these objects verbatim: camelCase keys, lowercase
    // auth_type, and — crucially — NO secrets.
    #[test]
    fn public_strips_secrets_and_uses_camel_case() {
        let c = conn(AuthType::Key, Some("C:/keys/id_ed25519"));
        let json = serde_json::to_string(&c.public()).unwrap();
        assert!(json.contains("\"authType\":\"key\""), "got: {json}");
        assert!(json.contains("\"keyPath\":"), "got: {json}");
        assert!(!json.contains("secret"), "secrets must not be serialized: {json}");
        assert!(!json.contains("keyText"), "secrets must not be serialized: {json}");
    }

    #[test]
    fn password_connection_omits_key_path() {
        let mut c = conn(AuthType::Password, None);
        c.secret = None;
        let json = serde_json::to_string(&c.public()).unwrap();
        assert!(!json.contains("keyPath"), "got: {json}");
        assert!(json.contains("\"authType\":\"password\""), "got: {json}");
    }
}
