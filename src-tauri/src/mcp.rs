//! Authenticated loopback MCP endpoint shared by AI clients and the CLI.
//! Remote mutations retain per-call UI approval. Executions are bounded and
//! return stdout, stderr and their actual remote status.

use crate::commands::resolve_chain;
use crate::ssh::{self, ExecOutput, SshConnectError};
use crate::store::Connection;
use crate::AppState;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{io::ErrorKind, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch};

pub const MCP_PORT: u16 = 8765;
const PROTOCOL_VERSION: &str = "2025-06-18";
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_TIMEOUT_SECONDS: u64 = 60;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1_048_576;
const MAX_CONTENT_BYTES: usize = 1_048_576;
const MAX_COMMAND_BYTES: usize = 65_536;

pub struct McpHandle {
    pub port: u16,
    pub token: String,
    shutdown: watch::Sender<bool>,
}
impl McpHandle {
    pub fn stop(self) {
        let _ = self.shutdown.send(true);
    }
}
#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    token: String,
    shutdown: watch::Receiver<bool>,
}

pub fn generate_token() -> String {
    let mut b = [0u8; 24];
    getrandom::getrandom(&mut b).expect("secure random source unavailable");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

async fn cancelled(mut shutdown: watch::Receiver<bool>) {
    while !*shutdown.borrow_and_update() {
        if shutdown.changed().await.is_err() {
            break;
        }
    }
}

pub async fn start(app: AppHandle, token: String) -> Result<McpHandle, String> {
    let (tx, rx) = watch::channel(false);
    let ctx = Ctx {
        app,
        token: token.clone(),
        shutdown: rx.clone(),
    };
    let router = Router::new()
        .route("/mcp", post(handle))
        // One MiB of text can expand to six MiB when escaped as JSON.
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .with_state(ctx);
    let mut attempts = 0;
    let listener = loop {
        match tokio::net::TcpListener::bind(("127.0.0.1", MCP_PORT)).await {
            Ok(listener) => break listener,
            Err(e) if e.kind() == ErrorKind::AddrInUse && attempts < 20 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(e) => return Err(format!("cannot bind 127.0.0.1:{MCP_PORT} — {e}")),
        }
    };
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(cancelled(rx))
            .await;
    });
    Ok(McpHandle {
        port: MCP_PORT,
        token,
        shutdown: tx,
    })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Response {
    Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})).into_response()
}

async fn handle(State(ctx): State<Ctx>, headers: HeaderMap, Json(req): Json<Value>) -> Response {
    let authed = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|v| v == ctx.token);
    if !authed {
        return (
            StatusCode::UNAUTHORIZED,
            Json(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"unauthorized"}}),
            ),
        )
            .into_response();
    }
    let id = req.get("id").cloned();
    if req.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || req.get("method").and_then(Value::as_str).is_none()
    {
        return rpc_error(
            id.unwrap_or(Value::Null),
            -32600,
            "invalid JSON-RPC request",
        );
    }
    let Some(id) = id else {
        return StatusCode::ACCEPTED.into_response();
    };
    if *ctx.shutdown.borrow() || !ctx.app.state::<AppState>().vault.is_unlocked() {
        return rpc_error(id, -32002, "MCP server stopped or vault locked");
    }
    match req["method"].as_str().unwrap() {
        "initialize" => Json(json!({"jsonrpc":"2.0","id":id,"result":{
            "protocolVersion":PROTOCOL_VERSION,"capabilities":{"tools":{}},
            "serverInfo":{"name":"termkin","version":env!("CARGO_PKG_VERSION")},
            "instructions":"Saved SSH connections are available without revealing credentials. Use connection ids when names are ambiguous. run_command and write_file require approval in the Termkin window. Inspect structuredContent.exitCode, timedOut and truncated."
        }})).into_response(),
        "ping" => Json(json!({"jsonrpc":"2.0","id":id,"result":{}})).into_response(),
        "tools/list" => Json(json!({"jsonrpc":"2.0","id":id,"result":{"tools":tool_defs()}})).into_response(),
        "tools/call" => {
            let result = tokio::select! {
                biased;
                _ = cancelled(ctx.shutdown.clone()) => tool_error("cancelled", "MCP stopped or vault locked; execution cancelled"),
                result = call_tool(&ctx, req.get("params")) => result,
            };
            Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
        }
        other => rpc_error(id, -32601, &format!("method not found: {other}")),
    }
}

