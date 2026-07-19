//! Protobuf schema + codec for the encrypted vault file (`vault.json`).
//!
//! The whole vault is serialized with protobuf. [`VaultFilePb`] is the on-disk
//! container — Argon2 parameters plus `salt`/`nonce`/`ciphertext` as raw `bytes`
//! (no base64, unlike the legacy JSON envelope). [`VaultDataPb`] is the
//! plaintext blob that gets AES-256-GCM encrypted into `VaultFilePb::ciphertext`.
//!
//! These mirror `vault::VaultData` and the `store` domain types; the `From`
//! impls below convert between them, so the rest of the app keeps using the
//! serde types (which still serialize over Tauri IPC and MCP). prost derives the
//! codec from these hand-annotated structs — no `.proto` file and no `protoc`.
//!
//! Compatibility rule: field tags are permanent. Add new fields with new tags;
//! never renumber or reuse a tag, or existing vaults will decode incorrectly.

use crate::store::{AuthType, ConnAction, Connection, KnownHost, Settings, Snippet};
use crate::vault::VaultData;

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------
// NOTE: the `::prost::Message` derive also generates `Debug` and `Default`, so
// those must NOT appear in the derive list (they would collide).

/// On-disk container written to `vault.json`. None of these fields are secret.
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct VaultFilePb {
    #[prost(uint32, tag = "1")]
    pub version: u32,
    #[prost(string, tag = "2")]
    pub kdf: String,
    #[prost(uint32, tag = "3")]
    pub m_cost: u32,
    #[prost(uint32, tag = "4")]
    pub t_cost: u32,
    #[prost(uint32, tag = "5")]
    pub p_cost: u32,
    #[prost(bytes = "vec", tag = "6")]
    pub salt: Vec<u8>,
    #[prost(bytes = "vec", tag = "7")]
    pub nonce: Vec<u8>,
    #[prost(bytes = "vec", tag = "8")]
    pub ciphertext: Vec<u8>,
}

