import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, chmod, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {randomUUID, randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {PROFILE} from '../server/runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await wait(20); }
  assert.fail(message);
}
function latch() { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; }

async function fixture(t, {unknownTrigger = false} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vids-detached-'));
  await chmod(directory, 0o700);
  const sessions = join(directory, 'sessions'); await mkdir(sessions, {mode: 0o700});
  const sessionId = randomUUID(), documentId = `fixture-${randomUUID()}`;
  const endpoint = join(sessions, `${sessionId}.sock`);
  const source = join(directory, 'source.mp4');
  const render = spawnSync(process.env.VIDS_STUDIO_FFMPEG || 'ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=5:d=0.4',
    '-an', '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source,
  ]);
  assert.equal(render.status, 0, render.stderr?.toString());
  const args = {jobId: randomUUID(), jobToken: randomBytes(32).toString('base64url'),
    kind: 'export_mp4', intentId: randomUUID(), documentId, sessionId,
    controlToken: randomBytes(32).toString('base64url'), automaticDownload: {
      confirmed: true, checkedAt: new Date().toISOString(), source: 'Isolated fixture automatically saves downloads',
    }};
  const downloadEntered = latch(), downloadRelease = latch();
  const calls = [], sockets = new Set(), clients = new Set();
  let observed = 0;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '', handled = false;
    socket.on('data', async chunk => {
      buffer += chunk;
      if (handled || !buffer.includes('\n')) return;
      handled = true;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      calls.push({method: request.method, operation_id: request.operation_id});
      let result, error;
      if (request.sessionId !== sessionId) error = {code: 'SESSION_MISMATCH', message: 'Wrong fixture attachment'};
      else if (request.method === 'status') result = {attached: true, sessionId, documentId,
        control: {mode: 'write'}, capabilities: ['export_trigger', 'export_download_status']};
      else if (request.controlToken !== args.controlToken) error = {code: 'CONTROL_BUSY', message: 'Fixture requires its own lease', outcome: 'not_performed'};
      else if (request.method === 'renew_control') result = {renewed: true};
      else if (request.method === 'release_control') result = {released: true};
      else if (request.method === 'observe') result = {snapshotId: `snapshot-${++observed}`,
        nodes: [{role: 'menuitem', ref: `node-${observed}`, name: ['File', 'Download d ►', 'MP4 video (.mp4) d'][(observed - 1) % 3]}]};
      else if (request.method === 'click') result = {clicked: true};
      else if (request.method === 'export_trigger') {
        if (unknownTrigger) error = {code: 'BROWSER_TIMEOUT', message: 'Fixture unknown trigger', outcome: 'unknown'};
        else result = {armed: true};
      } else if (request.method === 'export_download_status') {
        downloadEntered.resolve(); await downloadRelease.promise;
        result = {jobId: args.jobId, sessionId, documentId,
          ...(unknownTrigger ? {state: 'needs_reconciliation', code: 'EXPORT_WATCH_UNRESOLVED'} :
            {state: 'completed', guid: 'fixture-guid', downloadId: 7, frameId: 'fixture-frame', filename: source})};
      } else error = {code: 'FIXTURE_UNEXPECTED_CALL', message: request.method};
      if (!socket.destroyed) socket.end(`${JSON.stringify({v: 3, type: 'response', id: request.id,
        ok: !error, ...(error ? {error} : {result})})}\n`);
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve)); await chmod(endpoint, 0o600);
  const env = {...process.env, VIDS_STUDIO_SOCKET: join(directory, 'bridge.sock'),
    VIDS_STUDIO_FLEET_DIR: join(directory, 'fleet'), VIDS_STUDIO_REGISTRY_DIR: join(directory, 'registry'),
    XDG_STATE_HOME: join(directory, 'state')};
  async function connect() {
    const client = new Client({name: 'detached-export-fixture', version: '1.0.0'});
    const transport = new StdioClientTransport({command: process.execPath, args: [join(root, 'server/index.mjs')], env, stderr: 'pipe'});
    // Stderr can contain Node's sqlite warning; it is not protocol data.
    transport.stderr?.resume();
    await client.connect(transport); clients.add(client);
    return {client, transport, async close() { await client.close(); clients.delete(client); }};
  }
  async function tool(client, name, arguments_) {
    const response = await client.callTool({name: `vids_job_${name}`, arguments: arguments_});
    return {response, value: JSON.parse(response.content.find(item => item.type === 'text').text)};
  }
  t.after(async () => {
    downloadRelease.resolve();
    for (const client of clients) await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  });
  return {directory, connect, tool, args, calls, downloadEntered, downloadRelease};
}