fn tool_defs() -> Value {
    let conn = json!({"type":"string","minLength":1,"description":"Saved connection id or unique name (case-insensitive)."});
    let path = json!({"type":"string","minLength":1,"maxLength":4096,"description":"Literal remote path, maximum 4096 UTF-8 bytes; shell expansion is not applied."});
    let mut tools = json!([
        {"name":"list_connections","description":"List saved SSH connections without credentials.","inputSchema":{"type":"object","properties":{}}},
        {"name":"server_status","description":"OS, kernel, uptime, CPU, memory and disk usage (Linux).","inputSchema":{"type":"object","properties":{"connection":conn},"required":["connection"]}},
        {"name":"list_directory","description":"List a remote directory, including hidden files (ls -la).","inputSchema":{"type":"object","properties":{"connection":conn,"path":path},"required":["connection"]}},
        {"name":"read_file","description":"Read a remote text file. Large output is capped; inspect truncated.","inputSchema":{"type":"object","properties":{"connection":conn,"path":path},"required":["connection","path"]}},
        {"name":"tail_log","description":"Show the last N lines of a remote file.","inputSchema":{"type":"object","properties":{"connection":conn,"path":path,"lines":{"type":"integer","default":100,"minimum":1,"maximum":10000}},"required":["connection","path"]}},
        {"name":"run_command","description":"Run a remote shell command after approval in Termkin (maximum 65536 UTF-8 bytes). Returns stdout, stderr and exitCode.","inputSchema":{"type":"object","properties":{"connection":conn,"command":{"type":"string","minLength":1,"maxLength":65536}},"required":["connection","command"]}},
        {"name":"write_file","description":"Overwrite a remote text file after approval in Termkin (maximum 1 MiB UTF-8).","inputSchema":{"type":"object","properties":{"connection":conn,"path":path,"content":{"type":"string","maxLength":1048576}},"required":["connection","path","content"]}}
    ]);
    for tool in tools.as_array_mut().unwrap() {
        let name = tool["name"].as_str().unwrap().to_string();
        let schema = &mut tool["inputSchema"];
        schema["additionalProperties"] = json!(false);
        if name != "list_connections" {
            schema["properties"]["timeout_seconds"] = json!({"type":"integer","minimum":1,"maximum":3600,"default":DEFAULT_TIMEOUT_SECONDS,"description":"Total SSH connection + execution timeout, excluding approval wait."});
            schema["properties"]["max_output_bytes"] = json!({"type":"integer","minimum":1,"maximum":16777216,"default":DEFAULT_MAX_OUTPUT_BYTES,"description":"Combined stdout/stderr byte limit. Hitting it cancels the channel."});
        }
        let mutation = name == "run_command" || name == "write_file";
        tool["annotations"] =
            json!({"readOnlyHint":!mutation,"destructiveHint":mutation,"openWorldHint":true});
    }
    tools
}

#[derive(Debug)]
struct ToolError {
    code: &'static str,
    message: String,
}
impl ToolError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
fn tool_error(code: &str, message: &str) -> Value {
    json!({"content":[{"type":"text","text":message}],"isError":true,"structuredContent":{"error":{"code":code,"message":message}}})
}

