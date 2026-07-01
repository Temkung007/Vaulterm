import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---- Vault (master password) ------------------------------------------------

export interface VaultStatus {
  /** A vault already exists on disk (not first run). */
  exists: boolean;
  /** The vault is currently unlocked. */
  unlocked: boolean;
}

export function vaultStatus(): Promise<VaultStatus> {
  return invoke("vault_status");
}
/** First run: set the master password and create the encrypted vault. */
export function vaultCreate(password: string): Promise<void> {
  return invoke("vault_create", { password });
}
/** Decrypt the vault. Rejects with "incorrect master password" on a bad one. */
export function vaultUnlock(password: string): Promise<void> {
  return invoke("vault_unlock", { password });
}
/** Re-lock: wipe the key + decrypted data from memory. */
export function vaultLock(): Promise<void> {
  return invoke("vault_lock");
}

/** Re-key the vault with a new master password (verifies `current` first). */
export function vaultChangePassword(current: string, newPassword: string): Promise<void> {
  return invoke("vault_change_password", { current, new: newPassword });
}

// ---- Settings ---------------------------------------------------------------

export interface Settings {
  /** Lock the vault after this many minutes idle (0 = never). */
  autoLockMinutes: number;
}

export function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}
export function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}

export type AuthType = "password" | "key" | "key_text";

/** Mirrors the Rust `store::Connection` (camelCase). No secret lives here. */
export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  /** Path to a private key file (auth = "key"). */
  keyPath?: string | null;
  /** Folder/group name (optional). */
  group?: string | null;
  favorite?: boolean;
  /** Accent color (hex) shown in the sidebar. */
  color?: string | null;
  /** Commands typed into the shell right after connecting. */
  startupCommands?: string | null;
}

// ---- Connection CRUD --------------------------------------------------------

export function listConnections(): Promise<Connection[]> {
  return invoke("list_connections");
}

/**
 * Create or update a connection.
 * @param secret password or key passphrase. `null` keeps the existing secret.
 * @param keyText pasted private key (auth = "key_text"). `null` keeps the saved key.
 * Returns the connection id (newly generated for a create).
 */
export function saveConnection(
  conn: Connection,
  secret: string | null,
  keyText: string | null,
): Promise<string> {
  return invoke("save_connection", { conn, secret, keyText });
}

export function deleteConnection(id: string): Promise<void> {
  return invoke("delete_connection", { id });
}

/** Persist a new order for the connection list. */
export function reorderConnections(order: string[]): Promise<void> {
  return invoke("reorder_connections", { order });
}

// ---- Custom snippets --------------------------------------------------------

/** A user-saved command snippet (built-in pack lives in the frontend). */
export interface Snippet {
  id: string;
  label: string;
  command: string;
  category: string;
}

export function listSnippets(): Promise<Snippet[]> {
  return invoke("list_snippets");
}

export function saveSnippet(snippet: Snippet): Promise<string> {
  return invoke("save_snippet", { snippet });
}

export function deleteSnippet(id: string): Promise<void> {
  return invoke("delete_snippet", { id });
}

// ---- SSH session lifecycle --------------------------------------------------

/** Structured rejection from `sshOpen` (matches Rust `SshError`). */
export type SshError =
  | { kind: "message"; message: string }
  | { kind: "hostKeyMismatch"; host: string; port: number; expected: string; got: string };

export function isHostKeyMismatch(
  e: unknown,
): e is Extract<SshError, { kind: "hostKeyMismatch" }> {
  return !!e && typeof e === "object" && (e as SshError).kind === "hostKeyMismatch";
}

export function sshOpen(
  connectionId: string,
  sessionId: string,
  cols: number,
  rows: number,
  onOutput: Channel<string>,
  trustHostKey = false,
): Promise<void> {
  return invoke("ssh_open", { connectionId, sessionId, cols, rows, onOutput, trustHostKey });
}

export function sshWrite(sessionId: string, data: string): Promise<void> {
  return invoke("ssh_write", { sessionId, data });
}

export function sshResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("ssh_resize", { sessionId, cols, rows });
}

export function sshClose(sessionId: string): Promise<void> {
  return invoke("ssh_close", { sessionId });
}

/** Fires when a session ends on the backend (remote closed / disconnected). */
export function onSessionClosed(cb: (sessionId: string) => void): Promise<UnlistenFn> {
  return listen<string>("ssh-closed", (e) => cb(e.payload));
}

// ---- SFTP (remote file browser + editor) ------------------------------------

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** Absolute path of the starting directory (home). */
export function sftpHome(connectionId: string): Promise<string> {
  return invoke("sftp_home", { connectionId });
}
export function sftpList(connectionId: string, path: string): Promise<FileEntry[]> {
  return invoke("sftp_list", { connectionId, path });
}
/** Read a file as UTF-8 text (rejects binary / oversized files). */
export function sftpRead(connectionId: string, path: string): Promise<string> {
  return invoke("sftp_read", { connectionId, path });
}
export function sftpWrite(connectionId: string, path: string, content: string): Promise<void> {
  return invoke("sftp_write", { connectionId, path, content });
}
export function sftpClose(connectionId: string): Promise<void> {
  return invoke("sftp_close", { connectionId });
}
export function sftpUpload(connectionId: string, localPath: string, remotePath: string): Promise<void> {
  return invoke("sftp_upload", { connectionId, localPath, remotePath });
}
export function sftpDownload(connectionId: string, remotePath: string, localPath: string): Promise<void> {
  return invoke("sftp_download", { connectionId, remotePath, localPath });
}
export function sftpMkdir(connectionId: string, path: string): Promise<void> {
  return invoke("sftp_mkdir", { connectionId, path });
}
export function sftpRename(connectionId: string, from: string, to: string): Promise<void> {
  return invoke("sftp_rename", { connectionId, from, to });
}
export function sftpDelete(connectionId: string, path: string, isDir: boolean): Promise<void> {
  return invoke("sftp_delete", { connectionId, path, isDir });
}

/** Run a one-shot command over SSH (exec) and return its stdout. */
export function sshRun(connectionId: string, command: string): Promise<string> {
  return invoke("ssh_run", { connectionId, command });
}

// ---- Vault backup / restore -------------------------------------------------

export function vaultExport(destPath: string): Promise<void> {
  return invoke("vault_export", { destPath });
}
/** Replace the current vault with a backup; the app re-locks afterwards. */
export function vaultImport(srcPath: string): Promise<void> {
  return invoke("vault_import", { srcPath });
}
