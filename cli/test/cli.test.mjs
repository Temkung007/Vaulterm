import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../core.mjs';

const TOKEN = 'test-token-never-print';
const EXEC = { stdout: 'hello\n', stderr: '', exitCode: 0, signal: null, truncated: false, timedOut: false };
function tool(data, isError = false) {
  return { content: [{ type: 'text', text: data.stdout ?? JSON.stringify(data) }], structuredContent: data, isError };
}
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'termkin-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, config: join(dir, 'cli.json') };
}
async function invoke(argv, { config, stdin = '', env = {}, fetchImpl } = {}) {
  let stdout = '', stderr = '';
  const code = await run(['--config', config, ...argv], {
    env, input: Readable.from([Buffer.isBuffer(stdin) ? stdin : Buffer.from(stdin)]),
    output: { write: (text) => { stdout += text; } }, errors: { write: (text) => { stderr += text; } },
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}
async function server(t, handler = () => tool(EXEC)) {
  const calls = [];
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ body, headers: req.headers });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
    if (!Object.hasOwn(body, 'id')) { res.writeHead(202).end(); return; }
    let result;
    if (body.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-termkin', version: '1' } };
      res.setHeader('Mcp-Session-Id', 'test-session');
    } else result = await handler(body, req, res);
    if (res.writableEnded) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { http.close(resolve); http.closeAllConnections(); }));
  return { calls, env: { TERMKIN_TOKEN: TOKEN, TERMKIN_ENDPOINT: `http://127.0.0.1:${http.address().port}/mcp` } };
}

test('offline discovery and command help do not need config or a server', async (t) => {
  const { config } = await temporary(t);
  await writeFile(config, 'invalid JSON');
  const schema = await invoke(['schema'], { config });
  assert.equal(schema.code, 0);
  assert.equal(schema.json().data.output, 'json');
  assert.equal(schema.json().data.exitCodes.REMOTE, 10);
  assert.ok(schema.json().data.commands.some((c) => c.path === 'files write' && c.approval));
  for (const args of [[], ['--help'], ['help', 'files'], ['exec', 'staging', '--help']]) {
    const help = await invoke(args, { config });
    assert.equal(help.code, 0, help.stdout);
    assert.match(help.stdout, /Termkin CLI/);
  }
  assert.match((await invoke(['--version'], { config })).stdout, /^\d+\.\d+\.\d+\n$/);
});