fn validate_args(name: &str, args: &Value) -> Result<(), ToolError> {
    let tools = tool_defs();
    let tool = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .ok_or_else(|| ToolError::new("unknown_tool", format!("unknown tool: {name}")))?;
    let object = args
        .as_object()
        .ok_or_else(|| ToolError::new("invalid_arguments", "arguments must be an object"))?;
    let schema = &tool["inputSchema"];
    if let Some(required) = schema["required"].as_array() {
        for key in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(key) {
                return Err(ToolError::new(
                    "invalid_arguments",
                    format!("{key} is required"),
                ));
            }
        }
    }
    for (key, value) in object {
        let prop = &schema["properties"][key];
        if prop.is_null() {
            return Err(ToolError::new(
                "invalid_arguments",
                format!("unknown argument: {key}"),
            ));
        }
        match prop["type"].as_str().unwrap() {
            "string" => {
                let text = value.as_str().ok_or_else(|| {
                    ToolError::new("invalid_arguments", format!("{key} must be a string"))
                })?;
                if (prop["minLength"].as_u64().is_some() && text.trim().is_empty())
                    || (key != "content" && text.contains('\0'))
                {
                    return Err(ToolError::new(
                        "invalid_arguments",
                        format!("{key} must be nonempty and contain no NUL bytes"),
                    ));
                }
                if key == "content" && text.len() > MAX_CONTENT_BYTES {
                    return Err(ToolError::new(
                        "invalid_arguments",
                        "content exceeds 1 MiB UTF-8 limit",
                    ));
                }
                if key == "command" && text.len() > MAX_COMMAND_BYTES {
                    return Err(ToolError::new(
                        "invalid_arguments",
                        "command exceeds 65536 UTF-8 byte limit; use write_file for large scripts",
                    ));
                }
                if key == "path" && text.len() > 4096 {
                    return Err(ToolError::new(
                        "invalid_arguments",
                        "path exceeds 4096 UTF-8 byte limit",
                    ));
                }
            }
            "integer" => {
                let min = prop["minimum"].as_u64().unwrap();
                let max = prop["maximum"].as_u64().unwrap();
                if !value.as_u64().is_some_and(|n| n >= min && n <= max) {
                    return Err(ToolError::new(
                        "invalid_arguments",
                        format!("{key} must be an integer from {min} to {max}"),
                    ));
                }
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}

fn exec_result(result: ExecOutput) -> Value {
    let is_error = result.is_error();
    let mut text = result.stdout.clone();
    if !result.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&result.stderr);
    }
    if result.timed_out {
        text.push_str("\n[execution timed out; partial output]");
    }
    if result.truncated {
        text.push_str("\n[output limit exceeded; partial output]");
    }
    if let Some(error) = &result.stdin_error {
        text.push_str(&format!("\n[stdin failed: {error}]"));
    }
    if result.exit_code.is_none() && !result.timed_out && !result.truncated {
        text.push_str("\n[server did not report an exit status]");
    }
    if let Some(code) = result.exit_code.filter(|code| *code != 0) {
        text.push_str(&format!("\n[exit status {code}]"));
    }
    if let Some(signal) = &result.signal {
        text.push_str(&format!("\n[terminated by signal {signal}]"));
    }
    json!({"content":[{"type":"text","text":text}],"structuredContent":result,"isError":is_error})
}

async fn call_tool(ctx: &Ctx, params: Option<&Value>) -> Value {
    let name = params
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let args = params
        .and_then(|p| p.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Err(e) = validate_args(name, &args) {
        return tool_error(e.code, &e.message);
    }
    match execute_tool(ctx, name, &args).await {
        Ok(value) => value,
        Err(e) => tool_error(e.code, &e.message),
    }
}

async fn execute_tool(ctx: &Ctx, name: &str, args: &Value) -> Result<Value, ToolError> {
    if name == "list_connections" {
        let state = ctx.app.state::<AppState>();
        let list = state.vault.read(|d| d.connections.iter().map(|c|
            json!({"id":c.id,"name":c.name,"host":c.host,"port":c.port,"username":c.username,"group":c.group,"favorite":c.favorite,"jump":c.jump})
        ).collect::<Vec<_>>()).map_err(|e| ToolError::new("vault_locked", e.to_string()))?;
        return Ok(
            json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&list).unwrap()}],"structuredContent":{"connections":list},"isError":false}),
        );
    }
    let connection = args["connection"].as_str().unwrap();
    // Reject uncertain targets before displaying any approval prompt.
    let id = resolve_connection(&ctx.app.state::<AppState>(), connection)?;
    let path = args["path"].as_str().unwrap_or(".");
    let command = match name {
        "server_status" => STATUS_CMD.to_string(),
        "list_directory" => format!("ls -la -- {}", sh(path)),
        "read_file" => format!("cat -- {}", sh(path)),
        "tail_log" => format!(
            "tail -n {} -- {}",
            args["lines"].as_u64().unwrap_or(100),
            sh(path)
        ),
        "run_command" => {
            let command = args["command"].as_str().unwrap();
            if !confirm(ctx, &id, "run_command", command).await {
                return Err(ToolError::new(
                    "approval_denied",
                    "denied or approval timed out in Termkin",
                ));
            }
            command.to_string()
        }
        "write_file" => {
            let content = args["content"].as_str().unwrap();
            if !confirm(ctx, &id, "write_file", &format!("{path}\n\n{content}")).await {
                return Err(ToolError::new(
                    "approval_denied",
                    "denied or approval timed out in Termkin",
                ));
            }
            format!("cat > {}", sh(path))
        }
        _ => unreachable!(),
    };
    let timeout = Duration::from_secs(
        args["timeout_seconds"]
            .as_u64()
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS),
    );
    let max_output = args["max_output_bytes"]
        .as_u64()
        .unwrap_or(DEFAULT_MAX_OUTPUT_BYTES as u64) as usize;
    let input = if name == "write_file" {
        Some(args["content"].as_str().unwrap().as_bytes())
    } else {
        None
    };
    run_on(ctx, &id, &command, input, timeout, max_output)
        .await
        .map(exec_result)
}

