//! Remote file access over SFTP (the `sftp` subsystem on a russh channel).
//!
//! A `SftpConn` is a dedicated, authenticated SSH connection per saved
//! connection (host-key checked the same way as the terminal). The high-level
//! helpers list a directory and read/write a file as UTF-8 text for the editor.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tokio::io::{copy, AsyncReadExt, AsyncWriteExt};

use crate::ssh::{self, ClientHandler, Hop, SshConnectError};
use crate::store::KnownHost;

/// Largest file we'll load into the in-app editor.
const MAX_EDIT_BYTES: u64 = 2_000_000;

/// Largest file we'll pull down whole for the in-app image preview. Higher than
/// the editor's limit because photos are routinely megabytes, but still bounded:
/// the bytes cross the IPC bridge base64-encoded (~4/3 the size) and are held in
/// memory by the webview. Anything larger is a download, not a preview.
const MAX_PREVIEW_BYTES: u64 = 20_000_000;

/// Guard rails for the recursive folder walk. Neither is a policy limit on what
/// you're allowed to download — they exist so a mistaken click on `/` reports a
/// clear error instead of enumerating the whole server into memory.
const MAX_WALK_FILES: usize = 20_000;
const MAX_WALK_DEPTH: usize = 32;

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

/// One file found by [`SftpConn::walk`], ready to be turned into a transfer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkEntry {
    /// Absolute remote path.
    pub path: String,
    /// Path relative to the walked root, always `/`-separated — the caller
    /// mirrors this under the local destination folder.
    pub rel: String,
    pub size: u64,
}

/// A file's raw bytes, base64-encoded for the JSON IPC hop. Used by the image
/// preview, which needs the bytes verbatim rather than as (lossy) text.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryContent {
    /// Standard base64 (padded, not URL-safe) — decodable with `atob` in the webview.
    pub base64: String,
    /// Number of bytes actually read (not the stat'd size).
    pub size: u64,
    pub mtime: Option<u32>,
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

    /// Flatten a directory tree into the list of files under it.
    ///
    /// This is what turns "download this folder" into a set of ordinary file
    /// transfers: the caller gets every path plus its size up front, so it can
    /// show a real total and a progress bar rather than an open-ended spinner.
    /// Empty sub-directories aren't reported — there's nothing to transfer for
    /// them, so they simply don't appear locally.
    pub async fn walk(&self, root: &str) -> Result<Vec<WalkEntry>, String> {
        let mut out = Vec::new();
        self.walk_into(root, "", 0, &mut out).await?;
        Ok(out)
    }

    async fn walk_into(
        &self,
        dir: &str,
        rel: &str,
        depth: usize,
        out: &mut Vec<WalkEntry>,
    ) -> Result<(), String> {
        if depth > MAX_WALK_DEPTH {
            return Err(format!(
                "folder nesting goes deeper than {MAX_WALK_DEPTH} levels — download it in parts"
            ));
        }
        let entries = self.session.read_dir(dir).await.map_err(|e| e.to_string())?;
        for e in entries {
            let name = e.file_name();
            // Belt and braces: a server that echoes "." / ".." would otherwise
            // send the walk around in circles.
            if name == "." || name == ".." {
                continue;
            }
            let child = join_path(dir, &name);
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let ft = e.file_type();
            // `read_dir` reports each entry's own (lstat) attributes, so a
            // symlink never looks like a directory here. Resolve it once to find
            // out: links to directories are skipped outright — following them
            // risks a cycle, and queueing one as a "file" would just fail on
            // every download attempt. Links to files transfer normally.
            if ft.is_symlink() {
                match self.session.metadata(child.clone()).await {
                    Ok(m) if m.file_type().is_dir() => continue,
                    // A broken link fails at transfer time; that's reported per
                    // file rather than aborting the whole walk.
                    _ => {}
                }
            }
            if ft.is_dir() {
                Box::pin(self.walk_into(&child, &child_rel, depth + 1, out)).await?;
            } else {
                if out.len() >= MAX_WALK_FILES {
                    return Err(format!(
                        "more than {MAX_WALK_FILES} files under this folder — download it in parts"
                    ));
                }
                out.push(WalkEntry {
                    path: child,
                    rel: child_rel,
                    size: e.metadata().size.unwrap_or(0),
                });
            }
        }
        Ok(())
    }

    /// Read a file's raw bytes (base64-encoded) for the image preview.
    ///
    /// Unlike [`read`](Self::read) this makes no attempt to decode the file as
    /// text — images are binary by definition. The size is checked up front so
    /// an accidental click on a huge file fails fast instead of streaming it,
    /// and the read itself is capped too: the file could grow (or the server
    /// could under-report `size`) between the stat and the read, and an
    /// unbounded `read_to_end` would happily buffer all of it.
    pub async fn read_binary(&self, path: &str) -> Result<BinaryContent, String> {
        let meta = self.session.metadata(path).await.map_err(|e| e.to_string())?;
        let size = meta.size.unwrap_or(0);
        if size > MAX_PREVIEW_BYTES {
            return Err(format!(
                "file is too large to preview ({} MB, limit {} MB) — download it instead",
                size / 1_000_000,
                MAX_PREVIEW_BYTES / 1_000_000
            ));
        }
        let file = self
            .session
            .open_with_flags(path, OpenFlags::READ)
            .await
            .map_err(|e| e.to_string())?;
        let mut buf = Vec::with_capacity(size.min(MAX_PREVIEW_BYTES) as usize);
        // Read one byte past the cap so an over-cap file is detected, not truncated
        // into a corrupt half-image.
        file.take(MAX_PREVIEW_BYTES + 1)
            .read_to_end(&mut buf)
            .await
            .map_err(|e| e.to_string())?;
        if buf.len() as u64 > MAX_PREVIEW_BYTES {
            return Err(format!(
                "file is too large to preview (over {} MB) — download it instead",
                MAX_PREVIEW_BYTES / 1_000_000
            ));
        }
        Ok(BinaryContent {
            base64: STANDARD.encode(&buf),
            size: buf.len() as u64,
            mtime: meta.mtime,
        })
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
    ///
    /// Missing parent directories are created: a recursive folder download
    /// mirrors the remote tree, and those sub-directories won't exist locally yet.
    pub async fn download(&self, remote: &str, local: &str) -> Result<(), String> {
        if let Some(parent) = std::path::Path::new(local).parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
            }
        }
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