test('usage failures are JSON and happen before any network request', async (t) => {
  const { config } = await temporary(t);
  const cases = [
    ['nope'], ['connections', 'list', 'extra'], ['exec', 'staging'],
    ['exec', 'staging', '--command', 'one', '--command-file', '-'],
    ['files', 'tail', 'staging', '/log', '--lines', '0'],
    ['files', 'read', 'staging', '/file', '--remote-timeout', '1.5'],
    ['files', 'read', 'staging', '/file', '--max-output-bytes', '16777217'],
    ['connections', 'list', '--lines', '2'], ['connections', 'list', '--typo'],
    ['connections', 'list', '--json', '--text'], ['connections', 'list', '--json', '--json'],
    ['connections', 'list', '--timeout', 'NaN'],
    ['tools', 'call', 'read_file', '--args', '[]'], ['tools', 'call', 'read_file', '--args', '{'],
    ['files', 'write', 'staging', '/file', '--input', '-', '--token-file', '-'],
    ['files', 'read', 'staging', ''], ['exec', '', '--command', 'true'],
    ['exec', 'id', '--command', 'x'.repeat(65537)],
  ];
  for (const args of cases) {
    const result = await invoke(args, { config, fetchImpl: () => assert.fail('Unexpected network request') });
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}`);
    assert.equal(result.json().error.code, 'USAGE');
    assert.equal(result.stderr, '');
  }
});

test('token config roundtrip redacts secrets, supports recovery and private Unix mode', async (t) => {
  const { config } = await temporary(t);
  const saved = await invoke(['config', 'set', 'token', '--input', '-'], { config, stdin: `${TOKEN}\n` });
  assert.equal(saved.code, 0);
  assert.ok(!saved.stdout.includes(TOKEN));
  assert.equal(JSON.parse(await readFile(config, 'utf8')).token, TOKEN);
  if (process.platform !== 'win32') assert.equal((await stat(config)).mode & 0o777, 0o600);
  await invoke(['config', 'set', 'endpoint', '--value', 'http://localhost:8766/mcp'], { config });
  const shown = await invoke(['config', 'show'], { config });
  assert.equal(shown.json().data.tokenConfigured, true);
  assert.equal(shown.json().data.endpoint, 'http://localhost:8766/mcp');
  assert.ok(!shown.stdout.includes(TOKEN));
  await writeFile(config, 'corrupt');
  assert.equal((await invoke(['config', 'show'], { config })).code, 3);
  assert.equal((await invoke(['config', 'reset'], { config })).code, 0);
  assert.equal((await invoke(['config', 'show'], { config })).json().data.tokenConfigured, false);
});

test('only explicit HTTP loopback endpoints are accepted', async (t) => {
  const { config } = await temporary(t);
  for (const value of ['https://example.com/mcp', 'http://example.com/mcp', 'http://127.0.0.1.evil.test/mcp', 'http://127.0.0.1/mcp?token=x', 'http://user:pass@localhost/mcp', 'http://localhost/other']) {
    const result = await invoke(['config', 'set', 'endpoint', '--value', value], { config });
    assert.equal(result.code, 2, value);
  }
  assert.equal((await invoke(['doctor'], { config, env: { TERMKIN_TOKEN: TOKEN, TERMKIN_ENDPOINT: 'https://evil.test/mcp' } })).code, 3);
});

test('MCP initializes, sends session headers, lists connections and reveals no token', async (t) => {
  const { config } = await temporary(t);
  const remote = await server(t, () => tool({ connections: [{ id: 'id', name: 'staging', host: 'host', port: 22, username: 'user' }] }));
  const result = await invoke(['connections', 'list'], { config, env: remote.env });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.json().data.connections[0].id, 'id');
  assert.deepEqual(remote.calls.map((c) => c.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(remote.calls[2].headers['mcp-session-id'], 'test-session');
  assert.deepEqual(remote.calls[2].body.params, { name: 'list_connections', arguments: {} });
  assert.ok(!result.stdout.includes(TOKEN));
});

test('all typed commands map arguments without local shell interpolation', async (t) => {
  const { config } = await temporary(t);
  const remote = await server(t);
  const common = { config, env: remote.env };
  const cases = [
    [['server', 'status', 'id'], 'server_status', { connection: 'id' }],
    [['files', 'list', 'id'], 'list_directory', { connection: 'id', path: '.' }],
    [['files', 'read', 'id', "/tmp/a'b;$HOME"], 'read_file', { connection: 'id', path: "/tmp/a'b;$HOME" }],
    [['files', 'tail', 'id', '/log', '--lines', '50'], 'tail_log', { connection: 'id', path: '/log', lines: 50 }],
    [['exec', 'id', '--command', 'printf "$HOME";\necho done', '--remote-timeout', '180', '--max-output-bytes', '500'], 'run_command', { connection: 'id', command: 'printf "$HOME";\necho done', timeout_seconds: 180, max_output_bytes: 500 }],
    [['files', 'write', 'id', '/empty', '--content', ''], 'write_file', { connection: 'id', path: '/empty', content: '' }],
  ];
  for (const [argv, name, args] of cases) {
    const result = await invoke(argv, common);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(remote.calls.at(-1).body.params, { name, arguments: args });
  }
});

test('UTF-8 stdin and files preserve quotes and newlines, empty files are valid', async (t) => {
  const { config, dir } = await temporary(t);
  const remote = await server(t);
  const text = 'ภาษาไทย\n\'"$()`;\n';
  const source = join(dir, 'input.txt');
  await writeFile(source, text);
  for (const [flag, value, stdin] of [['--input', '-', text], ['--input', source, ''], ['--content', '', '']]) {
    const result = await invoke(['files', 'write', 'id', '/tmp/file', flag, value], { config, env: remote.env, stdin });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(remote.calls.at(-1).body.params.arguments.content, flag === '--content' ? '' : text);
  }
  const command = await invoke(['exec', 'id', '--command-file', source], { config, env: remote.env });
  assert.equal(command.code, 0, command.stdout);
  assert.equal(remote.calls.at(-1).body.params.arguments.command, text);
  const bom = await invoke(['files', 'write', 'id', '/bom.txt', '--input', '-'], { config, env: remote.env, stdin: `\uFEFF${text}` });
  assert.equal(bom.code, 0, bom.stdout);
  assert.equal(remote.calls.at(-1).body.params.arguments.content, `\uFEFF${text}`);
  const invalid = await invoke(['files', 'write', 'id', '/file', '--input', '-'], { config, stdin: Buffer.from([0xff]) });
  assert.equal(invalid.code, 2);
  const large = await invoke(['files', 'write', 'id', '/file', '--input', '-'], { config, stdin: Buffer.alloc(1048577, 65) });
  assert.equal(large.code, 2);
});

