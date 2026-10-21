import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('both materialized MCP profiles share document arbitration, preserve independent documents and standard text/image responses', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vids-two-profiles-'));
  const hosts = [], clients = [];
  try {
    // A materialized profile is deliberately not a source for another profile.
    // Cross-profile source must be explicit outside a canonical source checkout;
    // release provenance never contains the publisher's filesystem path.
    const installed = JSON.parse(await fs.readFile(path.join(root, 'profile.json'), 'utf8'));
    let hasCanonicalSkills = false;
    try { await fs.access(path.join(root, 'skill/vids-director/SKILL.md')); hasCanonicalSkills = true; } catch {}
    const source = globalThis.process.env.VIDS_STUDIO_CANONICAL_SOURCE
      || (installed.id === 'codex' && hasCanonicalSkills ? root : null);
    if (!source) {
      t.skip('Cross-profile source test: set VIDS_STUDIO_CANONICAL_SOURCE to a complete canonical source checkout');
      return;
    }
    assert.equal(JSON.parse(await fs.readFile(path.join(source, 'profile.json'), 'utf8')).id, 'codex');
    await exec('python3', [path.join(source, 'scripts/build_profiles.py'), '--source', source, '--target', root, '--profile', installed.id, '--check']);
    for (const profileId of ['codex', 'claude']) {
      const target = path.join(temp, profileId);
      await exec('python3', [path.join(source, 'scripts/build_profiles.py'), '--source', source, '--target', target, '--profile', profileId, '--write']);
      await fs.symlink(path.join(root, 'node_modules'), path.join(target, 'node_modules'));
      const profile = JSON.parse(await fs.readFile(path.join(target, 'profile.json'), 'utf8'));
      const socket = path.join(temp, `${profileId}-socket`, 'bridge.sock');
      const process = spawn('python3', [path.join(target, 'native/bridge.py'), '--socket', socket,
        '--registry', path.join(temp, 'registry')], {stdio: ['pipe', 'pipe', 'pipe']});
      let buffer = Buffer.alloc(0), errors = '', sequence = 0;
      process.stderr.on('data', data => { errors += data.toString(); });
      const runtime = {extension: {version: profile.version, buildId: profile.buildId, profileId, protocol: 2}};
      let binding = {attached: true, sessionId: `session-${profileId}`, documentId: `document-${profileId}`, runtime};
      const sent = [];
      function deliver(message) {
        const content = Buffer.from(JSON.stringify(message));
        const header = Buffer.alloc(4);
        os.endianness() === 'LE' ? header.writeUInt32LE(content.length) : header.writeUInt32BE(content.length);
        process.stdin.write(Buffer.concat([header, content]));
      }
      process.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = os.endianness() === 'LE' ? buffer.readUInt32LE() : buffer.readUInt32BE();
          if (buffer.length < length + 4) break;
          const request = JSON.parse(buffer.subarray(4, length + 4));
          buffer = buffer.subarray(length + 4);
          sent.push(request.method);
          const result = request.method === 'status' ? binding
            : request.method === 'observe' ? {snapshotId: `snap-${++sequence}`, nodes: [{ref: 'n1', role: 'textbox', name: 'Русский титр'}]}
            : request.method === 'screenshot' ? {snapshotId: `snap-${++sequence}`, mimeType: 'image/png', data: png}
            : {performed: true, needsObservation: true};
          deliver({v: 2, type: 'response', id: request.id, ok: true, result});
        }
      });
      const host = {process, socket, profile, target, sent, rebind(documentId) {
        binding = {...binding, sessionId: `${binding.sessionId}-new`, documentId};
        deliver({v: 2, type: 'hello', status: binding, fenceReceipts: []});
        return binding.sessionId;
      }, errors: () => errors};
      hosts.push(host);
      deliver({v: 2, type: 'hello', status: binding, fenceReceipts: []});
      for (let i = 0; i < 100; i++) { try { await fs.stat(socket); break; } catch { await sleep(10); } }
      const client = new Client({name: `${profileId}-acceptance`, version: '1'});
      await client.connect(new StdioClientTransport({command: globalThis.process.execPath,
        args: [path.join(target, 'server/index.mjs')], env: {VIDS_STUDIO_SOCKET: socket}}));
      clients.push(client);
    }
    const call = async (client, method, args = {}) => {
      const response = await client.callTool({name: `vids_${method}`, arguments: args});
      return {...JSON.parse(response.content.find(item => item.type === 'text').text), isError: response.isError};
    };
    const statuses = await Promise.all(clients.map(client => call(client, 'diagnostics')));
    for (const status of statuses) assert.equal(status.compatibility.ready, true);
    assert.equal(statuses[0].runtime.host.buildId, statuses[1].runtime.host.buildId);
    const controls = [];
    for (let i = 0; i < 2; i++) {
      const sessionId = statuses[i].sessionId;
      const acquired = await call(clients[i], 'acquire_control', {sessionId, ownerLabel: `profile ${i}`});
      assert.equal(acquired.isError, undefined, JSON.stringify(acquired));
      const control = {sessionId, controlToken: acquired.result.controlToken};
      controls.push(control);
      const observed = await call(clients[i], 'observe', control);
      assert.equal(observed.result.nodes[0].name, 'Русский титр');
      const shot = await clients[i].callTool({name: 'vids_screenshot', arguments: control});
      assert.equal(shot.content.find(item => item.type === 'image').data, png);
    }
    await call(clients[1], 'release_control', controls[1]);
    const sameDocumentSession = hosts[1].rebind(statuses[0].documentId);
    for (let i = 0; i < 50; i++) {
      if ((await call(clients[1], 'diagnostics')).sessionId === sameDocumentSession) break;
      await sleep(10);
    }
    const competing = {sessionId: sameDocumentSession, ownerLabel: 'same document'};
    assert.equal((await call(clients[1], 'acquire_control', competing)).error.code, 'CONTROL_BUSY');
    await clients[0].close();
    assert.equal((await call(clients[1], 'acquire_control', competing)).error.code, 'CONTROL_BUSY');
    assert.equal(hosts[0].process.exitCode, null, 'MCP exit cannot stop its healthy native host');
    const resumed = new Client({name: 'resumed-owner', version: '1'});
    await resumed.connect(new StdioClientTransport({command: globalThis.process.execPath,
      args: [path.join(hosts[0].target, 'server/index.mjs')], env: {VIDS_STUDIO_SOCKET: hosts[0].socket}}));
    clients.push(resumed);
    assert.equal((await call(resumed, 'release_control', controls[0])).result.released, true);
    assert.equal((await call(clients[1], 'acquire_control', competing)).result.mode, 'write');
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    for (const host of hosts) {
      host.process.stdin.end();
      await new Promise(resolve => {
        if (host.process.exitCode !== null) return resolve();
        const timer = setTimeout(() => host.process.kill(), 2000);
        host.process.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      assert.equal(host.errors(), '');
    }
    await fs.rm(temp, {recursive: true, force: true});
  }
});
