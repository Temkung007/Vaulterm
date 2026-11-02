# Termkin CLI

The CLI lets scripts and AI agents use the SSH connections saved in the Termkin
desktop app. It talks to the app's authenticated loopback MCP endpoint; SSH
passwords and private keys stay in the encrypted vault.

The desktop app must be running, its vault unlocked, and **Settings → MCP server
(AI access)** enabled. The CLI does not unlock the vault or approve requests.

## Install and connect

Requires **Node.js 22 or later**. The CLI uses Node's built-in modules and has no
additional runtime dependencies. From this repository:

```sh
node cli/termkin.mjs --help
pnpm cli --help
# Equivalent npm command:
npm run cli -- --help
```

Optionally run `npm link` in the repository to make `termkin` available on your
PATH. The examples below use that command. For automation, use `termkin` or
`node cli/termkin.mjs` directly: package managers may print their own banners
around the CLI's JSON output.

1. Open Termkin and unlock the vault.
2. Enable the MCP server in Settings and copy its bearer token.
3. Supply that token through `TERMKIN_TOKEN`, `--token-file`, or the CLI's config.

For example, PowerShell can read the token without including its value in the
command history:

```powershell
$env:TERMKIN_TOKEN = Read-Host 'Paste the MCP bearer token'
termkin doctor
termkin connections list
```

To save the token for later invocations:

```powershell
Read-Host 'Paste the MCP bearer token' | termkin config set token --input -
termkin config show
```

`config show` reports whether a token is configured and never prints its value.
The CLI config contains the bearer token, not the vault's encryption key or SSH
credentials. Treat that config as a credential file; do not commit it. Use
`termkin config path` to find it or `termkin config reset` to remove it.

## Commands

| Command | Purpose |
| --- | --- |
| `help [COMMAND…]`, `--help` | Usage, options, and examples |
| `--version` | CLI version |
| `schema` | Offline, machine-readable CLI command and option metadata |
| `doctor` | Check connectivity and MCP authentication |
| `tools list` | Discover the running server's MCP tools and input schemas |
| `tools call NAME --args JSON` | Invoke any advertised MCP tool |
| `tools call NAME --args-file FILE` | Load tool arguments from JSON; `-` reads stdin |
| `connections list` | List saved connections without secrets |
| `server status CONNECTION` | OS, kernel, uptime, CPU, memory, and disk information |
| `exec CONNECTION --command COMMAND` | Execute a remote shell command |
| `exec CONNECTION --command-file FILE` | Execute a command loaded from a file; `-` reads stdin |
| `files list CONNECTION [PATH]` | List a directory; default path is `.` |
| `files read CONNECTION PATH` | Read a remote text file |
| `files tail CONNECTION PATH --lines N` | Read the last N lines; default is 100 |
| `files write CONNECTION PATH --content TEXT` | Overwrite a remote file with text |
| `files write CONNECTION PATH --input FILE` | Write local UTF-8 text; `-` reads stdin |
| `config path` | Print the config file location |
| `config show` | Show configuration with the token redacted |
| `config set endpoint --value URL` | Save the loopback MCP endpoint |
| `config set token --input FILE` | Save a token from a file; `-` reads stdin |
| `config reset` | Remove the CLI config |

Use a connection's exact ID or its case-insensitive name. When names are
ambiguous, use the ID from `connections list`.

`exec` and `files write` ask for approval in the desktop app. Approval can take
up to 120 seconds. There is no CLI flag that bypasses it.

File tools use commands on a POSIX remote shell. Directory listings are `ls`
text in `stdout`; they are not arrays of file entries. File reads and writes are
for text. Use the desktop SFTP browser for binary uploads and downloads.

## Options and configuration

| Option | Meaning |
| --- | --- |
| `--json` | Emit one JSON result; this is the default |
| `--text` | Emit readable output; remote stdout and stderr remain separate streams |
| `--config FILE` | Use a different CLI config file |
| `--endpoint URL` | Override the MCP endpoint |
| `--token-file FILE` | Read the MCP bearer token from a file; `-` reads stdin |
| `--timeout SECONDS` | Set the client request deadline; integer 1–7200 |
| `--remote-timeout SECONDS` | Bound remote execution; integer 1–3600 |
| `--max-output-bytes N` | Bound captured remote output; integer 1–16777216 |

Global options can be combined with commands. Remote execution options apply to
SSH-backed commands, including file reads and server status. With `tools call`,
the tool's own input schema describes its accepted arguments.

Configuration precedence is explicit flags, then environment variables, then
the config file, then defaults:

| Environment variable | Purpose |
| --- | --- |
| `TERMKIN_TOKEN` | MCP bearer token |
| `TERMKIN_ENDPOINT` | MCP endpoint |
| `TERMKIN_CONFIG` | CLI config file path |

The default endpoint is `http://127.0.0.1:8765/mcp`. Only HTTP loopback endpoints
are accepted. The CLI does not send the token to an arbitrary remote URL.

Remote execution defaults to **60 seconds** and **1 MiB** of combined captured
output. The client timeout defaults to at least **195 seconds**, increasing with
`--remote-timeout` to allow for desktop approval and execution. If setting
`--timeout` explicitly, allow 120 seconds for approval plus the remote timeout
and network overhead for commands that need approval.