test('generic JSON arguments, including BOM, are sent verbatim', async (t) => {
  const { config } = await temporary(t);
  const remote = await server(t);
  const args = { connection: 'id', path: "/tmp/'$()", timeout_seconds: 3 };
  const result = await invoke(['tools', 'call', 'read_file', '--args-file', '-'], { config, env: remote.env, stdin: `\uFEFF${JSON.stringify(args)}` });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(remote.calls.at(-1).body.params, { name: 'read_file', arguments: args });
});

test('configuration precedence uses flag > env > saved token and endpoint', async (t) => {
  const { config, dir } = await temporary(t);
  const remote = await server(t);
  await writeFile(config, JSON.stringify({ token: 'bad-saved', endpoint: 'http://localhost:1/mcp' }));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, TOKEN);
  const result = await invoke(['doctor', '--endpoint', remote.env.TERMKIN_ENDPOINT, '--token-file', tokenFile], { config, env: { TERMKIN_TOKEN: 'bad-env', TERMKIN_ENDPOINT: 'http://localhost:2/mcp' } });
  assert.equal(result.code, 6); // Handler returns exec data instead of a tool catalog; authentication succeeded.
  assert.equal(remote.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const envWins = await invoke(['exec', 'id', '--command', 'true'], { config, env: remote.env });
  assert.equal(envWins.code, 0, envWins.stdout);
});

test('remote errors preserve structured execution and use process status 10', async (t) => {
  const { config } = await temporary(t);
  const variants = [
    { ...EXEC, exitCode: 42, stderr: 'bad\n' }, { ...EXEC, exitCode: null },
    { ...EXEC, timedOut: true }, { ...EXEC, truncated: true }, { ...EXEC, signal: 'TERM' },
    { ...EXEC, stdinError: 'remote input closed' },
  ];
  let current;
  const remote = await server(t, () => tool(current, false));
  for (const data of variants) {
    current = data;
    const result = await invoke(['exec', 'id', '--command', 'false'], { config, env: remote.env });
    assert.equal(result.code, 10, result.stdout);
    assert.equal(result.json().error.code, 'REMOTE');
    assert.deepEqual(result.json().error.details, data);
  }
});

test('approval denied is a tool failure with its server error code', async (t) => {
  const { config } = await temporary(t);
  const remote = await server(t, () => tool({ error: { code: 'approval_denied', message: 'Denied by the user.' } }, true));
  const result = await invoke(['exec', 'id', '--command', 'false'], { config, env: remote.env });
  assert.equal(result.code, 7);
  assert.equal(result.json().error.details.error.code, 'approval_denied');
});

test('text mode keeps remote streams separate on success and failure', async (t) => {
  const { config } = await temporary(t);
  let current = { ...EXEC, stderr: 'warning\n' };
  const remote = await server(t, () => tool(current));
  let result = await invoke(['exec', 'id', '--command', 'test', '--text'], { config, env: remote.env });
  assert.equal(result.stdout, 'hello\n');
  assert.equal(result.stderr, 'warning\n');
  current = { ...current, exitCode: 42 };
  result = await invoke(['exec', 'id', '--command', 'test', '--text'], { config, env: remote.env });
  assert.equal(result.code, 10);
  assert.equal(result.stdout, 'hello\n');
  assert.match(result.stderr, /^warning\nREMOTE:/);
});

test('legacy MCP results remain readable and explicitly lack execution metadata', async (t) => {
  const { config } = await temporary(t);
  const remote = await server(t, (body) => ({ content: [{ type: 'text', text: body.params.name === 'list_connections' ? '[{"id":"legacy","name":"Old","host":"host","username":"user","port":22}]' : 'legacy output' }] }));
  assert.equal((await invoke(['connections', 'list'], { config, env: remote.env })).json().data.connections[0].id, 'legacy');
  const result = await invoke(['files', 'read', 'id', '/file'], { config, env: remote.env });
  assert.deepEqual(result.json().data, { text: 'legacy output', legacy: true });
});

