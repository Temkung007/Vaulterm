import { readFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8765/mcp';
const PROTOCOL = '2025-06-18';
const INPUT_LIMIT = 1024 * 1024;
const COMMAND_LIMIT = 64 * 1024;
// MCP includes both text content and structured streams; JSON control-byte
// escaping can expand a valid 16 MiB capture into a response over 192 MiB.
const RESPONSE_LIMIT = 256 * 1024 * 1024;
const EXIT = { USAGE: 2, CONFIG: 3, TRANSPORT: 4, AUTH: 5, PROTOCOL: 6, TOOL: 7, TIMEOUT: 8, REMOTE: 10, INTERRUPTED: 130 };
const OPTIONS = {
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' }, text: { type: 'boolean' },
  endpoint: { type: 'string' }, 'token-file': { type: 'string' },
  timeout: { type: 'string' }, config: { type: 'string' },
  command: { type: 'string' }, 'command-file': { type: 'string' },
  content: { type: 'string' }, input: { type: 'string' },
  args: { type: 'string' }, 'args-file': { type: 'string' },
  lines: { type: 'string' }, value: { type: 'string' },
  'remote-timeout': { type: 'string' }, 'max-output-bytes': { type: 'string' },
};
const GLOBAL = ['help', 'version', 'json', 'text', 'endpoint', 'token-file', 'timeout', 'config'];
const LIMITS = ['remote-timeout', 'max-output-bytes'];
const COMMANDS = [
  { path: 'schema', usage: 'schema', description: 'Offline machine-readable command catalog, flags, limits and exit codes.', min: 0, max: 0 },
  { path: 'doctor', usage: 'doctor', description: 'Check configuration, authentication and the live MCP connection.', min: 0, max: 0 },
  { path: 'config path', usage: 'config path', description: 'Show the resolved CLI config file path.', min: 0, max: 0 },
  { path: 'config show', usage: 'config show', description: 'Show effective configuration with the token redacted.', min: 0, max: 0 },
  { path: 'config set', usage: 'config set endpoint --value URL | config set token --input FILE|-', description: 'Save an endpoint or bearer token. Token input never appears in output.', min: 1, max: 1, options: ['value', 'input'] },
  { path: 'config reset', usage: 'config reset', description: 'Remove the CLI configuration and its stored token.', min: 0, max: 0 },
  { path: 'tools list', usage: 'tools list', description: 'Discover the server tools and their JSON input schemas.', min: 0, max: 0, method: 'tools/list' },
  { path: 'tools call', usage: 'tools call NAME [--args JSON | --args-file FILE|-]', description: 'Call any advertised MCP tool with a JSON object.', min: 1, max: 1, options: ['args', 'args-file'] },
  { path: 'connections list', usage: 'connections list', description: 'List saved SSH connection IDs and metadata without credentials.', min: 0, max: 0, tool: 'list_connections' },
  { path: 'server status', usage: 'server status CONNECTION', description: 'Read remote OS, uptime, CPU, memory and disk status.', min: 1, max: 1, options: LIMITS, tool: 'server_status' },
  { path: 'exec', usage: 'exec CONNECTION (--command TEXT | --command-file FILE|-)', description: 'Execute a remote shell command after approval in the desktop app.', min: 1, max: 1, options: ['command', 'command-file', ...LIMITS], tool: 'run_command', approval: true },
  { path: 'files list', usage: 'files list CONNECTION [PATH]', description: 'List a remote directory (default .) using the remote POSIX shell.', min: 1, max: 2, options: LIMITS, tool: 'list_directory' },
  { path: 'files read', usage: 'files read CONNECTION PATH', description: 'Read a remote UTF-8 text file.', min: 2, max: 2, options: LIMITS, tool: 'read_file' },
  { path: 'files tail', usage: 'files tail CONNECTION PATH [--lines 100]', description: 'Read the last 1..10000 lines of a remote text file.', min: 2, max: 2, options: ['lines', ...LIMITS], tool: 'tail_log' },
  { path: 'files write', usage: 'files write CONNECTION PATH (--content TEXT | --input FILE|-)', description: 'Overwrite a remote text file after desktop approval. Input may be empty.', min: 2, max: 2, options: ['content', 'input', ...LIMITS], tool: 'write_file', approval: true },
];

class CliError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => { throw new CliError(code, message, details); };
const own = (object, key) => Object.hasOwn(object, key);

function positiveInteger(value, name, min, max) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    fail('USAGE', `${name} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
}

function endpoint(value, code = 'CONFIG') {
  let url;
  try { url = new URL(value); } catch { fail(code, 'Endpoint must be an HTTP loopback URL ending in /mcp.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    fail(code, 'Endpoint must be http://127.0.0.1:PORT/mcp, http://localhost:PORT/mcp or http://[::1]:PORT/mcp without credentials, query or fragment.');
  }
  return url.href;
}

function configPath(options, env) {
  const base = process.platform === 'win32' ? (env.APPDATA || join(homedir(), 'AppData', 'Roaming')) : (env.XDG_CONFIG_HOME || join(homedir(), '.config'));
  return resolve(options.config ?? env.TERMKIN_CONFIG ?? join(base, 'termkin', 'cli.json'));
}

async function readBounded(source, input, limit = INPUT_LIMIT) {
  let bytes;
  if (source === '-') {
    if (input.isTTY) fail('USAGE', 'Stdin must be piped when FILE is "-".');
    const chunks = [];
    let length = 0;
    for await (const chunk of input) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += part.length;
      if (length > limit) fail('USAGE', `Input exceeds ${limit} bytes.`);
      chunks.push(part);
    }
    bytes = Buffer.concat(chunks);
  } else {
    try {
      const info = await stat(source);
      if (!info.isFile()) fail('USAGE', 'Input path must be a regular file.');
      if (info.size > limit) fail('USAGE', `Input exceeds ${limit} bytes.`);
      // Read a bounded stream too: a file may grow after stat().
      const handle = await open(source, 'r');
      try { return await readBounded('-', handle.createReadStream(), limit); }
      finally { await handle.close(); }
    } catch (error) {
      if (error instanceof CliError) throw error;
      fail('USAGE', `Cannot read input file (${error.code || 'IO_ERROR'}).`);
    }
  }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('USAGE', 'Input must be valid UTF-8 text. Binary transfer is not supported.'); }
}

async function loadConfig(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    fail('CONFIG', `Cannot read CLI configuration (${error.code || 'IO_ERROR'}).`);
  }
  try {
    const config = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        (own(config, 'token') && typeof config.token !== 'string') ||
        (own(config, 'endpoint') && typeof config.endpoint !== 'string')) throw new Error();
    return config;
  } catch { fail('CONFIG', 'Invalid CLI configuration. Use config reset to remove it, or repair the JSON file.'); }
}

async function saveConfig(path, config) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8'); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) { fail('CONFIG', `Cannot save CLI configuration (${error.code || 'IO_ERROR'}).`); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

function tokenValue(value) {
  const token = value.trim();
  if (!token || Buffer.byteLength(token) > 4096 || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) fail('CONFIG', 'Bearer token is empty or invalid. Copy the token from Termkin Settings.');
  return token;
}

async function effectiveConfig(options, env, path, input) {
  const saved = await loadConfig(path);
  const url = endpoint(options.endpoint ?? env.TERMKIN_ENDPOINT ?? saved.endpoint ?? DEFAULT_ENDPOINT);
  let token;
  let tokenSource = 'none';
  if (own(options, 'token-file')) {
    token = tokenValue(await readBounded(options['token-file'], input, 4096));
    tokenSource = 'file';
  } else if (own(env, 'TERMKIN_TOKEN')) {
    token = tokenValue(env.TERMKIN_TOKEN);
    tokenSource = 'environment';
  } else if (own(saved, 'token')) {
    token = tokenValue(saved.token);
    tokenSource = 'config';
  }
  return { endpoint: url, token, tokenSource, configPath: path };
}

async function version() {
  return JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
}

function catalog() {
  return {
    name: 'termkin', schemaVersion: 1, output: 'json',
    success: { ok: true, data: 'command result' },
    failure: { ok: false, error: { code: 'stable error code', message: 'description', details: 'optional server result' } },
    commands: COMMANDS.map(({ min, max, ...command }) => ({ ...command, positionalCount: { min, max } })),
    globalOptions: {
      '--json': 'One JSON envelope on stdout (default).', '--text': 'Readable text; remote stdout/stderr are separate streams.',
      '--config PATH': 'Override TERMKIN_CONFIG and the per-user config path.',
      '--endpoint URL': 'Override TERMKIN_ENDPOINT and the saved HTTP loopback endpoint.',
      '--token-file FILE|-': 'Read bearer token; overrides TERMKIN_TOKEN and saved token.',
      '--timeout SECONDS': 'Client deadline, integer 1..7200; automatic default max(195, remote-timeout+135).',
      '--help, -h': 'Show all commands or command-specific help.', '--version, -v': 'Show the package version.',
    },
    environment: ['TERMKIN_TOKEN', 'TERMKIN_ENDPOINT', 'TERMKIN_CONFIG'],
    limits: { inputBytes: INPUT_LIMIT, commandBytes: COMMAND_LIMIT, pathBytes: 4096, remoteTimeoutSeconds: { default: 60, min: 1, max: 3600 }, maxOutputBytes: { default: 1048576, min: 1, max: 16777216 }, tailLines: { default: 100, min: 1, max: 10000 } },
    exitCodes: { SUCCESS: 0, ...EXIT },
    notes: [
      'Open Termkin, unlock the vault, enable the MCP server in Settings, and configure its bearer token.',
      'Remote commands run in independent non-interactive POSIX shells. Use explicit paths; no persistent cwd or environment.',
      'exec and files write require approval in the desktop app (up to 120 seconds). No CLI option bypasses approval.',
      'Timeout or cancellation cannot guarantee a remote command stopped. Inspect remote state before retrying writes.',
      'tools list returns the live server tool schemas; schema works offline.',
    ],
  };
}

function help(words) {
  const path = words.join(' ');
  const commands = path ? COMMANDS.filter((command) => command.path === path || command.path.startsWith(`${path} `)) : COMMANDS;
  if (!commands.length) fail('USAGE', `Unknown help topic: ${path}. Run termkin --help.`);
  return [
    'Termkin CLI — saved SSH connections for scripts and AI agents', '',
    ...commands.map((command) => `  termkin ${command.usage}\n    ${command.description}`), '',
    'Global: --json (default), --text, --config PATH, --endpoint URL,',
    '        --token-file FILE|-, --timeout SECONDS, --help, --version',
    'SSH limits: --remote-timeout SECONDS (1..3600, default 60),',
    '            --max-output-bytes N (1..16777216, default 1048576)',
    'Environment: TERMKIN_TOKEN, TERMKIN_ENDPOINT, TERMKIN_CONFIG',
    'Use "termkin schema" for offline JSON metadata and exit codes.',
    'Use "termkin tools list" for live tool input schemas.',
    'Setup: unlock Termkin > Settings > enable MCP; pipe its token into',
    '       termkin config set token --input -',
    'exec/files write wait for approval in the desktop app.', '',
  ].join('\n');
}

function parse(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, tokens: true }); }
  catch (error) { fail('USAGE', error.message); }
  const { values: options, positionals: words, tokens } = parsed;
  const used = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (used.has(token.name)) fail('USAGE', `Option --${token.name} may only appear once.`);
    used.add(token.name);
  }
  if (options.json && options.text) fail('USAGE', 'Choose either --json or --text.');
  if (options.version) return { options, special: 'version' };
  if (!words.length || options.help || words[0] === 'help') {
    const topic = words[0] === 'help' ? words.slice(1) : words;
    const match = COMMANDS.find((candidate) => candidate.path.split(' ').every((word, index) => topic[index] === word));
    return { options, special: 'help', words: match ? match.path.split(' ') : topic };
  }
  const command = COMMANDS.find((candidate) => candidate.path.split(' ').every((word, index) => words[index] === word));
  if (!command) fail('USAGE', `Unknown command: ${words.slice(0, 2).join(' ')}. Run termkin --help.`);
  const args = words.slice(command.path.split(' ').length);
  if (args.length < command.min || args.length > command.max) fail('USAGE', `Usage: termkin ${command.usage}`);
  const allowed = new Set([...GLOBAL, ...(command.options || [])]);
  for (const name of Object.keys(options)) if (!allowed.has(name)) fail('USAGE', `--${name} is not valid for ${command.path}.`);
  if (own(options, 'timeout')) positiveInteger(options.timeout, '--timeout', 1, 7200);
  return { options, command, args };
}

async function selectedInput(options, inline, file, input) {
  if (own(options, inline) === own(options, file)) fail('USAGE', `Specify exactly one of --${inline} or --${file}.`);
  if (own(options, file)) return readBounded(options[file], input);
  const value = options[inline];
  if (Buffer.byteLength(value) > INPUT_LIMIT) fail('USAGE', `Input exceeds ${INPUT_LIMIT} bytes.`);
  return value;
}

async function toolArguments(command, args, options, input) {
  if (command.path === 'tools call') {
    if (!args[0].trim()) fail('USAGE', 'Tool name must not be empty.');
    let value = {};
    if (own(options, 'args') || own(options, 'args-file')) {
      const raw = await selectedInput(options, 'args', 'args-file', input);
      try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); }
      catch { fail('USAGE', 'Tool arguments must be valid JSON.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('USAGE', 'Tool arguments must be a JSON object.');
    }
    return { name: args[0], arguments: value };
  }
  const value = {};
  if (args[0] !== undefined) {
    if (!args[0].trim()) fail('USAGE', 'Connection name or ID must not be empty.');
    value.connection = args[0];
  }
  if (command.path.startsWith('files ')) {
    value.path = args[1] ?? '.';
    if (!value.path || value.path.includes('\0')) fail('USAGE', 'Remote path must not be empty or contain NUL.');
    if (Buffer.byteLength(value.path) > 4096) fail('USAGE', 'Remote path exceeds 4096 UTF-8 bytes.');
  }
  if (command.path === 'exec') {
    value.command = await selectedInput(options, 'command', 'command-file', input);
    if (!value.command.trim() || value.command.includes('\0')) fail('USAGE', 'Command must not be empty or contain NUL.');
    if (Buffer.byteLength(value.command) > COMMAND_LIMIT) fail('USAGE', `Command exceeds ${COMMAND_LIMIT} UTF-8 bytes. Use files write to upload a script, then execute its path.`);
  }
  if (command.path === 'files write') value.content = await selectedInput(options, 'content', 'input', input);
  if (own(options, 'lines')) value.lines = positiveInteger(options.lines, '--lines', 1, 10000);
  if (own(options, 'remote-timeout')) value.timeout_seconds = positiveInteger(options['remote-timeout'], '--remote-timeout', 1, 3600);
  if (own(options, 'max-output-bytes')) value.max_output_bytes = positiveInteger(options['max-output-bytes'], '--max-output-bytes', 1, 16777216);
  return { name: command.tool, arguments: value };
}

class McpClient {
  constructor(config, signal, fetchImpl) {
    this.config = config;
    this.signal = signal;
    this.fetch = fetchImpl;
    this.id = 0;
    this.session = undefined;
  }
  async request(method, params, notification = false) {
    const id = notification ? undefined : ++this.id;
    let response;
    try {
      response = await this.fetch(this.config.endpoint, {
        method: 'POST', redirect: 'error', signal: this.signal,
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${this.config.token}`, 'MCP-Protocol-Version': PROTOCOL,
          ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
      });
    } catch {
      if (this.signal.aborted) throw this.signal.reason;
      fail('TRANSPORT', 'Cannot reach Termkin. Open the app, unlock the vault and enable MCP in Settings. Redirects are refused.');
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      fail('AUTH', 'Termkin rejected the bearer token. Copy the current token from Settings and update the CLI configuration.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail('TRANSPORT', `Termkin returned HTTP ${response.status}.`);
    }
    if (method === 'initialize') this.session = response.headers.get('mcp-session-id') || undefined;
    if (notification) { await response.body?.cancel(); return; }
    let bytes = 0;
    const chunks = [];
    const reader = response.body?.getReader();
    if (!reader) fail('PROTOCOL', 'Termkin returned an empty response.');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > RESPONSE_LIMIT) {
          await reader.cancel();
          fail('PROTOCOL', 'Termkin response exceeded the size limit.');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (this.signal.aborted) throw this.signal.reason;
      if (error instanceof CliError) throw error;
      fail('TRANSPORT', 'Connection closed while reading the Termkin response.');
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('PROTOCOL', 'Termkin returned invalid JSON. A JSON MCP endpoint is required.'); }
    if (!body || body.jsonrpc !== '2.0' || body.id !== id) fail('PROTOCOL', 'Invalid JSON-RPC response or mismatched request ID.');
    if (body.error) fail('PROTOCOL', body.error.message || 'MCP request failed.', { rpcCode: body.error.code });
    if (!own(body, 'result')) fail('PROTOCOL', 'MCP response has no result.');
    return body.result;
  }
  async initialize(clientVersion) {
    const info = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'termkin-cli', version: clientVersion } });
    if (info?.protocolVersion !== PROTOCOL || !info?.capabilities?.tools || !info?.serverInfo) fail('PROTOCOL', 'The endpoint does not support the expected MCP tools protocol.');
    await this.request('notifications/initialized', undefined, true);
    return info;
  }
}

