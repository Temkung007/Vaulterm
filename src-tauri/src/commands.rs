//! Tauri command layer — the bridge the frontend calls via `invoke`.
//!
//! All data commands go through the encrypted vault and fail while it is
//! locked; the frontend gates the UI behind the lock screen accordingly.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::sftp::{self, FileEntry, SftpConn};
use crate::ssh::{self, SessionInput, SshConnectError};
use crate::store::{Connection, KnownHost, Settings, Snippet};
use crate::tunnel::{self, Tunnel, TunnelInfo};
use crate::vault::Vault;
use crate::AppState;

/// Build the hop chain [jump…, target] for `target_id`, resolving each hop's
/// secret from the vault; errors on a jump-host cycle.
fn resolve_chain(vault: &Vault, target_id: &str) -> Result<Vec<ssh::Hop>, String> {
    let conns = vault.read(|d| d.connections.clone()).map_err(|e| e.to_string())?;
    let mut chain: Vec<Connection> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut cur = target_id.to_string();
    loop {
        if !seen.insert(cur.clone()) {
            return Err("jump host loops back on itself".into());
        }
        let c = conns
            .iter()
            .find(|c| c.id == cur)
            .ok_or_else(|| "connection not found".to_string())?
            .clone();
        let next = c.jump.clone().filter(|j| !j.is_empty());
        chain.push(c);
        match next {
            Some(j) => cur = j,
            None => break,
        }
    }
    chain.reverse(); // first jump host … target
    Ok(chain
        .into_iter()
        .map(|c| ssh::Hop {
            secret: c.secret.clone(),
            key_material: c.key_text.clone(),
            conn: c,
        })
        .collect())
}

/// Persist any first-seen host keys (replacing an existing entry for host:port).
fn store_known_hosts(vault: &Vault, new_hosts: Vec<KnownHost>) {
    if new_hosts.is_empty() {
        return;
    }
    let _ = vault.write(|d| {
        for kh in new_hosts {
            d.known_hosts.retain(|k| !(k.host == kh.host && k.port == kh.port));
            d.known_hosts.push(kh);
        }
    });
}

// ---------------------------------------------------------------------------
// Vault lifecycle (master password)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct VaultStatus {
    /// A vault already exists on disk (i.e. not first run).
    exists: bool,
    /// The vault is currently unlocked in memory.
    unlocked: bool,
}

#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> VaultStatus {
    VaultStatus {
        exists: Vault::exists(),
        unlocked: state.vault.is_unlocked(),
    }
}

