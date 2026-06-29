//! Remote file access over SFTP (the `sftp` subsystem on a russh channel).
//!
//! A `SftpConn` is a dedicated, authenticated SSH connection per saved
//! connection (host-key checked the same way as the terminal). The high-level
//! helpers list a directory and read/write a file as UTF-8 text for the editor.

use russh::client::Handle;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::{self, ClientHandler, SshConnectError};
use crate::store::{Connection, KnownHost};

/// Largest file we'll load into the in-app editor.
const MAX_EDIT_BYTES: u64 = 2_000_000;

/// One live SFTP connection. The `Handle` is kept alive for the session.
pub struct SftpConn {
    _handle: Handle<ClientHandler>,
    session: SftpSession,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Open a new SFTP connection (authenticates + host-key check via `ssh`).
pub async fn open(
    conn: &Connection,
    secret: Option<String>,
    key_material: Option<String>,
    known: Vec<KnownHost>,
) -> Result<(SftpConn, Option<KnownHost>), SshConnectError> {
    let (handle, new_host) =
        ssh::connect_authenticated(conn, secret, key_material, known, false).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| SshConnectError::Other(format!("opening channel: {e}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| SshConnectError::Other(format!("starting sftp subsystem: {e}")))?;
    let session = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| SshConnectError::Other(format!("sftp handshake failed: {e}")))?;

    Ok((SftpConn { _handle: handle, session }, new_host))
}

impl SftpConn {
    /// Absolute path of the starting directory (usually the user's home).
    pub async fn home(&self) -> Result<String, String> {
        self.session.canonicalize(".").await.map_err(|e| e.to_string())
    }

    /// List a directory: folders first, then files, case-insensitive by name.
    pub async fn list(&self, path: &str) -> Result<Vec<FileEntry>, String> {
        let dir = self.session.read_dir(path).await.map_err(|e| e.to_string())?;
        let mut entries: Vec<FileEntry> = dir
            .map(|e| FileEntry {
                name: e.file_name(),
                is_dir: e.file_type().is_dir(),
                size: e.metadata().size.unwrap_or(0),
            })
            .collect();
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    /// Read a file as UTF-8 text. Rejects oversized or binary files.
    pub async fn read(&self, path: &str) -> Result<String, String> {
        if let Some(size) = self.session.metadata(path).await.map_err(|e| e.to_string())?.size {
            if size > MAX_EDIT_BYTES {
                return Err(format!(
                    "file is too large to edit ({} KB, limit {} KB)",
                    size / 1024,
                    MAX_EDIT_BYTES / 1024
                ));
            }
        }
        let mut file = self
            .session
            .open_with_flags(path, OpenFlags::READ)
            .await
            .map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
        String::from_utf8(buf).map_err(|_| "binary file — cannot edit as text".to_string())
    }

    /// Overwrite a file with new UTF-8 text (truncates, creates if missing).
    pub async fn write(&self, path: &str, content: &str) -> Result<(), String> {
        let mut file = self
            .session
            .open_with_flags(
                path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).await.map_err(|e| e.to_string())?;
        file.flush().await.map_err(|e| e.to_string())?;
        file.shutdown().await.map_err(|e| e.to_string())?;
        Ok(())
    }
}