function unpackTool(result, name) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) fail('PROTOCOL', 'Invalid MCP tool result.');
  if (own(result, 'isError') && typeof result.isError !== 'boolean') fail('PROTOCOL', 'Invalid MCP tool error flag.');
  const text = result.content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n');
  let data = result.structuredContent;
  if (own(result, 'structuredContent') && (!data || typeof data !== 'object' || Array.isArray(data))) fail('PROTOCOL', 'Invalid structured MCP tool result.');
  if (data === undefined) {
    // Compatibility with Termkin versions predating structured MCP output.
    if (name === 'list_connections' && !result.isError) {
      try { data = { connections: JSON.parse(text) }; }
      catch { fail('PROTOCOL', 'Connection list is not valid JSON.'); }
      if (!Array.isArray(data.connections)) fail('PROTOCOL', 'Connection list must be an array.');
    } else data = { text, legacy: true };
  }
  if (!data.legacy && !data.error) {
    if (name === 'list_connections' && (!Array.isArray(data.connections) || data.connections.some((c) => !c ||
      !['id', 'name', 'host', 'username'].every((key) => typeof c[key] === 'string') || !Number.isInteger(c.port)))) {
      fail('PROTOCOL', 'Invalid structured connection list.');
    }
    if (['server_status', 'list_directory', 'read_file', 'tail_log', 'run_command', 'write_file'].includes(name) &&
        (typeof data.stdout !== 'string' || typeof data.stderr !== 'string' ||
        !(data.exitCode === null || (Number.isInteger(data.exitCode) && data.exitCode >= 0 && data.exitCode <= 4294967295)) ||
        !(data.signal === null || typeof data.signal === 'string') || typeof data.truncated !== 'boolean' || typeof data.timedOut !== 'boolean' ||
        (own(data, 'stdinError') && typeof data.stdinError !== 'string'))) {
      fail('PROTOCOL', 'Invalid structured execution result.');
    }
  }
  if (result.isError || data.error || data.timedOut || data.truncated || data.signal || data.stdinError || (own(data, 'exitCode') && data.exitCode !== 0)) {
    const remote = own(data, 'stdout') && own(data, 'exitCode');
    const reason = data.timedOut ? 'Remote execution timed out.' : data.truncated ? 'Remote output exceeded the capture limit.' : data.stdinError ? 'Could not send all input to the remote command.' : data.signal ? `Remote command terminated by signal ${data.signal}.` : data.exitCode === null ? 'Remote command ended without an exit status.' : `Remote command exited with status ${data.exitCode}.`;
    fail(remote ? 'REMOTE' : 'TOOL', data.error?.message || (remote ? reason : text || 'MCP tool failed.'), data);
  }
  return data;
}