const platform = {skip: process.platform === 'win32' ? 'POSIX private socket integration; Windows transport has dedicated smoke tests' : false, timeout: 30000};

test('detached export survives actual MCP parent exit, rejects unauthorized recovery, and verifies the file', platform, async t => {
  const f = await fixture(t), parent = await f.connect();
  const started = await f.tool(parent.client, 'start', f.args);
  assert.equal(started.response.isError, undefined);
  assert.equal(started.value.id, f.args.jobId);
  await f.downloadEntered.promise;
  const parentPid = parent.transport.pid;
  assert.ok(parentPid);
  await parent.close();
  assert.throws(() => process.kill(parentPid, 0), error => error.code === 'ESRCH', 'MCP parent must actually exit');

  const replacement = await f.connect();
  const access = {jobId: f.args.jobId, jobToken: f.args.jobToken};
  const living = await f.tool(replacement.client, 'status', access);
  assert.equal(living.value.state, 'waiting');
  assert.equal(living.value.runner.freshness, 'recent_heartbeat');
  const before = f.calls.length;
  const wrong = await f.tool(replacement.client, 'status', {...access, jobToken: randomBytes(32).toString('base64url')});
  assert.equal(wrong.value.error.code, 'JOB_NOT_FOUND');
  const oldLease = await f.tool(replacement.client, 'status', {...access,
    inspectDownload: {sessionId: f.args.sessionId, controlToken: f.args.controlToken}});
  assert.equal(oldLease.value.error.code, 'FRESH_RECOVERY_LEASE_REQUIRED');
  assert.equal(f.calls.length, before, 'wrong capabilities and old lease must be rejected before bridge calls');
  const forgedLease = await f.tool(replacement.client, 'status', {...access,
    inspectDownload: {sessionId: f.args.sessionId, controlToken: randomBytes(32).toString('base64url')}});
  assert.equal(forgedLease.value.error.code, 'CONTROL_BUSY');
  assert.equal(f.calls.filter(call => call.method === 'export_download_status').length, 1, 'failed recovery cannot start another watcher');

  f.downloadRelease.resolve();
  const complete = await until(async () => {
    const {value} = await f.tool(replacement.client, 'status', access);
    if (['failed', 'needs_reconciliation'].includes(value.state)) assert.fail(JSON.stringify(value.issue));
    return value.state === 'succeeded' && value;
  }, 'detached runner did not finish after its MCP parent exited');
  assert.equal(complete.result.verification.decode, 'verified');
  assert.equal(complete.result.provenance.sessionId, f.args.sessionId);
  assert.equal(f.calls.filter(call => call.method === 'export_trigger').length, 1);
  const durable = await readFile(join(f.directory, 'state', 'vids-studio-jobs', PROFILE.id, 'jobs.sqlite'));
  for (const secret of [f.args.controlToken, f.args.jobToken]) assert.equal(durable.includes(Buffer.from(secret)), false);
  await replacement.close();
});

test('restarted MCP returns the same unknown export receipt without replaying its trigger', platform, async t => {
  const f = await fixture(t, {unknownTrigger: true}), parent = await f.connect();
  const started = await f.tool(parent.client, 'start', f.args);
  assert.equal(started.response.isError, undefined);
  await f.downloadEntered.promise; await parent.close(); f.downloadRelease.resolve();
  const replacement = await f.connect();
  const access = {jobId: f.args.jobId, jobToken: f.args.jobToken};
  const unresolved = await until(async () => {
    const {value} = await f.tool(replacement.client, 'status', access);
    return value.issue?.code === 'EXPORT_WATCH_UNRESOLVED' && value;
  }, 'unknown export was not preserved');
  assert.equal(unresolved.state, 'needs_reconciliation');
  assert.equal(unresolved.receipts.at(-1).outcome, 'unknown');
  const before = f.calls.length;
  const again = await f.tool(replacement.client, 'start', f.args);
  assert.equal(again.value.id, f.args.jobId);
  assert.equal(again.value.receipts.at(-1).outcome, 'unknown');
  assert.equal(f.calls.length, before, 'same intent returns existing durable evidence without any bridge call');
  assert.equal(f.calls.filter(call => call.method === 'export_trigger').length, 1);
  assert.equal(new Set(f.calls.filter(call => call.operation_id).map(call => call.operation_id)).size, 3);
  await replacement.close();
});
