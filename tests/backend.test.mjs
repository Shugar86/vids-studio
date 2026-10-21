import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport, getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {bridgeRequest, validateUpload, socketPath, privateRuntimeDirectory} from '../server/bridge-client.mjs';

import {PROFILE} from '../server/runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const execFileAsync = promisify(execFile);

test('runtime discovery stays aligned when the SDK strips XDG_RUNTIME_DIR', async () => {
  const canonical = `/run/user/${process.getuid()}`;
  const sdkEnv = getDefaultEnvironment();
  assert.equal(sdkEnv.XDG_RUNTIME_DIR, undefined);
  const nodeResult = await execFileAsync(process.execPath, ['--input-type=module', '-e',
    `import {socketPath} from ${JSON.stringify(new URL('../server/bridge-client.mjs', import.meta.url).href)}; process.stdout.write(socketPath());`], {env: sdkEnv});
  const pythonScript = 'import importlib.util,sys; s=importlib.util.spec_from_file_location("bridge",sys.argv[1]); m=importlib.util.module_from_spec(s); sys.modules[s.name]=m; s.loader.exec_module(m); print(m.default_socket_path(),end="")';
  const pythonResult = await execFileAsync('python3', ['-c', pythonScript, path.join(root, 'native/bridge.py')], {env: {...sdkEnv, XDG_RUNTIME_DIR: canonical}});
  assert.equal(nodeResult.stdout, pythonResult.stdout);
  assert.equal(nodeResult.stdout, privateRuntimeDirectory(canonical)
    ? path.join(canonical, PROFILE.socketNamespace, 'bridge.sock')
    : `/tmp/${PROFILE.socketNamespace}-${process.getuid()}/bridge.sock`);
});

