//! Remote file access over SFTP (the `sftp` subsystem on a russh channel).
//!
//! A `SftpConn` is a dedicated, authenticated SSH connection per saved
//! connection (host-key checked the same way as the terminal). The high-level
//! helpers list a directory and read/write a file as UTF-8 text for the editor.

use russh::client::Handle;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tokio::io::{copy, AsyncReadExt, AsyncWriteExt};

use crate::ssh::{self, ClientHandler, Hop, SshConnectError};
use crate::store::KnownHost;

/// Largest file we'll load into the in-app editor.
const MAX_EDIT_BYTES: u64 = 2_000_000;

/// Join a POSIX directory path and a child name (SFTP is always `/`-separated).
fn join_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// One live SFTP connection. The handle (and any jump-host handles) are kept
/// alive for the lifetime of the session.
pub struct SftpConn {
    _handle: Handle<ClientHandler>,
    _jump: Vec<Handle<ClientHandler>>,
    session: SftpSession,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    /// The entry itself is a symlink (independent of what it points at).
    pub is_symlink: bool,
    pub size: u64,
    /// Last-modified time (seconds since epoch), if the server reports it.
    pub mtime: Option<u32>,
}

/// A file's text plus the metadata the editor needs to detect external edits.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    /// mtime + size at read time — the baseline for the optimistic-lock on save.
    pub mtime: Option<u32>,
    pub size: u64,
}

/// Metadata reported back after a write so the caller can refresh its baseline.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime: Option<u32>,
    pub size: Option<u64>,
}

/// Open a new SFTP connection through the given chain (authenticates + host-key
/// check via `ssh`). Returns the connection and any first-seen keys to persist.
pub async fn open(hops: Vec<Hop>, known: Vec<KnownHost>) -> Result<(SftpConn, Vec<KnownHost>), SshConnectError> {
    let (handle, jump, new_hosts) = ssh::connect_chain(hops, known, false, None).await?;

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

    Ok((SftpConn { _handle: handle, _jump: jump, session }, new_hosts))
}

impl SftpConn {
    /// Absolute path of the starting directory (usually the user's home).
    pub async fn home(&self) -> Result<String, String> {
        self.session.canonicalize(".").await.map_err(|e| e.to_string())
    }