#[tauri::command]
pub fn vault_create(state: State<'_, AppState>, password: String) -> Result<(), String> {
    state.vault.create(&password).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_unlock(state: State<'_, AppState>, password: String) -> Result<(), String> {
    state.vault.unlock(&password).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_lock(state: State<'_, AppState>) {
    state.vault.lock();
}

#[tauri::command]
pub fn vault_change_password(
    state: State<'_, AppState>,
    current: String,
    new: String,
) -> Result<(), String> {
    state
        .vault
        .change_password(&current, &new)
        .map_err(|e| e.to_string())
}

/// Back up the encrypted vault file to `dest_path`.
#[tauri::command]
pub fn vault_export(state: State<'_, AppState>, dest_path: String) -> Result<(), String> {
    state.vault.export_to(&dest_path).map_err(|e| e.to_string())
}

/// Restore a backup over the current vault (then re-lock).
#[tauri::command]
pub fn vault_import(state: State<'_, AppState>, src_path: String) -> Result<(), String> {
    state.vault.import_from(&src_path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    state.vault.read(|d| d.settings.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    state
        .vault
        .write(|d| d.settings = settings)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Connection CRUD (vault-backed)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Result<Vec<Connection>, String> {
    state
        .vault
        .read(|d| d.connections.iter().map(Connection::public).collect())
        .map_err(|e| e.to_string())
}

/// Create or update a connection. `secret`/`key_text` follow the same rule as
/// before: `Some(..)` replaces the stored value, `None` keeps the existing one.
#[tauri::command]
pub fn save_connection(
    state: State<'_, AppState>,
    conn: Connection,
    secret: Option<String>,
    key_text: Option<String>,
) -> Result<String, String> {
    state
        .vault
        .write(|d| {
            let mut conn = conn;
            if conn.id.is_empty() {
                conn.id = Uuid::new_v4().to_string();
            }
            let existing = d.connections.iter().find(|c| c.id == conn.id);

            // Carry secrets forward unless explicitly replaced.
            conn.secret = match &secret {
                Some(s) => Some(s.clone()),
                None => existing.and_then(|e| e.secret.clone()),
            };
            conn.key_text = match &key_text {
                Some(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
                _ => existing.and_then(|e| e.key_text.clone()),
            };

            let id = conn.id.clone();
            match d.connections.iter_mut().find(|c| c.id == id) {
                Some(slot) => *slot = conn,
                None => d.connections.push(conn),
            }
            id
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .vault
        .write(|d| d.connections.retain(|c| c.id != id))
        .map_err(|e| e.to_string())
}

/// Persist a new order for the connection list (ids not in `order` keep their
/// relative order at the end).
#[tauri::command]
pub fn reorder_connections(state: State<'_, AppState>, order: Vec<String>) -> Result<(), String> {
    state
        .vault
        .write(|d| {
            let idx: HashMap<&str, usize> =
                order.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
            d.connections
                .sort_by_key(|c| idx.get(c.id.as_str()).copied().unwrap_or(usize::MAX));
        })
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Custom snippet CRUD (vault-backed)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> {
    state
        .vault
        .read(|d| d.snippets.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_snippet(state: State<'_, AppState>, snippet: Snippet) -> Result<String, String> {
    state
        .vault
        .write(|d| {
            let mut snippet = snippet;
            if snippet.id.is_empty() {
                snippet.id = Uuid::new_v4().to_string();
            }
            let id = snippet.id.clone();
            match d.snippets.iter_mut().find(|s| s.id == id) {
                Some(slot) => *slot = snippet,
                None => d.snippets.push(snippet),
            }
            id
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .vault
        .write(|d| d.snippets.retain(|s| s.id != id))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// SSH session lifecycle
// ---------------------------------------------------------------------------

/// Errors `ssh_open` can return. A changed host key is surfaced distinctly so
/// the frontend can prompt the user before trusting it.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshError {
    Message {
        message: String,
    },
    HostKeyMismatch {
        host: String,
        port: u16,
        expected: String,
        got: String,
    },
}

impl SshError {
    fn msg(s: impl Into<String>) -> Self {
        SshError::Message { message: s.into() }
    }
}

#[tauri::command]
pub async fn ssh_open(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    session_id: String,
    cols: u32,
    rows: u32,
    on_output: Channel<String>,
    trust_host_key: bool,
) -> Result<(), SshError> {
    // Resolve the jump chain + trusted host keys, releasing the vault lock
    // before the long-running connect.
    let hops = resolve_chain(&state.vault, &connection_id).map_err(SshError::msg)?;
    let known = state
        .vault
        .read(|d| d.known_hosts.clone())
        .map_err(|e| SshError::msg(e.to_string()))?;

    match ssh::connect(hops, known, trust_host_key, cols, rows).await {
        Ok((handle, channel, jump, new_hosts)) => {
            store_known_hosts(&state.vault, new_hosts);
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<SessionInput>();
            state.sessions.lock().unwrap().insert(session_id.clone(), tx);
            tauri::async_runtime::spawn(ssh::pump(app, session_id, handle, jump, channel, rx, on_output));
            Ok(())
        }
        Err(SshConnectError::HostKeyMismatch { host, port, expected, got }) => {
            Err(SshError::HostKeyMismatch { host, port, expected, got })
        }
        Err(SshConnectError::Other(m)) => Err(SshError::msg(m)),
    }
}

#[tauri::command]
pub fn ssh_write(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
    if let Some(tx) = state.sessions.lock().unwrap().get(&session_id) {
        tx.send(SessionInput::Data(bytes))
            .map_err(|_| "session is no longer active".to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    if let Some(tx) = state.sessions.lock().unwrap().get(&session_id) {
        let _ = tx.send(SessionInput::Resize { cols, rows });
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    if let Some(tx) = state.sessions.lock().unwrap().remove(&session_id) {
        let _ = tx.send(SessionInput::Close);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// SFTP (remote file browser + editor)
// ---------------------------------------------------------------------------

/// Get the connection's SFTP session, lazily opening (and caching) it.
async fn get_sftp(state: &AppState, connection_id: &str) -> Result<Arc<SftpConn>, String> {
    let existing = state.sftp_conns.lock().unwrap().get(connection_id).cloned();
    if let Some(conn) = existing {
        return Ok(conn);
    }

    let hops = resolve_chain(&state.vault, connection_id)?;
    let known = state.vault.read(|d| d.known_hosts.clone()).map_err(|e| e.to_string())?;

    let (sftp_conn, new_hosts) = sftp::open(hops, known)
        .await
        .map_err(|e| match e {
            SshConnectError::HostKeyMismatch { host, port, .. } => format!(
                "host key for {host}:{port} has changed — open a terminal to it first to review/trust the new key"
            ),
            SshConnectError::Other(m) => m,
        })?;
    store_known_hosts(&state.vault, new_hosts);

    let arc = Arc::new(sftp_conn);
    state
        .sftp_conns
        .lock()
        .unwrap()
        .insert(connection_id.to_string(), arc.clone());
    Ok(arc)
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, connection_id: String) -> Result<String, String> {
    get_sftp(state.inner(), &connection_id).await?.home().await
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    get_sftp(state.inner(), &connection_id).await?.list(&path).await
}

#[tauri::command]
pub async fn sftp_read(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<String, String> {
    get_sftp(state.inner(), &connection_id).await?.read(&path).await
}

#[tauri::command]
pub async fn sftp_write(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    get_sftp(state.inner(), &connection_id)
        .await?
        .write(&path, &content)
        .await
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    connection_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    get_sftp(state.inner(), &connection_id)
        .await?
        .upload(&local_path, &remote_path)
        .await
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    connection_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    get_sftp(state.inner(), &connection_id)
        .await?
        .download(&remote_path, &local_path)
        .await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<(), String> {
    get_sftp(state.inner(), &connection_id).await?.mkdir(&path).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    connection_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    get_sftp(state.inner(), &connection_id).await?.rename(&from, &to).await
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let s = get_sftp(state.inner(), &connection_id).await?;
    if is_dir {
        s.remove_dir_recursive(&path).await
    } else {
        s.remove_file(&path).await
    }
}

#[tauri::command]
pub fn sftp_close(state: State<'_, AppState>, connection_id: String) {
    state.sftp_conns.lock().unwrap().remove(&connection_id);
}

// ---------------------------------------------------------------------------
// Server dashboard (one-shot exec)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ssh_run(
    state: State<'_, AppState>,
    connection_id: String,
    command: String,
) -> Result<String, String> {
    let hops = resolve_chain(&state.vault, &connection_id)?;
    let known = state.vault.read(|d| d.known_hosts.clone()).map_err(|e| e.to_string())?;

    ssh::run_exec(hops, known, &command).await.map_err(|e| match e {
        SshConnectError::HostKeyMismatch { host, port, .. } => {
            format!("host key for {host}:{port} changed — open a terminal to it first")
        }
        SshConnectError::Other(m) => m,
    })
}

// ---------------------------------------------------------------------------
// Port forwarding (tunnels)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    connection_id: String,
    kind: String,
    bind_port: u16,
    dest_host: String,
    dest_port: u16,
) -> Result<TunnelInfo, String> {
    let hops = resolve_chain(&state.vault, &connection_id)?;
    let known = state.vault.read(|d| d.known_hosts.clone()).map_err(|e| e.to_string())?;
    // Remote (-R): the target session forwards inbound connections to
    // dest_host:dest_port on this machine.
    let forward_to = if kind == "remote" {
        Some((dest_host.clone(), dest_port))
    } else {
        None
    };
    let (handle, jump, new_hosts) = ssh::connect_chain(hops, known, false, forward_to)
        .await
        .map_err(|e| match e {
            SshConnectError::HostKeyMismatch { host, port, .. } => {
                format!("host key for {host}:{port} changed — open a terminal to it first")
            }
            SshConnectError::Other(m) => m,
        })?;
    store_known_hosts(&state.vault, new_hosts);

    // Shared across the accept loop + every per-connection piping task.
    let handle = Arc::new(handle);

    let bind_local = |bp: u16| async move {
        tokio::net::TcpListener::bind(("127.0.0.1", bp))
            .await
            .map_err(|e| format!("cannot bind 127.0.0.1:{bp} — {e}"))
    };

    let (task, bound) = match kind.as_str() {
        "remote" => {
            // Ask the server to listen; its inbound channels are piped by the
            // session handler. A placeholder task holds the tunnel slot.
            // russh returns the assigned port only when 0 (ephemeral) was
            // requested — for a fixed port the reply is empty and it yields 0,
            // so keep the port the user asked for.
            let assigned = handle
                .tcpip_forward("127.0.0.1".to_string(), bind_port as u32)
                .await
                .map_err(|e| format!("remote forward request failed — {e}"))? as u16;
            let bound = if bind_port == 0 { assigned } else { bind_port };
            (tokio::spawn(std::future::pending::<()>()), bound)
        }
        "dynamic" => {
            let listener = bind_local(bind_port).await?;
            let bound = listener.local_addr().map(|a| a.port()).unwrap_or(bind_port);
            (tokio::spawn(tunnel::run_dynamic_listener(listener, handle.clone())), bound)
        }
        _ => {
            let listener = bind_local(bind_port).await?;
            let bound = listener.local_addr().map(|a| a.port()).unwrap_or(bind_port);
            (
                tokio::spawn(tunnel::run_local_listener(listener, handle.clone(), dest_host.clone(), dest_port)),
                bound,
            )
        }
    };

    let remote_port = if kind == "remote" { Some(bound) } else { None };
    let id = Uuid::new_v4().to_string();
    let info = TunnelInfo {
        id: id.clone(),
        connection_id,
        kind,
        bind_port: bound,
        dest_host,
        dest_port,
    };
    state
        .tunnels
        .lock()
        .unwrap()
        .insert(id, Tunnel::new(info.clone(), task, handle, jump, remote_port));
    Ok(info)
}

#[tauri::command]
pub async fn tunnel_stop(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Take the tunnel out under the lock, then release it before awaiting.
    let tunnel = state.tunnels.lock().unwrap().remove(&id);
    if let Some(t) = tunnel {
        t.abort();
        t.graceful_cancel().await;
    }
    Ok(())
}

#[tauri::command]
pub fn tunnel_list(state: State<'_, AppState>) -> Vec<TunnelInfo> {
    state
        .tunnels
        .lock()
        .unwrap()
        .values()
        .map(|t| t.info.clone())
        .collect()
}

#[tauri::command]
pub async fn tunnel_stop_all(state: State<'_, AppState>) -> Result<(), String> {
    // Drain under the lock, then abort + cancel each outside it.
    let drained: Vec<Tunnel> = {
        let mut map = state.tunnels.lock().unwrap();
        map.drain().map(|(_, t)| t).collect()
    };
    for t in drained {
        t.abort();
        t.graceful_cancel().await;
    }
    Ok(())
}