test('doctor and paginated live tool discovery', async (t) => {
  const { config } = await temporary(t);
  const remote = await server(t, (body) => body.params?.cursor ? { tools: [{ name: 'second', inputSchema: {} }] } : { tools: [{ name: 'first', inputSchema: {} }], nextCursor: 'next' });
  const result = await invoke(['tools', 'list'], { config, env: remote.env });
  assert.deepEqual(result.json().data.tools.map((tool) => tool.name), ['first', 'second']);
  const doctor = await invoke(['doctor'], { config, env: remote.env });
  assert.equal(doctor.json().data.authenticated, true);
  assert.ok(!doctor.stdout.includes(TOKEN));
});

test('auth errors and redirects never expose or forward bearer tokens', async (t) => {
  const { config } = await temporary(t);
  const remote = await server(t);
  const bad = await invoke(['connections', 'list'], { config, env: { ...remote.env, TERMKIN_TOKEN: 'bad-token' } });
  assert.equal(bad.code, 5);
  assert.ok(!bad.stdout.includes('bad-token'));
  let redirected = false;
  const target = createServer((req, res) => { redirected = true; res.end('{}'); });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => target.close(resolve)));
  const redirect = createServer((req, res) => res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/mcp` }).end());
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { redirect.close(resolve); redirect.closeAllConnections(); }));
  const result = await invoke(['doctor'], { config, env: { TERMKIN_TOKEN: TOKEN, TERMKIN_ENDPOINT: `http://127.0.0.1:${redirect.address().port}/mcp` } });
  assert.equal(result.code, 4);
  assert.equal(redirected, false);
});

test('malformed RPC and tool payloads return protocol errors', async (t) => {
  const { config } = await temporary(t);
  let invalid = 'not json';
  const remote = await server(t, (body, req, res) => { res.end(invalid); });
  for (const body of ['not json', '{"jsonrpc":"2.0","id":999,"result":{}}', '{"jsonrpc":"2.0","id":2,"result":{}}']) {
    invalid = body;
    const result = await invoke(['connections', 'list'], { config, env: remote.env });
    assert.equal(result.code, 6, result.stdout);
  }
});

test('malformed structured tool results cannot masquerade as successful output', async (t) => {
  const { config } = await temporary(t);
  let current;
  const remote = await server(t, () => current);
  for (const data of [{ ...EXEC, stderr: 1 }, { ...EXEC, timedOut: 'false' }, { ...EXEC, exitCode: '0' }, { ...EXEC, signal: false }]) {
    current = tool(data);
    const result = await invoke(['exec', 'id', '--command', 'true'], { config, env: remote.env });
    assert.equal(result.code, 6, result.stdout);
  }
  current = tool({ connections: 'invalid' });
  assert.equal((await invoke(['connections', 'list'], { config, env: remote.env })).code, 6);
  current = { content: [], isError: 'false', structuredContent: EXEC };
  assert.equal((await invoke(['exec', 'id', '--command', 'true'], { config, env: remote.env })).code, 6);
  current = { tools: [], nextCursor: false };
  assert.equal((await invoke(['tools', 'list'], { config, env: remote.env })).code, 6);
});

test('deadline aborts an HTTP request and returns one JSON error', async (t) => {
  const { config } = await temporary(t);
  const hanging = createServer(() => {});
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { hanging.close(resolve); hanging.closeAllConnections(); }));
  const result = await invoke(['doctor', '--timeout', '1'], { config, env: { TERMKIN_TOKEN: TOKEN, TERMKIN_ENDPOINT: `http://127.0.0.1:${hanging.address().port}/mcp` } });
  assert.equal(result.code, 8);
  assert.equal(result.json().error.code, 'TIMEOUT');
});

test('actual executable exits with the reported status and clean JSON stdout', async (t) => {
  const { config } = await temporary(t);
  const entry = fileURLToPath(new URL('../termkin.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, '--config', config, 'bad-command'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).ok, false);
  assert.equal(stderr, '');
});