fn sh(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
const STATUS_CMD: &str = "echo \"OS: $(. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\" || echo unknown)\"; \
echo \"Kernel: $(uname -sr)\"; echo \"Host: $(hostname)\"; \
echo \"Uptime: $(uptime -p 2>/dev/null || uptime)\"; \
echo \"Load: $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)\"; echo \"CPU cores: $(nproc 2>/dev/null)\"; \
free -m 2>/dev/null | awk '/Mem:/{printf \"Memory: %d/%d MB (%.0f%%)\\n\",$3,$2,$3/$2*100}'; \
df -h / 2>/dev/null | awk 'NR==2{print \"Disk /: \"$3\"/\"$2\" (\"$5\")\"}'";

fn find_connection<'a>(
    connections: &'a [Connection],
    key: &str,
) -> Result<&'a Connection, ToolError> {
    if let Some(connection) = connections.iter().find(|c| c.id == key) {
        return Ok(connection);
    }
    let mut matches = connections
        .iter()
        .filter(|c| c.name.eq_ignore_ascii_case(key));
    let first = matches.next().ok_or_else(|| {
        ToolError::new(
            "connection_not_found",
            format!("no connection named or id '{key}'"),
        )
    })?;
    if matches.next().is_some() {
        return Err(ToolError::new(
            "ambiguous_connection",
            format!("multiple connections named '{key}'; use the connection id"),
        ));
    }
    Ok(first)
}

fn resolve_connection(state: &AppState, key: &str) -> Result<String, ToolError> {
    state
        .vault
        .read(|d| find_connection(&d.connections, key).map(|c| c.id.clone()))
        .map_err(|e| ToolError::new("vault_locked", e.to_string()))?
}

fn ssh_error(error: SshConnectError) -> ToolError {
    match error {
        SshConnectError::HostKeyMismatch { host, port, .. } => ToolError::new(
            "host_key_mismatch",
            format!("host key for {host}:{port} changed — verify it in the Termkin window"),
        ),
        SshConnectError::Other(message) => ToolError::new("ssh_error", message),
    }
}

async fn run_on(
    ctx: &Ctx,
    id: &str,
    command: &str,
    input: Option<&[u8]>,
    timeout: Duration,
    max_output: usize,
) -> Result<ExecOutput, ToolError> {
    let (hops, known) = {
        let state = ctx.app.state::<AppState>();
        let hops =
            resolve_chain(&state.vault, id).map_err(|e| ToolError::new("vault_locked", e))?;
        let known = state
            .vault
            .read(|d| d.known_hosts.clone())
            .map_err(|e| ToolError::new("vault_locked", e.to_string()))?;
        (hops, known)
    };
    let deadline = tokio::time::Instant::now() + timeout;
    let (handle, _jumps, new_hosts) =
        tokio::time::timeout_at(deadline, ssh::connect_chain(hops, known, false, None))
            .await
            .map_err(|_| ToolError::new("timeout", "SSH connection timed out"))?
            .map_err(ssh_error)?;
    // Persist TOFU before execution, including first connections from the CLI.
    let state = ctx.app.state::<AppState>();
    if !new_hosts.is_empty() {
        state
            .vault
            .write(|d| {
                for host in new_hosts {
                    if let Some(existing) = d
                        .known_hosts
                        .iter()
                        .find(|k| k.host == host.host && k.port == host.port)
                    {
                        if existing.fingerprint != host.fingerprint {
                            return Err(ToolError::new(
                                "host_key_mismatch",
                                "host key changed during a concurrent connection",
                            ));
                        }
                    } else {
                        d.known_hosts.push(host);
                    }
                }
                Ok(())
            })
            .map_err(|e| ToolError::new("vault_locked", e.to_string()))??;
    }
    if *ctx.shutdown.borrow() || !state.vault.is_unlocked() {
        return Err(ToolError::new("cancelled", "MCP server stopped"));
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err(ToolError::new("timeout", "SSH connection timed out"));
    }
    ssh::exec_report(&handle, command, input, remaining, max_output)
        .await
        .map_err(ssh_error)
}