async function execute(parsed, context) {
  const { options, command, args } = parsed;
  const { env, input, fetchImpl } = context;
  const path = configPath(options, env);
  if (command.path === 'schema') return catalog();
  if (command.path === 'config path') return { path };
  if (command.path === 'config reset') {
    try { await rm(path, { force: true }); }
    catch (error) { fail('CONFIG', `Cannot reset CLI configuration (${error.code || 'IO_ERROR'}).`); }
    return { path, reset: true };
  }
  if (command.path === 'config set') {
    if (!['endpoint', 'token'].includes(args[0])) fail('USAGE', 'Config key must be endpoint or token.');
    let value;
    if (args[0] === 'endpoint') {
      if (!own(options, 'value') || own(options, 'input')) fail('USAGE', 'Use config set endpoint --value URL.');
      value = endpoint(options.value, 'USAGE');
    } else {
      if (!own(options, 'input') || own(options, 'value')) fail('USAGE', 'Use config set token --input FILE|-.');
      value = tokenValue(await readBounded(options.input, input, 4096));
    }
    const config = await loadConfig(path);
    config[args[0]] = value;
    await saveConfig(path, config);
    return { path, key: args[0], saved: true };
  }
  // Validate command input before contacting the app or reading credentials.
  if (options['token-file'] === '-' && ['input', 'command-file', 'args-file'].some((key) => options[key] === '-')) fail('USAGE', 'Stdin can supply either the token or command input, not both.');
  const call = command.tool || command.path === 'tools call' ? await toolArguments(command, args, options, input) : undefined;
  const config = await effectiveConfig(options, env, path, input);
  if (command.path === 'config show') return { path, endpoint: config.endpoint, tokenConfigured: !!config.token, tokenSource: config.tokenSource };
  if (!config.token) fail('CONFIG', 'No bearer token configured. Enable MCP in Termkin Settings, then use TERMKIN_TOKEN or config set token --input FILE|-.');
  const remoteTimeout = call?.arguments?.timeout_seconds;
  const remoteSeconds = Number.isInteger(remoteTimeout) && remoteTimeout >= 1 && remoteTimeout <= 3600 ? remoteTimeout : 60;
  const seconds = options.timeout === undefined ? Math.max(195, remoteSeconds + 135) : Number(options.timeout);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CliError('TIMEOUT', `Client deadline exceeded (${seconds}s). A remote command may still be running; inspect its state before retrying.`)), seconds * 1000);
  const interrupt = () => controller.abort(new CliError('INTERRUPTED', 'Interrupted. A remote command may still be running; inspect its state before retrying.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const client = new McpClient(config, controller.signal, fetchImpl);
    const info = await client.initialize(await version());
    if (command.path === 'doctor') {
      const tools = await client.request('tools/list', {});
      if (!Array.isArray(tools?.tools)) fail('PROTOCOL', 'Server returned an invalid tool catalog.');
      return { reachable: true, authenticated: true, endpoint: config.endpoint, configPath: path, tokenSource: config.tokenSource, server: info.serverInfo, protocolVersion: info.protocolVersion, tools: tools.tools.map((tool) => tool.name) };
    }
    if (command.path === 'tools list') {
      const tools = [];
      const seen = new Set();
      let cursor;
      do {
        const page = await client.request('tools/list', cursor ? { cursor } : {});
        if (!Array.isArray(page?.tools)) fail('PROTOCOL', 'Server returned an invalid tool catalog.');
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || seen.has(cursor) || seen.size >= 100)) fail('PROTOCOL', 'Invalid tool catalog pagination.');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return { tools };
    }
    return unpackTool(await client.request('tools/call', call), call.name);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

function writeText(data, output, errors) {
  if (typeof data.stdout === 'string') {
    output.write(data.stdout);
    if (typeof data.stderr === 'string' && data.stderr) errors.write(data.stderr);
  } else if (typeof data.text === 'string') output.write(data.text);
  else if (Array.isArray(data.connections)) {
    output.write(['ID\tNAME\tHOST\tPORT\tUSER', ...data.connections.map((c) => [c.id, c.name, c.host, c.port, c.username].map((v) => String(v ?? '').replace(/[\r\n\t]/g, ' ')).join('\t'))].join('\n') + '\n');
  } else output.write(`${JSON.stringify(data, null, 2)}\n`);
}

export async function run(argv, { env = process.env, input = process.stdin, output = process.stdout, errors = process.stderr, fetchImpl = globalThis.fetch } = {}) {
  // Parse failures still follow the requested output mode.
  let textMode = argv.includes('--text') && !argv.includes('--json');
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) fail('CONFIG', 'Termkin CLI requires Node.js 22 or newer.');
    const parsed = parse(argv);
    textMode = !!parsed.options.text;
    if (parsed.special) {
      output.write(parsed.special === 'help' ? help(parsed.words) : `${await version()}\n`);
      return 0;
    }
    const data = await execute(parsed, { env, input, fetchImpl });
    if (textMode) writeText(data, output, errors);
    else output.write(`${JSON.stringify({ ok: true, data })}\n`);
    return 0;
  } catch (error) {
    const known = error instanceof CliError;
    const code = known ? error.code : 'TRANSPORT';
    const message = known ? error.message : 'Unexpected local I/O failure.';
    if (textMode) {
      if (error.details && own(error.details, 'stdout')) writeText(error.details, output, errors);
      errors.write(`${code}: ${message}\n`);
    } else output.write(`${JSON.stringify({ ok: false, error: { code, message, ...(known && error.details !== undefined ? { details: error.details } : {}) } })}\n`);
    return EXIT[code] || EXIT.TRANSPORT;
  }
}