/// The plaintext vault contents (encrypted into `VaultFilePb::ciphertext`).
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct VaultDataPb {
    #[prost(message, repeated, tag = "1")]
    pub connections: Vec<ConnectionPb>,
    #[prost(message, repeated, tag = "2")]
    pub snippets: Vec<SnippetPb>,
    #[prost(message, repeated, tag = "3")]
    pub known_hosts: Vec<KnownHostPb>,
    #[prost(message, optional, tag = "4")]
    pub settings: Option<SettingsPb>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ConnectionPb {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub name: String,
    #[prost(string, tag = "3")]
    pub host: String,
    // protobuf has no u16; the port is carried as uint32 and narrowed on the way out.
    #[prost(uint32, tag = "4")]
    pub port: u32,
    #[prost(string, tag = "5")]
    pub username: String,
    #[prost(enumeration = "AuthTypePb", tag = "6")]
    pub auth_type: i32,
    #[prost(string, optional, tag = "7")]
    pub key_path: Option<String>,
    #[prost(string, optional, tag = "8")]
    pub jump: Option<String>,
    #[prost(string, optional, tag = "9")]
    pub group: Option<String>,
    #[prost(bool, tag = "10")]
    pub favorite: bool,
    #[prost(string, optional, tag = "11")]
    pub color: Option<String>,
    #[prost(string, optional, tag = "12")]
    pub startup_commands: Option<String>,
    // `Option<Vec<..>>` collapses to a plain repeated field: absent == empty.
    #[prost(message, repeated, tag = "13")]
    pub actions: Vec<ConnActionPb>,
    #[prost(string, optional, tag = "14")]
    pub secret: Option<String>,
    #[prost(string, optional, tag = "15")]
    pub key_text: Option<String>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ConnActionPb {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(string, tag = "2")]
    pub command: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct SnippetPb {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub label: String,
    #[prost(string, tag = "3")]
    pub command: String,
    #[prost(string, tag = "4")]
    pub category: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct KnownHostPb {
    #[prost(string, tag = "1")]
    pub host: String,
    #[prost(uint32, tag = "2")]
    pub port: u32,
    #[prost(string, tag = "3")]
    pub fingerprint: String,
    #[prost(string, tag = "4")]
    pub algo: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct SettingsPb {
    #[prost(uint32, tag = "1")]
    pub auto_lock_minutes: u32,
    #[prost(bool, tag = "2")]
    pub mcp_enabled: bool,
    #[prost(string, optional, tag = "3")]
    pub mcp_token: Option<String>,
}

/// proto3 enums require a zero-valued default variant, hence `Password = 0`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, ::prost::Enumeration)]
#[repr(i32)]
pub enum AuthTypePb {
    Password = 0,
    Key = 1,
    KeyText = 2,
}

// ---------------------------------------------------------------------------
// Conversions: domain (serde) <-> protobuf
// ---------------------------------------------------------------------------

impl From<AuthType> for AuthTypePb {
    fn from(a: AuthType) -> Self {
        match a {
            AuthType::Password => AuthTypePb::Password,
            AuthType::Key => AuthTypePb::Key,
            AuthType::KeyText => AuthTypePb::KeyText,
        }
    }
}

impl From<AuthTypePb> for AuthType {
    fn from(a: AuthTypePb) -> Self {
        match a {
            AuthTypePb::Password => AuthType::Password,
            AuthTypePb::Key => AuthType::Key,
            AuthTypePb::KeyText => AuthType::KeyText,
        }
    }
}

impl From<&ConnAction> for ConnActionPb {
    fn from(a: &ConnAction) -> Self {
        ConnActionPb { name: a.name.clone(), command: a.command.clone() }
    }
}

impl From<ConnActionPb> for ConnAction {
    fn from(p: ConnActionPb) -> Self {
        ConnAction { name: p.name, command: p.command }
    }
}

impl From<&Connection> for ConnectionPb {
    fn from(c: &Connection) -> Self {
        ConnectionPb {
            id: c.id.clone(),
            name: c.name.clone(),
            host: c.host.clone(),
            port: c.port as u32,
            username: c.username.clone(),
            auth_type: AuthTypePb::from(c.auth_type) as i32,
            key_path: c.key_path.clone(),
            jump: c.jump.clone(),
            group: c.group.clone(),
            favorite: c.favorite,
            color: c.color.clone(),
            startup_commands: c.startup_commands.clone(),
            actions: c.actions.iter().flatten().map(ConnActionPb::from).collect(),
            secret: c.secret.clone(),
            key_text: c.key_text.clone(),
        }
    }
}

impl From<ConnectionPb> for Connection {
    fn from(p: ConnectionPb) -> Self {
        // Unknown enum ints fall back to Password rather than failing the whole
        // vault decode; a real vault never carries an out-of-range value.
        let auth_type = AuthTypePb::try_from(p.auth_type).unwrap_or(AuthTypePb::Password).into();
        let actions: Vec<ConnAction> = p.actions.into_iter().map(ConnAction::from).collect();
        Connection {
            id: p.id,
            name: p.name,
            host: p.host,
            port: p.port as u16,
            username: p.username,
            auth_type,
            key_path: p.key_path,
            jump: p.jump,
            group: p.group,
            favorite: p.favorite,
            color: p.color,
            startup_commands: p.startup_commands,
            // Preserve the serde shape: no actions == None (not Some([])).
            actions: if actions.is_empty() { None } else { Some(actions) },
            secret: p.secret,
            key_text: p.key_text,
        }
    }
}

impl From<&Snippet> for SnippetPb {
    fn from(s: &Snippet) -> Self {
        SnippetPb {
            id: s.id.clone(),
            label: s.label.clone(),
            command: s.command.clone(),
            category: s.category.clone(),
        }
    }
}

impl From<SnippetPb> for Snippet {
    fn from(p: SnippetPb) -> Self {
        Snippet { id: p.id, label: p.label, command: p.command, category: p.category }
    }
}

impl From<&KnownHost> for KnownHostPb {
    fn from(k: &KnownHost) -> Self {
        KnownHostPb {
            host: k.host.clone(),
            port: k.port as u32,
            fingerprint: k.fingerprint.clone(),
            algo: k.algo.clone(),
        }
    }
}

impl From<KnownHostPb> for KnownHost {
    fn from(p: KnownHostPb) -> Self {
        KnownHost { host: p.host, port: p.port as u16, fingerprint: p.fingerprint, algo: p.algo }
    }
}

impl From<&Settings> for SettingsPb {
    fn from(s: &Settings) -> Self {
        SettingsPb {
            auto_lock_minutes: s.auto_lock_minutes,
            mcp_enabled: s.mcp_enabled,
            mcp_token: s.mcp_token.clone(),
        }
    }
}

impl From<SettingsPb> for Settings {
    fn from(p: SettingsPb) -> Self {
        Settings {
            auto_lock_minutes: p.auto_lock_minutes,
            mcp_enabled: p.mcp_enabled,
            mcp_token: p.mcp_token,
        }
    }
}

impl From<&VaultData> for VaultDataPb {
    fn from(d: &VaultData) -> Self {
        VaultDataPb {
            connections: d.connections.iter().map(ConnectionPb::from).collect(),
            snippets: d.snippets.iter().map(SnippetPb::from).collect(),
            known_hosts: d.known_hosts.iter().map(KnownHostPb::from).collect(),
            settings: Some(SettingsPb::from(&d.settings)),
        }
    }
}

impl From<VaultDataPb> for VaultData {
    fn from(p: VaultDataPb) -> Self {
        VaultData {
            connections: p.connections.into_iter().map(Connection::from).collect(),
            snippets: p.snippets.into_iter().map(Snippet::from).collect(),
            known_hosts: p.known_hosts.into_iter().map(KnownHost::from).collect(),
            settings: p.settings.map(Settings::from).unwrap_or_default(),
        }
    }
}
