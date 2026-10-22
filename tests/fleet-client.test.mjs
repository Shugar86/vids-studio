import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp, mkdir, chmod, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {bridgeRequest, sessionSocketPath} from '../server/bridge-client.mjs';

test('ten independently addressed clients proceed when one session is stalled', {skip: process.platform === 'win32'}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vids-fleet-route-'));
  const base = join(directory, 'bridge.sock');
  const old = process.env.VIDS_STUDIO_SOCKET;
  const servers = [], sockets = new Set(), seen = [];
  process.env.VIDS_STUDIO_SOCKET = base;
  try {
    await mkdir(join(directory, 'sessions'), {mode: 0o700});
    const ids = Array.from({length: 10}, () => randomUUID());
    for (const [index, sessionId] of ids.entries()) {
      const endpoint = sessionSocketPath(sessionId, base);
      const server = net.createServer(socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
        let raw = '';
        socket.on('data', chunk => {
          raw += chunk;
          if (!raw.includes('\n')) return;
          const request = JSON.parse(raw.split('\n')[0]);
          seen.push({sessionId, request});
          assert.equal(request.sessionId, sessionId, 'another worker must never receive this command');
          if (index === 0) return;
          socket.end(JSON.stringify({v: 3, type: 'response', id: request.id, ok: true,
            result: {sessionId, documentId: `fixture-${index}`, snapshotId: `snapshot-${index}`}}) + '\n');
        });
      });
      await new Promise(resolve => server.listen(endpoint, resolve));
      await chmod(endpoint, 0o600); servers.push(server);
    }
    let stalledFinished = false;
    const stalled = bridgeRequest('screenshot', {sessionId: ids[0], controlToken: 'a'.repeat(64)}, {timeoutMs: 700})
      .then(result => {stalledFinished = true; return result;});
    const healthy = await Promise.all(ids.slice(1).map(sessionId => bridgeRequest('observe', {sessionId, controlToken: 'b'.repeat(64)}, {timeoutMs: 500})));
    assert.equal(stalledFinished, false, 'healthy workers must not wait for the stalled timeout');
    assert.equal(healthy.length, 9);
    healthy.forEach((response, index) => {
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.result.sessionId, ids[index + 1]);
    });
    assert.equal((await stalled).error.code, 'TIMEOUT');
    assert.equal(seen.length, 10, 'no request is replayed');
    const missing = await bridgeRequest('click', {sessionId: randomUUID(), controlToken: 'c'.repeat(64), operation_id: randomUUID()});
    assert.equal(missing.error.code, 'NOT_CONNECTED');
    assert.equal(missing.error.outcome, 'not_performed');
    assert.equal(seen.length, 10, 'a stale session must not fall through to another worker');
  } finally {
    if (old === undefined) delete process.env.VIDS_STUDIO_SOCKET; else process.env.VIDS_STUDIO_SOCKET = old;
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await rm(directory, {recursive: true, force: true});
  }
});

test('session endpoints cannot escape their private namespace', () => {
  for (const sessionId of ['../bridge', '/tmp/other', 'not-a-session', '', null]) assert.throws(() => sessionSocketPath(sessionId, '/private/bridge.sock'), {code: 'SESSION_REQUIRED'});
  const sessionId = randomUUID();
  assert.equal(sessionSocketPath(sessionId, '/private/bridge.sock'), join('/private', 'sessions', `${sessionId}.${process.platform === 'win32' ? 'json' : 'sock'}`));
});
