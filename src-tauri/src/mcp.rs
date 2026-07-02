//! A minimal local HTTP MCP (Model Context Protocol) server that lets an MCP
//! client (Claude Desktop / Claude Code) use the saved SSH connections without
//! ever seeing the stored secrets.
//!
//! * Binds `127.0.0.1` only, and requires a bearer token.
//! * Runs only while the vault is unlocked.
//! * Read-only tools (list_connections/server_status/read_file/tail_log) run
//!   directly; the dangerous tools (run_command/write_file) require the user to
//!   approve each call in the Vaulterm UI (via the `mcp-confirm` event).
//!
//! Transport: the Streamable-HTTP `POST /mcp` endpoint, answered with a single
//! `application/json` JSON-RPC response (spec-compliant, no SSE needed).

use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::commands::resolve_chain;
use crate::ssh::{self, SshConnectError};
use crate::AppState;

/// Fixed loopback port for the MCP endpoint.
pub const MCP_PORT: u16 = 8765;
/// Protocol revision we advertise (we accept whatever the client asks for).
const PROTOCOL_VERSION: &str = "2025-06-18";
/// How long a dangerous tool waits for the user's approval before denying.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

/// Handle to a running MCP server. `stop()` shuts it down gracefully.
pub struct McpHandle {
    pub port: u16,
    pub token: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl McpHandle {
    pub fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    token: String,
}

/// Generate a fresh URL-safe bearer token.
pub fn generate_token() -> String {
    let mut b = [0u8; 24];
    let _ = getrandom::getrandom(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Start the MCP server on 127.0.0.1:MCP_PORT.
pub async fn start(app: AppHandle, token: String) -> Result<McpHandle, String> {
    let ctx = Ctx { app, token: token.clone() };
    let router = Router::new().route("/mcp", post(handle)).with_state(ctx);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", MCP_PORT))
        .await
        .map_err(|e| format!("cannot bind 127.0.0.1:{MCP_PORT} — {e}"))?;
    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok(McpHandle { port: MCP_PORT, token, shutdown: Some(tx) })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Response {
    Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})).into_response()
}

async fn handle(State(ctx): State<Ctx>, headers: HeaderMap, Json(req): Json<Value>) -> Response {
    // Bearer-token auth.
    let authed = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v) == ctx.token)
        .unwrap_or(false);
    if !authed {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"unauthorized"}})),
        )
            .into_response();
    }

    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    // Notifications carry no id and expect no response body.
    let Some(id) = req.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response();
    };

    match method {
        "initialize" => {
            let pv = req
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION);
            Json(json!({
                "jsonrpc":"2.0","id":id,
                "result":{
                    "protocolVersion": pv,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name":"vaulterm","version":env!("CARGO_PKG_VERSION")},
                    "instructions":"Vaulterm exposes your saved SSH servers. run_command and write_file require you to approve each call in the Vaulterm window."
                }
            }))
            .into_response()
        }
        "ping" => Json(json!({"jsonrpc":"2.0","id":id,"result":{}})).into_response(),
        "tools/list" => {
            Json(json!({"jsonrpc":"2.0","id":id,"result":{"tools":tool_defs()}})).into_response()
        }
        "tools/call" => {
            let result = call_tool(&ctx, req.get("params")).await;
            Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
        }
        other => rpc_error(id, -32601, &format!("method not found: {other}")),
    }
}

fn tool_defs() -> Value {
    let conn = json!({"type":"string","description":"Connection name or id (from list_connections)"});
    json!([
        {"name":"list_connections","description":"List saved SSH connections (names/hosts only, no secrets).","inputSchema":{"type":"object","properties":{}}},
        {"name":"server_status","description":"OS, kernel, uptime, load, CPU, memory and disk usage of a server.","inputSchema":{"type":"object","properties":{"connection":conn},"required":["connection"]}},
        {"name":"read_file","description":"Read a text file from a server over SSH.","inputSchema":{"type":"object","properties":{"connection":conn,"path":{"type":"string"}},"required":["connection","path"]}},
        {"name":"tail_log","description":"Show the last N lines of a file (default 100).","inputSchema":{"type":"object","properties":{"connection":conn,"path":{"type":"string"},"lines":{"type":"integer","default":100}},"required":["connection","path"]}},
        {"name":"run_command","description":"Run a shell command on a server. Requires the user to approve it in Vaulterm.","inputSchema":{"type":"object","properties":{"connection":conn,"command":{"type":"string"}},"required":["connection","command"]}},
        {"name":"write_file","description":"Write text to a file on a server (overwrites). Requires the user to approve it in Vaulterm.","inputSchema":{"type":"object","properties":{"connection":conn,"path":{"type":"string"},"content":{"type":"string"}},"required":["connection","path","content"]}}
    ])
}