test('runtime discovery accepts only owned private real directories', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vids-runtime-test-'));
  try {
    const runtime = path.join(dir, 'runtime');
    await fs.mkdir(runtime, {mode: 0o700});
    assert.equal(privateRuntimeDirectory(runtime), true);
    assert.equal(privateRuntimeDirectory(runtime, process.getuid() + 1), false);
    assert.equal(socketPath({XDG_RUNTIME_DIR: runtime}), path.join(runtime, PROFILE.socketNamespace, 'bridge.sock'));
    const linked = path.join(dir, 'linked');
    await fs.symlink(runtime, linked);
    assert.equal(privateRuntimeDirectory(linked), false);
    assert.equal(socketPath({XDG_RUNTIME_DIR: linked}), socketPath({}));
    await fs.chmod(runtime, 0o770);
    assert.equal(privateRuntimeDirectory(runtime), false);
    assert.equal(socketPath({XDG_RUNTIME_DIR: runtime}), socketPath({}));
    assert.equal(privateRuntimeDirectory('relative'), false);
    assert.equal(socketPath({VIDS_STUDIO_SOCKET: '/private/custom.sock'}), '/private/custom.sock');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

async function fixture(run, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vids-test-'));
  await fs.chmod(dir, 0o700);
  const endpoint = path.join(dir, 'bridge.sock');
  const connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let raw = '';
    socket.on('data', data => {
      raw += data.toString();
      if (raw.includes('\n')) handler(socket, JSON.parse(raw.split('\n')[0]));
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  await fs.chmod(endpoint, 0o600);
  try { await run(endpoint); }
  finally {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, {recursive: true, force: true});
  }
}

test('offline status is actionable and nonmutating', async () => {
  const response = await bridgeRequest('status', {}, {socketPath: '/nonexistent/vids-studio-test.sock'});
  assert.equal(response.error.code, 'NOT_CONNECTED');
  assert.equal(response.error.outcome, 'not_performed');
});

test('Unicode requests preserve session, operation id and receipt', async () => {
  await fixture(async endpoint => {
    const response = await bridgeRequest('type_text', {sessionId: 's-1', controlToken: 'owner-token', snapshotId: 'snapshot', operation_id: 'op-123456', text: 'Тест 🎥'}, {socketPath: endpoint});
    assert.equal(response.result.echo, 'Тест 🎥');
  }, (socket, request) => {
    assert.equal(request.sessionId, 's-1');
    assert.equal(request.operation_id, 'op-123456');
    assert.equal(request.v, 3);
    assert.equal(request.controlToken, 'owner-token');
    assert.equal(request.params.controlToken, undefined);
    assert.equal(request.params.sessionId, undefined);
    socket.end(JSON.stringify({v: 3, type: 'response', id: request.id, ok: true, result: {echo: request.params.text}}) + '\n');
  });
});

test('timeout and disconnect after sending report unknown, without replay', async () => {
  let sent = 0;
  await fixture(async endpoint => {
    const response = await bridgeRequest('click', {sessionId: 's-1', operation_id: 'op-123456'}, {socketPath: endpoint, timeoutMs: 25});
    assert.equal(response.error.code, 'TIMEOUT');
    assert.equal(response.error.outcome, 'unknown');
    assert.equal(sent, 1);
  }, () => { sent++; });
  await fixture(async endpoint => {
    const response = await bridgeRequest('click', {}, {socketPath: endpoint});
    assert.equal(response.error.outcome, 'unknown');
    assert.equal(response.error.code, 'DISCONNECTED');
  }, socket => socket.end());
});

test('foreign or malformed response cannot be accepted as completion', async () => {
  await fixture(async endpoint => {
    const response = await bridgeRequest('click', {}, {socketPath: endpoint});
    assert.equal(response.error.code, 'INVALID_RESPONSE');
    assert.equal(response.error.outcome, 'unknown');
  }, socket => socket.end(JSON.stringify({v: 3, type: 'response', id: 'wrong', ok: true}) + '\n'));
});

test('picker-trigger timeout is an unknown mutation and is never replayed', async () => {
  let sent = 0;
  await fixture(async endpoint => {
    const response = await bridgeRequest('upload_via_picker', {sessionId: 's-1', controlToken: 'owner-token',
      snapshotId: 'snapshot', operation_id: 'op-picker-123456', nodeRef: 'n-upload', files: ['/media/fixture.png']},
      {socketPath: endpoint, timeoutMs: 25});
    assert.equal(response.error.code, 'TIMEOUT');
    assert.equal(response.error.outcome, 'unknown');
    assert.equal(sent, 1);
  }, () => { sent++; });
});

test('old native protocol rejects v3 and asks for one explicit reconnect', async () => {
  await fixture(async endpoint => {
    const response = await bridgeRequest('click', {}, {socketPath: endpoint});
    assert.equal(response.error.code, 'RECONNECT_REQUIRED');
    assert.equal(response.error.outcome, 'not_performed');
  }, (socket, request) => {
    assert.equal(request.v, 3);
    socket.end(JSON.stringify({v: 1, type: 'response', id: request.id, ok: false,
      error: {code: 'INVALID_ARGUMENT', message: 'Malformed or oversized bridge request', outcome: 'not_performed'}}) + '\n');
  });
});

test('upload validates real media paths and rejects disguised targets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vids-upload-test-'));
  try {
    const media = path.join(dir, 'тест.mp4');
    await fs.writeFile(media, 'fixture');
    assert.deepEqual(await validateUpload([media]), [media]);
    await assert.rejects(validateUpload(['relative.mp4']), /absolute/);
    const secret = path.join(dir, '.env');
    await fs.writeFile(secret, 'never-upload');
    await assert.rejects(validateUpload([secret]), /allowlisted/);
    await fs.symlink(secret, path.join(dir, 'disguised.mp4'));
    await assert.rejects(validateUpload([path.join(dir, 'disguised.mp4')]), /symlink target/);
    await assert.rejects(validateUpload([path.join(dir, 'missing.mp4')]));
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('official MCP stdio client discovers tools and receives offline status', async () => {
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(root, 'server/index.mjs')], env: {...process.env, VIDS_STUDIO_SOCKET: '/nonexistent/vids-studio-test.sock'}});
  const client = new Client({name: 'backend-test', version: '1.0.0'});
  try {
    await client.connect(transport);
    const {tools} = await client.listTools();
    assert.equal(tools.length, 19);
    for (const name of ['start', 'status', 'result', 'cancel']) assert.ok(tools.some(tool => tool.name === `vids_job_${name}`));
    assert.deepEqual(tools.find(tool => tool.name === 'vids_job_start').inputSchema.properties.kind.const, 'export_mp4');
    for (const name of ['status', 'result', 'cancel']) assert.ok(tools.find(tool => tool.name === `vids_job_${name}`).inputSchema.required.includes('jobToken'));
    assert.ok(tools.some(tool => tool.name === 'vids_type_text'));
    assert.ok(tools.find(tool => tool.name === 'vids_click').inputSchema.required.includes('operation_id'));
    assert.ok(tools.find(tool => tool.name === 'vids_observe').inputSchema.required.includes('controlToken'));
    assert.ok(tools.some(tool => tool.name === 'vids_acquire_control'));
    const picker = tools.find(tool => tool.name === 'vids_upload_via_picker');
    for (const field of ['sessionId', 'controlToken', 'snapshotId', 'operation_id', 'files']) assert.ok(picker.inputSchema.required.includes(field));
    for (const field of ['button', 'clickCount', 'timeout']) assert.equal(Object.hasOwn(picker.inputSchema.properties, field), false);
    const response = await client.callTool({name: 'vids_status', arguments: {}});
    assert.equal(response.isError, undefined);
    assert.equal(JSON.parse(response.content[0].text).connected, false);
    const invalid = await client.callTool({name: 'vids_click', arguments: {sessionId: 's-1', snapshotId: 'ss-1', operation_id: 'op-123456', x: 2}});
    assert.equal(invalid.isError, true);
    const shortcut = await client.callTool({name: 'vids_press_key', arguments: {
      sessionId: 's-1', snapshotId: 'ss-1', operation_id: 'op-123456', controlToken: 'test-token-0123456789-0123456789-0123456789', key: 'c', modifiers: ['Control'],
    }});
    assert.equal(shortcut.isError, true);
    assert.equal(JSON.parse(shortcut.content[0].text).error.code, 'FORBIDDEN_SHORTCUT');
  } finally { await client.close(); }
});

