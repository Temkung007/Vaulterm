mod commands;
mod mcp;
mod sftp;
mod ssh;
mod store;
mod tunnel;
mod vault;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::Manager;
use tokio::sync::mpsc::UnboundedSender;

use sftp::SftpConn;
use ssh::SessionInput;
use tunnel::Tunnel;
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
    /// Tunnel id -> running port-forward.
    pub tunnels: Mutex<HashMap<String, Tunnel>>,
    /// The running local MCP server (AI access), if enabled + vault unlocked.
    pub mcp: Mutex<Option<mcp::McpHandle>>,
    /// Pending MCP dangerous-tool confirmations awaiting the user's decision.
    pub mcp_pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            commands::ssh_run,
            commands::tunnel_start,
            commands::tunnel_stop,
            commands::tunnel_list,
            commands::tunnel_stop_all,
            commands::mcp_status,
            commands::mcp_set_enabled,
            commands::mcp_autostart,
            commands::mcp_stop,
            commands::mcp_confirm_respond,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Best-effort teardown of live tunnels when the app exits: abort each
            // accept loop and drop its SSH handle, which closes the session and
            // releases any server-side -R forward.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let drained: Vec<Tunnel> =
                        state.tunnels.lock().unwrap().drain().map(|(_, t)| t).collect();
                    for t in &drained {
                        t.abort();
                    }
                }
            }
        });
}