    /// List a directory: folders first, then files, case-insensitive by name.
    ///
    /// `read_dir` returns each entry's own (lstat) attributes, so a symlink to a
    /// directory would list as a plain file and be un-navigable. For symlinks we
    /// do one follow-up `metadata` (which follows the link) to classify the
    /// target; broken links stay as non-navigable files.
    pub async fn list(&self, path: &str) -> Result<Vec<FileEntry>, String> {
        let dir = self.session.read_dir(path).await.map_err(|e| e.to_string())?;
        let mut entries: Vec<FileEntry> = Vec::new();
        for e in dir {
            let name = e.file_name();
            let ft = e.file_type();
            let is_symlink = ft.is_symlink();
            let meta = e.metadata();
            let mut is_dir = ft.is_dir();
            let mut size = meta.size.unwrap_or(0);
            let mut mtime = meta.mtime;
            if is_symlink {
                let target = join_path(path, &name);
                if let Ok(tmeta) = self.session.metadata(target).await {
                    is_dir = tmeta.file_type().is_dir();
                    size = tmeta.size.unwrap_or(size);
                    if mtime.is_none() {
                        mtime = tmeta.mtime;
                    }
                }
            }
            entries.push(FileEntry { name, is_dir, is_symlink, size, mtime });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    /// Read a file as UTF-8 text plus its mtime/size. Rejects oversized or
    /// binary files. The mtime is the baseline the editor stores so a later
    /// save can detect that something else changed the file underneath it.
    pub async fn read(&self, path: &str) -> Result<FileContent, String> {
        let meta = self.session.metadata(path).await.map_err(|e| e.to_string())?;
        let size = meta.size.unwrap_or(0);
        if size > MAX_EDIT_BYTES {
            return Err(format!(
                "file is too large to edit ({} KB, limit {} KB)",
                size / 1024,
                MAX_EDIT_BYTES / 1024
            ));
        }
        let mut file = self
            .session
            .open_with_flags(path, OpenFlags::READ)
            .await
            .map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
        let content =
            String::from_utf8(buf).map_err(|_| "binary file — cannot edit as text".to_string())?;
        Ok(FileContent { content, mtime: meta.mtime, size })
    }

    /// Overwrite a file with new UTF-8 text (truncates, creates if missing).
    ///
    /// Optimistic lock: unless `force` is set, the current server file is
    /// stat'd and the write is refused with `REMOTE_CHANGED` if its mtime or
    /// size differs from the baseline the caller captured at open time — so an
    /// external edit (deploy, log-rotate, a colleague) is never silently
    /// clobbered. Using *both* mtime and size closes the same-second window that
    /// mtime alone (1-second resolution) would miss, and still works on servers
    /// that don't report mtime. If the file can't be stat'd but a baseline was
    /// supplied, we fail closed (also `REMOTE_CHANGED`) rather than overwrite
    /// blind. `force` skips every check — used for brand-new files and for the
    /// explicit user override after a `REMOTE_CHANGED` prompt. Returns the fresh
    /// mtime + size so the caller can advance its baseline for the next save.
    pub async fn write(
        &self,
        path: &str,
        content: &str,
        force: bool,
        expected_mtime: Option<u32>,
        expected_size: Option<u64>,
    ) -> Result<WriteResult, String> {
        if !force {
            match self.session.metadata(path).await {
                Ok(meta) => {
                    let mtime_changed =
                        matches!((expected_mtime, meta.mtime), (Some(e), Some(c)) if e != c);
                    let size_changed =
                        matches!((expected_size, meta.size), (Some(e), Some(c)) if e != c);
                    if mtime_changed || size_changed {
                        return Err("REMOTE_CHANGED".to_string());
                    }
                }
                Err(_) => {
                    // Couldn't verify against the baseline we were given — fail
                    // closed so the user gets the override prompt, not a silent
                    // overwrite. (New files pass force=true and never land here.)
                    if expected_mtime.is_some() || expected_size.is_some() {
                        return Err("REMOTE_CHANGED".to_string());
                    }
                }
            }
        }
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
        // Best-effort: report the fresh mtime + size for the next lock check.
        let meta = self.session.metadata(path).await.ok();
        Ok(WriteResult {
            mtime: meta.as_ref().and_then(|m| m.mtime),
            size: meta.as_ref().and_then(|m| m.size),
        })
    }

    /// Upload a local file to `remote` (streamed; handles binary + large files).
    pub async fn upload(&self, local: &str, remote: &str) -> Result<(), String> {
        let mut src = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
        let mut dst = self
            .session
            .open_with_flags(remote, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
            .await
            .map_err(|e| e.to_string())?;
        copy(&mut src, &mut dst).await.map_err(|e| e.to_string())?;
        dst.flush().await.map_err(|e| e.to_string())?;
        dst.shutdown().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Download `remote` to a local path (streamed).
    pub async fn download(&self, remote: &str, local: &str) -> Result<(), String> {
        let mut src = self
            .session
            .open_with_flags(remote, OpenFlags::READ)
            .await
            .map_err(|e| e.to_string())?;
        let mut dst = tokio::fs::File::create(local).await.map_err(|e| e.to_string())?;
        copy(&mut src, &mut dst).await.map_err(|e| e.to_string())?;
        dst.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        self.session.create_dir(path).await.map_err(|e| e.to_string())
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.session.rename(from, to).await.map_err(|e| e.to_string())
    }

    pub async fn remove_file(&self, path: &str) -> Result<(), String> {
        self.session.remove_file(path).await.map_err(|e| e.to_string())
    }

    /// Recursively delete a directory and its contents.
    pub async fn remove_dir_recursive(&self, path: &str) -> Result<(), String> {
        let entries = self.session.read_dir(path).await.map_err(|e| e.to_string())?;
        for entry in entries {
            let child = join_path(path, &entry.file_name());
            if entry.file_type().is_dir() {
                Box::pin(self.remove_dir_recursive(&child)).await?;
            } else {
                self.session.remove_file(&child).await.map_err(|e| e.to_string())?;
            }
        }
        self.session.remove_dir(path).await.map_err(|e| e.to_string())
    }
}