Shell command text is limited to **65536 UTF-8 bytes** and remote paths to
**4096 UTF-8 bytes**. File content and
tool-argument input are limited to **1 MiB** and must be valid UTF-8. Token input
is limited to **4096 bytes**. Stdin can supply either a token or command input in
one invocation, not both. File writes stream content through SSH stdin. Every
remote call uses an independent non-interactive shell, with no persistent
working directory or environment between calls.

## JSON output and exit status

Successful commands emit one JSON object on stdout:

```json
{"ok":true,"data":{"connections":[{"id":"connection-id","name":"staging","host":"example.com","port":22,"username":"deploy"}]}}
```

Execution results include `stdout`, `stderr`, `exitCode`, `signal`, `truncated`,
and `timedOut`. An optional `stdinError` describes a failure to send remote input;
it also makes the command fail:

```json
{"ok":true,"data":{"stdout":"Linux\n","stderr":"","exitCode":0,"signal":null,"truncated":false,"timedOut":false}}
```

Failures use `{ "ok": false, "error": { "code": "…", "message": "…" } }`
with optional `details`. Remote failures retain execution information in their
details. An exit code of `null` means the server did not supply a numeric exit
status; do not assume success. Truncated output and timeouts are failures rather
than silently complete results.

Help and `--version` are readable text. Use `schema` for offline machine-readable
discovery. `--text` is useful for terminal use; JSON is the default for agents.

Older Termkin desktop versions can return text-only MCP results. The CLI labels
these `{ "text": "…", "legacy": true }`; a legacy connection list is still
decoded into `connections`. Legacy execution results do not contain trustworthy
remote exit-status metadata. Upgrade the desktop app when an agent needs to
verify execution success.

| Process exit status | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Invalid command, option, or input |
| `3` | Missing or invalid configuration |
| `4` | Connection or HTTP transport failure |
| `5` | MCP authentication failed |
| `6` | Invalid or unsupported MCP response |
| `7` | MCP tool failed, including a denied approval |
| `8` | Client request timed out |
| `10` | Remote execution failed; inspect its execution details |
| `130` | Interrupted |

The CLI's process status is not the remote command's exit status. For example,
a remote command exiting with 42 produces process status 10 and reports 42 in
its execution details.

## Examples

```sh
termkin schema
termkin tools list
termkin connections list
termkin server status staging
termkin exec staging --command "uname -a"
termkin files list staging /var/log
termkin files read staging /etc/os-release
termkin files tail staging /var/log/syslog --lines 50
termkin files write staging /tmp/notes.txt --input ./notes.txt
termkin exec staging --command-file ./check-server.sh --remote-timeout 180
```

Use files or stdin when JSON, shell commands, or file content contains quotes,
newlines, or shell metacharacters. For example, save this as `arguments.json`:

```json
{
  "connection": "staging",
  "path": "/etc/os-release",
  "timeout_seconds": 30,
  "max_output_bytes": 65536
}
```

Then invoke the tool without embedding JSON in a shell command:

```sh
termkin tools call read_file --args-file ./arguments.json
```

For generated tool arguments, pass the JSON directly over stdin using
`termkin tools call read_file --args-file -`. For generated file content, use
`termkin files write staging /tmp/notes.txt --input -`. The CLI never interprets
that input as a local shell command.

## Guidance for AI agents

1. Run `termkin schema` to discover the CLI without requiring a running desktop
   server. Use `termkin tools list` for the running server's current tool schemas.
2. Run `termkin doctor`, then `termkin connections list`. Reuse the returned
   connection IDs to avoid ambiguous names.
3. Keep the default JSON mode. Parse `ok` and the process exit status before using
   the result. For execution data, inspect `stderr`, `exitCode`, `signal`,
   `truncated`, `timedOut`, and any `stdinError` as well as `stdout`.
4. Send complex arguments and content through files or stdin. Use the tool input
   schema's argument names, including `timeout_seconds` and `max_output_bytes`.
5. Allow time for desktop approval. Tell the user when an execution or write is
   waiting for their approval; the CLI cannot grant it.
6. Do not automatically retry writes or commands after a timeout or lost
   connection. The remote action may already have started. Inspect the remote
   state before deciding whether to retry.

## Troubleshooting

- **Connection refused:** open Termkin, unlock the vault, and enable its MCP
  server. Check that the CLI endpoint matches Settings.
- **Unauthorized:** update `TERMKIN_TOKEN`, the token file, or saved config with
  the token shown in Settings. A higher-precedence source overrides saved config.
- **Approval denied or expired:** review the request in the desktop app and run
  it again only if appropriate.
- **Changed SSH host key:** review and trust the key through the desktop app.
  The CLI does not bypass host-key verification.
- **Truncated result:** narrow the command or increase `--max-output-bytes` within
  the supported limit.
- **Timeout:** distinguish a client timeout from `timedOut` in remote execution
  details. Increase the appropriate deadline and inspect remote state before
  retrying a command that can change it.
