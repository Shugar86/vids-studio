// Invoked by platform_smoke.py after isolated profile installation. This is a
// native OS transport test; Chrome's framed peer is deliberately a fixture.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {JobStore, tokenHash} from '../server/jobs-store.mjs';
import {verifyExport} from '../server/jobs-media.mjs';
import {bridgeRequest} from '../server/bridge-client.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = process.env.VIDS_PLATFORM_SMOKE_DIR;
assert.ok(temporary, 'Run python tests/platform_smoke.py to prepare the isolated fixture');
const python = process.env.VIDS_STUDIO_PYTHON;
assert.ok(python, 'The smoke suite must use its selected Python environment');
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const registry = path.join(temporary, 'coordinator');
const launchers = JSON.parse(await fs.readFile(path.join(temporary, 'launchers.json'), 'utf8'));
const profileTargets = JSON.parse(await fs.readFile(path.join(temporary, 'profile-targets.json'), 'utf8'));
const profileEnvironments = JSON.parse(await fs.readFile(path.join(temporary, 'profile-environments.json'), 'utf8'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const unicode = 'Русский титр 🎥 — 日本語';

async function until(check, context) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await pause(25);
  }
  assert.fail(`Timed out waiting for ${context}`);
}

async function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once('exit', resolve));
}

async function call(client, method, args = {}) {
  const response = await client.callTool({name: `vids_${method}`, arguments: args});
  return {...JSON.parse(response.content.find(item => item.type === 'text').text), isError: response.isError};
}

async function connect(host, clients) {
  const client = new Client({name: `${host.name}-native-os-smoke`, version: '1'});
  await client.connect(new StdioClientTransport({command: process.execPath,
    args: [path.join(host.target, 'server/index.mjs')],
    env: {...process.env, ...profileEnvironments[host.name], VIDS_STUDIO_SOCKET: host.endpoint}}));
  clients.push(client);
  await until(async () => {
    assert.equal(host.child.exitCode, null, host.errors());
    const status = await call(client, 'diagnostics');
    return status.compatibility?.ready === true;
  }, `${host.name} native host readiness`);
  return client;
}

async function startHost(name, target, hosts, {documentId = `document-${name}`, fences = [], launcher} = {}) {
  const profile = JSON.parse(await fs.readFile(path.join(target, 'profile.json'), 'utf8'));
  const endpoint = path.join(temporary, `${name}-endpoint`, process.platform === 'win32' ? 'bridge.json' : 'bridge.sock');
  const args = ['--socket', endpoint, '--registry', registry];
  let command = python, parameters = [path.join(target, 'native/bridge.py'), ...args], options = {};
  if (launcher && process.platform === 'win32') {
    // cmd.exe is required for the generated Chrome native-host .cmd launcher.
    // All components are generated fixture paths; quotes cannot occur in a
    // Windows filename. Native messages still use binary stdin/stdout pipes.
    command = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    parameters = ['/d', '/s', '/c', `""${launcher}" ${args.map(value => `"${value}"`).join(' ')}"`];
    options = {windowsVerbatimArguments: true};
  } else if (launcher) {
    command = launcher;
    parameters = args;
  }
  const child = spawn(command, parameters, {stdio: ['pipe', 'pipe', 'pipe'], ...options});
  let buffer = Buffer.alloc(0), stderr = '', sequence = 0, held = null, parseError = null;
  let binding = {attached: true, sessionId: `session-${name}`, documentId,
    runtime: {extension: {version: profile.version, buildId: profile.buildId,
      profileId: profile.id, protocol: profile.extensionProtocol}}};
  const sent = [];
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', error => { parseError = error; });
  child.stdin.on('error', error => { parseError ||= error; });
  function deliver(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    if (os.endianness() === 'LE') header.writeUInt32LE(body.length);
    else header.writeUInt32BE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  }
  child.stdout.on('data', chunk => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = os.endianness() === 'LE' ? buffer.readUInt32LE() : buffer.readUInt32BE();
        assert.ok(length > 0 && length <= 256 * 1024, 'Native launcher polluted binary framing');
        if (buffer.length < length + 4) break;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
        buffer = buffer.subarray(length + 4);
        sent.push(request);
        if (request.method === 'type_text' && request.params.text === 'hold-unknown') { held = request; continue; }
        const result = request.method === 'status' ? binding
          : request.method === 'observe' ? {snapshotId: `snapshot-${++sequence}`, nodes: [{ref: 'n1', role: 'textbox', name: unicode}]}
          : request.method === 'screenshot' ? {snapshotId: `snapshot-${++sequence}`, mimeType: 'image/png', data: png}
          : {performed: true, needsObservation: true, echo: request.params.text};
        deliver({v: profile.extensionProtocol, type: 'response', id: request.id, ok: true, result});
      }
    } catch (error) { parseError = error; }
  });
  const host = {name, target, profile, endpoint, child, sent, held: () => held,
    errors: () => stderr || parseError?.stack || '',
    rebind(nextDocument, receipts = []) {
      binding = {...binding, sessionId: `${binding.sessionId}-new`, documentId: nextDocument};
      deliver({v: profile.extensionProtocol, type: 'hello', status: binding, fenceReceipts: receipts});
      return binding.sessionId;
    }};
  hosts.push(host);
  deliver({v: profile.extensionProtocol, type: 'hello', status: binding, fenceReceipts: fences});
  return host;
}

