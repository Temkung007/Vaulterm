mod commands;
mod sftp;
mod ssh;
mod store;
mod vault;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc::UnboundedSender;

use sftp::SftpConn;
use ssh::SessionInput;
use vault::Vault;

/// Shared application state.
#[derive(Default)]
pub struct AppState {
    /// The encrypted vault (locked until the master password is entered).
    pub vault: Vault,
    /// Active SSH session id -> input sender for that session's pump task.
    pub sessions: Mutex<HashMap<String, UnboundedSender<SessionInput>>>,
    /// Connection id -> its lazily-opened SFTP connection.
    pub sftp_conns: Mutex<HashMap<String, Arc<SftpConn>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_change_password,
            commands::vault_export,
            commands::vault_import,
            commands::get_settings,
            commands::save_settings,
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::reorder_connections,
            commands::list_snippets,
            commands::save_snippet,
            commands::delete_snippet,
            commands::ssh_open,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_close,
            commands::sftp_home,
            commands::sftp_list,
            commands::sftp_read,
            commands::sftp_write,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_delete,
            commands::sftp_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