test('picker upload rejects ambiguous targets and nonmedia paths before connecting', async () => {
  const client = new Client({name: 'picker-schema-test', version: '1.0.0'});
  await client.connect(new StdioClientTransport({command: process.execPath, args: [path.join(root, 'server/index.mjs')], env: {VIDS_STUDIO_SOCKET: '/nonexistent/vids-studio-test.sock'}}));
  const base = {sessionId: 's-1', snapshotId: 'snapshot', operation_id: 'op-picker-123456',
    controlToken: 'test-token-0123456789-0123456789-0123456789', files: ['/media/fixture.png']};
  try {
    for (const target of [{}, {x: 5}, {nodeRef: 'n-upload', x: 5, y: 5}]) {
      const response = await client.callTool({name: 'vids_upload_via_picker', arguments: {...base, ...target}});
      assert.equal(response.isError, true);
      assert.equal(JSON.parse(response.content[0].text).error.code, 'INVALID_ARGUMENT');
    }
    for (const files of [['relative.png'], ['/media/private.env']]) {
      const response = await client.callTool({name: 'vids_upload_via_picker', arguments: {...base, nodeRef: 'n-upload', files}});
      assert.equal(response.isError, true);
      assert.equal(JSON.parse(response.content[0].text).error.code, 'INVALID_ARGUMENT');
      assert.equal(JSON.parse(response.content[0].text).error.outcome, 'not_performed');
    }
  } finally { await client.close(); }
});