test('source and installed profiles preserve native framing, control, arbitration and crash fencing on the real OS', {timeout: 180000}, async () => {
  const hosts = [], clients = [];
  try {
    const targets = [['source', root], ['codex', profileTargets.codex], ['claude', profileTargets.claude]];
    const sessions = [], controls = [], activeClients = [];
    for (const [name, target] of targets) {
      if (name !== 'source') assert.ok(target.includes('Установка 🎥'), 'Installed launcher must exercise a Unicode path');
      const host = await startHost(name, target, hosts, {launcher: launchers[name]});
      const client = await connect(host, clients);
      activeClients.push(client);
      const status = await call(client, 'diagnostics');
      sessions.push(status.sessionId);
      assert.equal(status.coordinatorError, null);
      assert.equal(status.runtime.host.buildId, hosts[0].profile.buildId);
      const acquired = await call(client, 'acquire_control', {sessionId: status.sessionId, ownerLabel: unicode});
      assert.equal(acquired.result?.mode, 'write', JSON.stringify(acquired));
      const control = {sessionId: status.sessionId, controlToken: acquired.result.controlToken};
      controls.push(control);
      const observed = await call(client, 'observe', control);
      assert.equal(observed.result.nodes[0].name, unicode);
      const shot = await client.callTool({name: 'vids_screenshot', arguments: control});
      assert.equal(shot.content.find(item => item.type === 'image').data, png);
      const typed = await call(client, 'type_text', {...control, snapshotId: observed.result.snapshotId,
        nodeRef: 'n1', text: unicode, operation_id: randomUUID()});
      assert.equal(typed.result.echo, unicode);
      const before = host.sent.length;
      assert.equal((await call(client, 'observe', {...control, controlToken: 'foreign-token-0123456789-0123456789-0123456789'})).error.code, 'CONTROL_BUSY');
      assert.equal(host.sent.length, before, 'Foreign capability reached the native peer');
    }
    await call(activeClients[1], 'release_control', controls[1]);
    await call(activeClients[2], 'release_control', controls[2]);
    const sharedDocument = 'document-source';
    const competingSession = hosts[2].rebind(sharedDocument);
    await until(async () => (await call(activeClients[2], 'diagnostics')).sessionId === competingSession, 'Claude attachment');
    const competing = {sessionId: competingSession, ownerLabel: 'Claude competing owner'};
    assert.equal((await call(activeClients[2], 'acquire_control', competing)).error.code, 'CONTROL_BUSY');
    await activeClients[0].close();
    assert.equal((await call(activeClients[2], 'acquire_control', competing)).error.code, 'CONTROL_BUSY', 'MCP shutdown must not release a live native host');
    activeClients[0] = await connect(hosts[0], clients);
    const unknownOperation = randomUUID();
    const pending = call(activeClients[0], 'type_text', {...controls[0], snapshotId: 'snapshot-before-crash',
      nodeRef: 'n1', text: 'hold-unknown', operation_id: unknownOperation});
    await until(() => hosts[0].held(), 'uncertain native mutation');
    hosts[0].child.kill('SIGKILL');
    await exited(hosts[0].child);
    assert.equal((await pending).error.outcome, 'unknown');
    assert.equal((await call(activeClients[2], 'acquire_control', competing)).error.code, 'COORDINATOR_FENCE_REQUIRED');
    const receipt = {fenced: true, profileId: hosts[0].profile.id, sessionId: sessions[0], documentId: sharedDocument};
    // A different extension profile cannot attest that the old owner stopped.
    const foreignSession = hosts[2].rebind(sharedDocument, [receipt]);
    competing.sessionId = foreignSession;
    await until(async () => (await call(activeClients[2], 'diagnostics')).sessionId === foreignSession, 'foreign fence receipt');
    assert.equal((await call(activeClients[2], 'acquire_control', competing)).error.code, 'COORDINATOR_FENCE_REQUIRED');
    const recoveredHost = await startHost('source-restarted', root, hosts, {documentId: sharedDocument, fences: [receipt]});
    await connect(recoveredHost, clients);
    const recovery = await call(activeClients[2], 'acquire_control', competing);
    assert.equal(recovery.result?.mode, 'reconcile', JSON.stringify(recovery));
    const readOnly = {sessionId: foreignSession, controlToken: recovery.result.controlToken};
    assert.equal((await call(activeClients[2], 'observe', readOnly)).result.nodes[0].name, unicode);
    const before = hosts[2].sent.length;
    assert.equal((await call(activeClients[2], 'type_text', {...readOnly, snapshotId: 'read-only', nodeRef: 'n1', text: 'blocked', operation_id: randomUUID()})).error.code, 'RECONCILIATION_REQUIRED');
    assert.equal(hosts[2].sent.length, before, 'Read-only reconciliation sent a mutation');
    const reconciled = await call(activeClients[2], 'reconcile_control', {...readOnly,
      acknowledgeUnknown: true, evidence: 'Observed the local fixture after a fenced crash; prior operation remains unknown.'});
    assert.equal(reconciled.result.oldOutcomePreserved, true);
    assert.equal((await call(activeClients[2], 'type_text', {...readOnly, snapshotId: 'new-observation', nodeRef: 'n1', text: unicode, operation_id: randomUUID()})).result.echo, unicode);
    await call(activeClients[2], 'release_control', readOnly);
    const db = new DatabaseSync(path.join(registry, 'registry.sqlite3'), {readOnly: true});
    try {
      const recorded = db.prepare('SELECT state,initial_outcome,latest_outcome FROM operations WHERE operation_id=?').get(unknownOperation);
      assert.equal(recorded.state, 'acknowledged');
      assert.equal(recorded.initial_outcome, 'unknown');
      assert.equal(recorded.latest_outcome, 'unknown');
    } finally { db.close(); }
    assert.equal(hosts.flatMap(host => host.sent).filter(request => request.params.text === 'hold-unknown').length, 1);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    for (const host of hosts) {
      if (host.child.exitCode === null && host.child.signalCode === null) {
        host.child.stdin.end();
        const timer = setTimeout(() => host.child.kill('SIGKILL'), 5000);
        await exited(host.child);
        clearTimeout(timer);
      }
      assert.equal(host.errors(), '', `${host.name} native host errors`);
    }
  }
});