async fn call_tool(ctx: &Ctx, params: Option<&Value>) -> Value {
    let name = params.and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or("");
    let args = params.and_then(|p| p.get("arguments")).cloned().unwrap_or_else(|| json!({}));
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();

    let res: Result<String, String> = match name {
        "list_connections" => list_connections(ctx),
        "server_status" => run_on(ctx, &s("connection"), STATUS_CMD).await,
        "read_file" => {
            let path = s("path");
            if path.is_empty() {
                Err("path is required".into())
            } else {
                run_on(ctx, &s("connection"), &format!("cat -- {}", sh(&path))).await
            }
        }
        "tail_log" => {
            let path = s("path");
            let lines = args.get("lines").and_then(Value::as_i64).unwrap_or(100).clamp(1, 10000);
            if path.is_empty() {
                Err("path is required".into())
            } else {
                run_on(ctx, &s("connection"), &format!("tail -n {lines} -- {}", sh(&path))).await
            }
        }
        "run_command" => {
            let (conn, cmd) = (s("connection"), s("command"));
            if conn.is_empty() || cmd.is_empty() {
                Err("connection and command are required".into())
            } else if !confirm(ctx, &conn, "run_command", &cmd).await {
                Err("denied by the user in Vaulterm".into())
            } else {
                run_on(ctx, &conn, &cmd).await
            }
        }
        "write_file" => {
            let (conn, path, content) = (s("connection"), s("path"), s("content"));
            if conn.is_empty() || path.is_empty() {
                Err("connection and path are required".into())
            } else if !confirm(ctx, &conn, "write_file", &format!("{path}\n\n{content}")).await {
                Err("denied by the user in Vaulterm".into())
            } else {
                let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
                let cmd = format!("printf %s {} | base64 -d > {}", sh(&b64), sh(&path));
                run_on(ctx, &conn, &cmd).await.map(|o| if o.is_empty() { format!("wrote {path}") } else { o })
            }
        }
        other => Err(format!("unknown tool: {other}")),
    };

    match res {
        Ok(text) => json!({"content":[{"type":"text","text":text}],"isError":false}),
        Err(e) => json!({"content":[{"type":"text","text":e}],"isError":true}),
    }
}

/// POSIX single-quote a string for safe interpolation into a shell command.
fn sh(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

const STATUS_CMD: &str = "echo \"OS: $(. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\" || echo unknown)\"; \
echo \"Kernel: $(uname -sr)\"; echo \"Host: $(hostname)\"; \
echo \"Uptime: $(uptime -p 2>/dev/null || uptime)\"; \
echo \"Load: $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)\"; echo \"CPU cores: $(nproc 2>/dev/null)\"; \
free -m 2>/dev/null | awk '/Mem:/{printf \"Memory: %d/%d MB (%.0f%%)\\n\",$3,$2,$3/$2*100}'; \
df -h / 2>/dev/null | awk 'NR==2{print \"Disk /: \"$3\"/\"$2\" (\"$5\")\"}'";

/// List saved connections as JSON (no secrets).
fn list_connections(ctx: &Ctx) -> Result<String, String> {
    let state = ctx.app.state::<AppState>();
    let conns = state.vault.read(|d| d.connections.clone()).map_err(|e| e.to_string())?;
    let list: Vec<Value> = conns
        .iter()
        .map(|c| json!({"id":c.id,"name":c.name,"host":c.host,"port":c.port,"username":c.username}))
        .collect();
    serde_json::to_string_pretty(&list).map_err(|e| e.to_string())
}

/// Resolve a connection key (id or name) and run `command` on it, returning output.
async fn run_on(ctx: &Ctx, key: &str, command: &str) -> Result<String, String> {
    if key.is_empty() {
        return Err("connection is required".into());
    }
    let (hops, known) = {
        let state = ctx.app.state::<AppState>();
        let conns = state.vault.read(|d| d.connections.clone()).map_err(|e| e.to_string())?;
        let id = conns
            .iter()
            .find(|c| c.id == key || c.name.eq_ignore_ascii_case(key))
            .map(|c| c.id.clone())
            .ok_or_else(|| format!("no connection named or id '{key}'"))?;
        let hops = resolve_chain(&state.vault, &id)?;
        let known = state.vault.read(|d| d.known_hosts.clone()).map_err(|e| e.to_string())?;
        (hops, known)
    };
    ssh::run_exec(hops, known, command).await.map_err(|e| match e {
        SshConnectError::HostKeyMismatch { host, port, .. } => {
            format!("host key for {host}:{port} changed — open a terminal to it first")
        }
        SshConnectError::Other(m) => m,
    })
}

/// Ask the user to approve a dangerous tool call in the Vaulterm UI.
async fn confirm(ctx: &Ctx, connection: &str, action: &str, detail: &str) -> bool {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<bool>();
    {
        let state = ctx.app.state::<AppState>();
        state.mcp_pending.lock().unwrap().insert(id.clone(), tx);
    }
    let _ = ctx.app.emit(
        "mcp-confirm",
        json!({"id":id,"connection":connection,"action":action,"detail":detail}),
    );
    let allowed = matches!(tokio::time::timeout(CONFIRM_TIMEOUT, rx).await, Ok(Ok(true)));
    // Clean up the pending entry if it's still there (timeout / denied).
    ctx.app.state::<AppState>().mcp_pending.lock().unwrap().remove(&id);
    allowed
}
