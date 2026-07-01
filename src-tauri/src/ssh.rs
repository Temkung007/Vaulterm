//! SSH session management built on russh 0.61.
//!
//! `connect()` does the handshake (with trust-on-first-use host-key checking) +
//! auth + PTY/shell request and returns the live handle and channel. `pump()`
//! then runs as a background task that owns the channel, bridging frontend
//! input to the remote PTY and streaming output back as base64 chunks.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use russh::client::{self, Config, Handle, Handler, Msg};
use russh::keys::{decode_secret_key, load_secret_key, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use russh::{Channel, ChannelMsg};
use tauri::ipc::Channel as IpcChannel;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::store::{AuthType, Connection, KnownHost};
use crate::AppState;

/// Commands the frontend sends to a live session's pump task.
pub enum SessionInput {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// Result of comparing the server's host key against the trusted set.
#[derive(Clone)]
enum HostKeyOutcome {
    Pending,
    Trusted,
    FirstSeen { fingerprint: String, algo: String },
    Mismatch { expected: String, got: String },
}

/// Connection failures the frontend may need to act on.
pub(crate) enum SshConnectError {
    /// The server presented a different host key than the trusted one.
    HostKeyMismatch {
        host: String,
        port: u16,
        expected: String,
        got: String,
    },
    Other(String),
}

/// russh client handler implementing trust-on-first-use host-key verification.
pub(crate) struct ClientHandler {
    host: String,
    port: u16,
    known: Vec<KnownHost>,
    /// When true, accept whatever key the server presents and record it (used
    /// when the user explicitly trusts a changed key).
    trust_override: bool,
    outcome: Arc<Mutex<HostKeyOutcome>>,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(Default::default()).to_string();
        let algo = server_public_key.algorithm().to_string();

        if self.trust_override {
            *self.outcome.lock().unwrap() = HostKeyOutcome::FirstSeen { fingerprint, algo };
            return Ok(true);
        }

        let known = self
            .known
            .iter()
            .find(|k| k.host == self.host && k.port == self.port);
        let (outcome, accept) = match known {
            None => (HostKeyOutcome::FirstSeen { fingerprint: fingerprint.clone(), algo }, true),
            Some(k) if k.fingerprint == fingerprint => (HostKeyOutcome::Trusted, true),
            Some(k) => (
                HostKeyOutcome::Mismatch {
                    expected: k.fingerprint.clone(),
                    got: fingerprint.clone(),
                },
                false,
            ),
        };
        *self.outcome.lock().unwrap() = outcome;
        Ok(accept)
    }
}

/// Connect, verify the host key, authenticate, and open an interactive shell.
///
/// On success returns the handle, channel, and `Some(KnownHost)` if this was a
/// first-seen (or explicitly trusted) key the caller should persist.
/// One hop in a connection chain — jump hosts first, the target last.
pub(crate) struct Hop {
    pub conn: Connection,
    pub secret: Option<String>,
    pub key_material: Option<String>,
}

/// Connect through the chain (jump hosts, then target), authenticating each
/// hop. Returns the target handle, the intermediate jump handles (which MUST be
/// kept alive to hold the tunnels open), and any first-seen keys to persist.
pub(crate) async fn connect_chain(
    hops: Vec<Hop>,
    known: Vec<KnownHost>,
    trust_override: bool,
) -> Result<(Handle<ClientHandler>, Vec<Handle<ClientHandler>>, Vec<KnownHost>), SshConnectError> {
    let config = Arc::new(Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    });
    let mut handles: Vec<Handle<ClientHandler>> = Vec::new();
    let mut new_hosts: Vec<KnownHost> = Vec::new();

    for (i, hop) in hops.iter().enumerate() {
        let outcome = Arc::new(Mutex::new(HostKeyOutcome::Pending));
        let handler = ClientHandler {
            host: hop.conn.host.clone(),
            port: hop.conn.port,
            known: known.clone(),
            trust_override,
            outcome: outcome.clone(),
        };

        // First hop uses a real TcpStream; later hops tunnel through the
        // previous handle via a direct-tcpip channel.
        let connect_result = if i == 0 {
            client::connect(config.clone(), (hop.conn.host.as_str(), hop.conn.port), handler).await
        } else {
            let channel = handles
                .last()
                .expect("previous hop")
                .channel_open_direct_tcpip(
                    hop.conn.host.clone(),
                    hop.conn.port as u32,
                    "127.0.0.1".to_string(),
                    0u32,
                )
                .await
                .map_err(|e| {
                    SshConnectError::Other(format!(
                        "opening tunnel to {}:{} via jump host — {e}",
                        hop.conn.host, hop.conn.port
                    ))
                })?;
            client::connect_stream(config.clone(), channel.into_stream(), handler).await
        };

        let mut handle = match connect_result {
            Ok(h) => h,
            Err(e) => {
                if let HostKeyOutcome::Mismatch { expected, got } = outcome.lock().unwrap().clone() {
                    return Err(SshConnectError::HostKeyMismatch {
                        host: hop.conn.host.clone(),
                        port: hop.conn.port,
                        expected,
                        got,
                    });
                }
                return Err(SshConnectError::Other(format!(
                    "could not connect to {}:{} — {e}",
                    hop.conn.host, hop.conn.port
                )));
            }
        };

        authenticate(&mut handle, &hop.conn, hop.secret.clone(), hop.key_material.clone())
            .await
            .map_err(|e| SshConnectError::Other(format!("{e:#}")))?;

        if let HostKeyOutcome::FirstSeen { fingerprint, algo } = outcome.lock().unwrap().clone() {
            new_hosts.push(KnownHost {
                host: hop.conn.host.clone(),
                port: hop.conn.port,
                fingerprint,
                algo,
            });
        }

        handles.push(handle);
    }

    let target = handles.pop().expect("chain has at least one hop");
    Ok((target, handles, new_hosts))
}