struct PendingConfirmation {
    app: AppHandle,
    id: String,
}
impl Drop for PendingConfirmation {
    fn drop(&mut self) {
        self.app
            .state::<AppState>()
            .mcp_pending
            .lock()
            .unwrap()
            .remove(&self.id);
    }
}
async fn confirm(ctx: &Ctx, connection: &str, action: &str, detail: &str) -> bool {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<bool>();
    ctx.app
        .state::<AppState>()
        .mcp_pending
        .lock()
        .unwrap()
        .insert(id.clone(), tx);
    let _pending = PendingConfirmation {
        app: ctx.app.clone(),
        id: id.clone(),
    };
    if ctx
        .app
        .emit(
            "mcp-confirm",
            json!({"id":id,"connection":connection,"action":action,"detail":detail}),
        )
        .is_err()
    {
        return false;
    }
    matches!(
        tokio::time::timeout(CONFIRM_TIMEOUT, rx).await,
        Ok(Ok(true))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_limits_types_and_unknown_fields() {
        for args in [
            json!({"connection":"x","path":"/a","lines":0}),
            json!({"connection":"x","path":"/a","lines":1.5}),
            json!({"connection":"x","path":"/a","timeout_seconds":3601}),
            json!({"connection":"x","path":"/a","unexpected":true}),
            json!({"connection":"x","path":"a\0b"}),
            json!({"connection":"x","path":3}),
        ] {
            assert_eq!(
                validate_args("tail_log", &args).unwrap_err().code,
                "invalid_arguments"
            );
        }
        assert!(validate_args(
            "write_file",
            &json!({"connection":"x","path":"a","content":""})
        )
        .is_ok());
        assert!(validate_args(
            "tail_log",
            &json!({"connection":"x","path":"/a","lines":10000})
        )
        .is_ok());
        assert_eq!(
            validate_args("nope", &json!({})).unwrap_err().code,
            "unknown_tool"
        );
        assert!(validate_args("run_command", &json!({"connection":"x"})).is_err());
        assert!(validate_args(
            "run_command",
            &json!({"connection":"x","command":"x".repeat(MAX_COMMAND_BYTES)})
        )
        .is_ok());
        assert!(validate_args(
            "run_command",
            &json!({"connection":"x","command":"ก".repeat(MAX_COMMAND_BYTES / 3 + 1)})
        )
        .is_err());
        assert!(validate_args(
            "read_file",
            &json!({"connection":"x","path":"x".repeat(4097)})
        )
        .is_err());
        assert!(validate_args(
            "write_file",
            &json!({"connection":"x","path":"a","content":"ก".repeat(MAX_CONTENT_BYTES / 3 + 1)})
        )
        .is_err());
    }
    #[test]
    fn schema_and_results_keep_approval_and_failure_contracts() {
        let tools = tool_defs();
        assert_eq!(tools.as_array().unwrap().len(), 7);
        for tool in tools.as_array().unwrap() {
            let mutation = matches!(tool["name"].as_str().unwrap(), "run_command" | "write_file");
            assert_eq!(tool["annotations"]["readOnlyHint"], !mutation);
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        }
        let out = exec_result(ExecOutput {
            stdout: "out".into(),
            stderr: "error".into(),
            exit_code: Some(17),
            ..Default::default()
        });
        assert_eq!(out["isError"], true);
        assert_eq!(out["structuredContent"]["exitCode"], 17);
        assert!(out["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("error"));
        assert_eq!(
            exec_result(ExecOutput {
                exit_code: Some(0),
                truncated: true,
                ..Default::default()
            })["isError"],
            true
        );
        assert_eq!(
            exec_result(ExecOutput {
                exit_code: Some(0),
                ..Default::default()
            })["isError"],
            false
        );
    }
    #[test]
    fn shell_quote_preserves_literal_paths() {
        assert_eq!(sh(""), "''");
        assert_eq!(
            sh("/a'b/$(touch nope)\nnext"),
            "'/a'\\''b/$(touch nope)\nnext'"
        );
    }
    #[test]
    fn connection_ids_take_precedence_and_duplicate_names_require_ids() {
        let connection = |id: &str, name: &str| {
            serde_json::from_value::<Connection>(json!({"id":id,"name":name,"host":"example.test","port":22,"username":"test","authType":"password"})).unwrap()
        };
        let connections = vec![
            connection("id-one", "Production"),
            connection("id-two", "production"),
            connection("id-three", "id-one"),
        ];
        assert_eq!(
            find_connection(&connections, "id-one").unwrap().id,
            "id-one"
        );
        assert_eq!(
            find_connection(&connections, "PRODUCTION")
                .unwrap_err()
                .code,
            "ambiguous_connection"
        );
        assert_eq!(
            find_connection(&connections, "missing").unwrap_err().code,
            "connection_not_found"
        );
    }
    #[tokio::test]
    async fn shutdown_cancels_existing_and_late_listeners() {
        let (tx, rx) = watch::channel(false);
        let late = rx.clone();
        let task = tokio::spawn(cancelled(rx));
        tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), cancelled(late))
            .await
            .unwrap();
    }
}