test('two real MCP clients coordinate through one native host without snapshot interference', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vids-lease-test-'));
  await fs.chmod(dir, 0o700);
  const endpoint = path.join(dir, 'bridge.sock');
  const native = spawn('python3', [path.join(root, 'native/bridge.py'), '--socket', endpoint], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, VIDS_STUDIO_REGISTRY_DIR: path.join(dir, 'registry')}});
  const clients = [];
  let incoming = Buffer.alloc(0);
  let observed = 0;
  const uploads = [];
  let errors = '';
  native.stderr.on('data', data => { errors += data.toString(); });
  function chromeMessage(message) {
    const data = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    os.endianness() === 'LE' ? header.writeUInt32LE(data.length) : header.writeUInt32BE(data.length);
    native.stdin.write(Buffer.concat([header, data]));
  }
  native.stdout.on('data', chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    while (incoming.length >= 4) {
      const length = os.endianness() === 'LE' ? incoming.readUInt32LE() : incoming.readUInt32BE();
      if (incoming.length < length + 4) break;
      const request = JSON.parse(incoming.subarray(4, length + 4).toString());
      incoming = incoming.subarray(length + 4);
      assert.equal(request.v, 2); // Extension handshake and fencing protocol.
      assert.equal(request.controlToken, undefined);
      if (request.method === 'upload_via_picker') uploads.push(request.params);
      const result = request.method === 'status' ? {attached: true, sessionId: 'session-fixture', documentId: 'fixture', runtime: {extension: {version: PROFILE.version, buildId: PROFILE.buildId, profileId: PROFILE.id, protocol: 2}}}
        : request.method === 'observe' ? {snapshotId: `snapshot-${++observed}`, nodes: []}
        : {performed: true, needsObservation: true};
      chromeMessage({v: 2, type: 'response', id: request.id, ok: true, result});
    }
  });
  const call = async (client, name, args = {}) => {
    const response = await client.callTool({name: `vids_${name}`, arguments: args});
    return {isError: response.isError, ...JSON.parse(response.content[0].text)};
  };
  try {
    chromeMessage({v: 2, type: 'hello', status: {attached: true, sessionId: 'session-fixture', documentId: 'fixture', runtime: {extension: {version: PROFILE.version, buildId: PROFILE.buildId, profileId: PROFILE.id, protocol: 2}}}});
    for (let i = 0; i < 100; i++) {
      try { await fs.lstat(endpoint); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    for (const name of ['owner-a', 'owner-b']) {
      const client = new Client({name, version: '1.0.0'});
      await client.connect(new StdioClientTransport({command: process.execPath, args: [path.join(root, 'server/index.mjs')], env: {VIDS_STUDIO_SOCKET: endpoint}}));
      clients.push(client);
    }
    const [a, b] = clients;
    const sessionId = (await call(a, 'status')).sessionId;
    const acquireA = await call(a, 'acquire_control', {sessionId, ownerLabel: 'Task A'});
    assert.equal(acquireA.isError, undefined, JSON.stringify(acquireA));
    const controlToken = acquireA.result.controlToken;
    assert.equal((await call(b, 'acquire_control', {sessionId, ownerLabel: 'Task B'})).error.code, 'CONTROL_BUSY');
    const snapshot = await call(a, 'observe', {sessionId, controlToken});
    assert.equal(snapshot.result.snapshotId, 'snapshot-1');
    assert.equal((await call(b, 'observe', {sessionId, controlToken: 'wrong-token-0123456789-0123456789-0123456789'})).error.code, 'CONTROL_BUSY');
    assert.equal(observed, 1);
    const publicStatus = await call(b, 'status');
    assert.equal(publicStatus.control.ownerLabel, 'Task A');
    assert.equal(JSON.stringify(publicStatus).includes(controlToken), false);
    assert.equal((await call(a, 'type_text', {sessionId, controlToken, snapshotId: snapshot.result.snapshotId, operation_id: 'operation-lease-1', text: 'Русский текст'})).result.performed, true);
    const media = path.join(dir, 'русское-медиа.png');
    await fs.writeFile(media, 'isolated-upload-fixture');
    const beforeUpload = await call(a, 'observe', {sessionId, controlToken});
    const pickerArgs = {sessionId, controlToken, snapshotId: beforeUpload.result.snapshotId, operation_id: 'operation-picker-1', nodeRef: 'n-upload', files: [media]};
    assert.equal((await call(a, 'upload_via_picker', pickerArgs)).result.performed, true);
    assert.deepEqual(uploads, [{snapshotId: beforeUpload.result.snapshotId, nodeRef: 'n-upload', files: [media]}]);
    assert.equal((await call(a, 'upload_via_picker', pickerArgs)).receipt.replayed, true);
    assert.equal(uploads.length, 1);
    assert.equal((await call(a, 'release_control', {sessionId, controlToken})).result.released, true);
    assert.ok((await call(b, 'acquire_control', {sessionId, ownerLabel: 'Task B'})).result.controlToken);
    assert.equal((await call(a, 'observe', {sessionId, controlToken})).error.code, 'CONTROL_BUSY');
  } finally {
    for (const client of clients) await client.close();
    native.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { native.kill(); reject(new Error(`Native host failed to close: ${errors}`)); }, 2000);
      native.once('exit', () => { clearTimeout(timer); resolve(); });
      if (native.exitCode !== null) { clearTimeout(timer); resolve(); }
    });
    await fs.rm(dir, {recursive: true, force: true});
  }
});