/// Connect (through any jump hosts) and open an interactive shell with a PTY.
pub(crate) async fn connect(
    hops: Vec<Hop>,
    known: Vec<KnownHost>,
    trust_override: bool,
    cols: u32,
    rows: u32,
) -> Result<
    (Handle<ClientHandler>, Channel<Msg>, Vec<Handle<ClientHandler>>, Vec<KnownHost>),
    SshConnectError,
> {
    let (mut target, jumps, new_hosts) = connect_chain(hops, known, trust_override).await?;
    let channel = open_shell(&mut target, cols, rows)
        .await
        .map_err(|e| SshConnectError::Other(format!("{e:#}")))?;
    Ok((target, channel, jumps, new_hosts))
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    conn: &Connection,
    secret: Option<String>,
    key_material: Option<String>,
) -> anyhow::Result<()> {
    match conn.auth_type {
        AuthType::Password => {
            let password = secret.unwrap_or_default();
            let res = handle
                .authenticate_password(conn.username.clone(), password)
                .await?;
            if !res.success() {
                bail!("password authentication failed for user '{}'", conn.username);
            }
        }
        AuthType::Key | AuthType::KeyText => {
            let passphrase = secret.as_deref().filter(|s| !s.is_empty());
            let key: PrivateKey = match conn.auth_type {
                AuthType::Key => {
                    let path = conn
                        .key_path
                        .clone()
                        .ok_or_else(|| anyhow!("no private key path configured"))?;
                    load_secret_key(&path, passphrase)
                        .map_err(|e| anyhow!("could not load private key '{path}' — {e}"))?
                }
                AuthType::KeyText => {
                    let pem = key_material
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| anyhow!("no pasted private key stored for this connection"))?;
                    decode_secret_key(pem, passphrase)
                        .map_err(|e| anyhow!("could not parse the pasted private key — {e}"))?
                }
                AuthType::Password => unreachable!(),
            };
            let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);
            let res = handle
                .authenticate_publickey(conn.username.clone(), key)
                .await?;
            if !res.success() {
                bail!("public-key authentication failed for user '{}'", conn.username);
            }
        }
    }
    Ok(())
}

/// Open a one-shot connection, run `command` via exec, and return its stdout.
/// Used by the server dashboard (read-only status commands).
pub(crate) async fn run_exec(
    hops: Vec<Hop>,
    known: Vec<KnownHost>,
    command: &str,
) -> Result<String, SshConnectError> {
    // `_jump` and `handle` stay owned until end of scope, keeping the tunnels
    // and target session alive for the whole exec.
    let (handle, _jump, _new) = connect_chain(hops, known, false).await?;
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| SshConnectError::Other(format!("{e}")))?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| SshConnectError::Other(format!("{e}")))?;

    let mut out: Vec<u8> = Vec::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

async fn open_shell(handle: &mut Handle<ClientHandler>, cols: u32, rows: u32) -> anyhow::Result<Channel<Msg>> {
    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;
    Ok(channel)
}

/// Background task that owns the channel for the lifetime of the session.
pub(crate) async fn pump(
    app: AppHandle,
    session_id: String,
    handle: Handle<ClientHandler>,
    jump: Vec<Handle<ClientHandler>>,
    mut channel: Channel<Msg>,
    mut input: UnboundedReceiver<SessionInput>,
    output: IpcChannel<String>,
) {
    let _handle = handle; // keep the connection alive
    let _jump = jump; // keep jump-host tunnels alive

    loop {
        tokio::select! {
            cmd = input.recv() => match cmd {
                Some(SessionInput::Data(bytes)) => {
                    if channel.data(&bytes[..]).await.is_err() {
                        break;
                    }
                }
                Some(SessionInput::Resize { cols, rows }) => {
                    let _ = channel.window_change(cols, rows, 0, 0).await;
                }
                Some(SessionInput::Close) | None => {
                    let _ = channel.eof().await;
                    break;
                }
            },

            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) => {
                    if output.send(STANDARD.encode(&data[..])).is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::ExtendedData { data, ext }) => {
                    if ext == 1 {
                        let _ = output.send(STANDARD.encode(&data[..]));
                    }
                }
                Some(ChannelMsg::ExitStatus { .. }) => {}
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
        }
    }

    if let Some(state) = app.try_state::<AppState>() {
        state.sessions.lock().unwrap().remove(&session_id);
    }
    let _ = app.emit("ssh-closed", &session_id);
}

#[cfg(test)]
mod tests {
    use super::decode_secret_key;
    use std::{env, fs};

    #[test]
    fn decode_pasted_openssh_keys() {
        if let Ok(path) = env::var("TR_TEST_KEY") {
            let pem = fs::read_to_string(&path).expect("read plain key");
            decode_secret_key(&pem, None).expect("plain ed25519 key should decode");
        }
        if let (Ok(path), Ok(pass)) = (env::var("TR_TEST_KEY_ENC"), env::var("TR_TEST_PASS")) {
            let pem = fs::read_to_string(&path).expect("read encrypted key");
            decode_secret_key(&pem, Some(&pass)).expect("encrypted key should decode with passphrase");
            assert!(
                decode_secret_key(&pem, None).is_err(),
                "encrypted key must NOT decode without a passphrase",
            );
        }
    }
}