test('job capabilities persist, wrong capabilities fail and widened database ACLs stop access', {timeout: 60000}, async () => {
  const directory = path.join(temporary, 'jobs');
  const token = 'private-job-capability-'.repeat(3);
  let store = new JobStore(directory);
  const job = {id: randomUUID(), profileId: 'codex', documentId: 'local-fixture', intentId: randomUUID(),
    state: 'queued', ownerHash: tokenHash(token), instance: 'fixture', runnerEpoch: 0};
  store.create(job);
  store.close();
  store = new JobStore(directory);
  try {
    assert.equal(store.authorized(job.id, token).intentId, job.intentId);
    assert.throws(() => store.authorized(job.id, 'foreign'), error => error.code === 'JOB_NOT_FOUND');
    assert.throws(() => store.requestCancel(job.id, 'foreign'), error => error.code === 'JOB_NOT_FOUND');
    await exec(python, [path.join(root, 'tests/platform_smoke.py'), '--widen-acl', path.join(directory, 'jobs.sqlite')]);
    assert.throws(() => store.get(job.id), error => error.code === 'UNSAFE_JOB_STORE');
  } finally { store.close(); }
  assert.throws(() => new JobStore(directory), error => error.code === 'UNSAFE_JOB_STORE');
});

test('pinned native media tools verify a real MP4 with an empty PATH and reject a fake download', {timeout: 120000}, async () => {
  const source = path.join(temporary, 'тест 🎥.mp4');
  const helper = path.join(root, 'native/platform_support.py');
  const ffmpeg = process.env.VIDS_STUDIO_FFMPEG;
  assert.ok(path.isAbsolute(ffmpeg));
  assert.ok(path.isAbsolute(process.env.VIDS_STUDIO_FFPROBE));
  await exec(python, [helper, 'create-file', source]);
  await exec(ffmpeg, ['-y', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=5:d=0.4',
    '-an', '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const outputDirectory = path.join(temporary, 'verified-media');
  const fake = path.join(temporary, 'fake.mp4');
  await exec(python, [helper, 'create-file', fake]);
  await fs.writeFile(fake, 'not video');
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const oldPath = process.env[pathKey];
  process.env[pathKey] = '';
  try {
    const result = await verifyExport({source, outputDirectory, jobId: randomUUID()});
    assert.equal(result.width, 64);
    assert.equal(result.height, 48);
    assert.equal(result.verification.decode, 'verified');
    assert.equal(result.sha256.length, 64);
    await assert.rejects(verifyExport({source: fake, outputDirectory, jobId: randomUUID()}), error => error.code === 'MEDIA_CHECK_FAILED');
  } finally {
    if (oldPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = oldPath;
  }
});

test('Windows rejects a stale-port impersonator before sending a browser request or capability',
  {skip: process.platform !== 'win32', timeout: 30000}, async () => {
    const directory = path.join(temporary, 'impostor');
    const descriptor = path.join(directory, 'bridge.json');
    const helper = path.join(root, 'native/platform_support.py');
    await exec(python, [helper, 'ensure-directory', directory]);
    const messages = [], connections = new Set();
    const server = net.createServer(socket => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          messages.push(JSON.parse(buffer.slice(0, end)));
          buffer = buffer.slice(end + 1);
          socket.write(`${JSON.stringify({v: 1, type: 'transport_challenge', nonce: 'a'.repeat(64), proof: 'b'.repeat(64)})}\n`);
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await exec(python, [helper, 'create-file', descriptor]);
      await fs.writeFile(descriptor, JSON.stringify({v: 1, transport: 'tcp', host: '127.0.0.1',
        port: server.address().port, token: 'c'.repeat(64)}));
      const capability = 'must-never-reach-impostor';
      const response = await bridgeRequest('type_text', {sessionId: 'fixture', controlToken: capability,
        operation_id: randomUUID(), text: unicode}, {socketPath: descriptor, timeoutMs: 5000});
      assert.equal(response.error.code, 'UNSAFE_SOCKET');
      assert.equal(response.error.outcome, 'not_performed');
      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, 'transport_hello');
      assert.match(messages[0].nonce, /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(messages).includes(capability), false);
      assert.equal(JSON.stringify(messages).includes(unicode), false);
      await exec(python, [path.join(root, 'tests/platform_smoke.py'), '--widen-acl', descriptor]);
      const unsafe = await bridgeRequest('type_text', {sessionId: 'fixture', controlToken: capability,
        operation_id: randomUUID(), text: unicode}, {socketPath: descriptor, timeoutMs: 5000});
      assert.equal(unsafe.error.code, 'SOCKET_CHECK_FAILED');
      assert.equal(unsafe.error.outcome, 'not_performed');
      assert.equal(messages.length, 1, 'An ACL-widened descriptor caused a connection');
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
