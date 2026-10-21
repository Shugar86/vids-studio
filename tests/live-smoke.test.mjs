import assert from 'node:assert/strict';
import test from 'node:test';
import {runSmoke} from '../scripts/live_smoke.mjs';

const token = 'owner-capability-'.repeat(3);
const text = value => ({type: 'text', text: JSON.stringify(value)});
function fixture(override = {}) {
  const calls = [];
  const result = {
    diagnostics: {compatibility: {ready: true}, runtime: {mcp: {version: 'fixture'}}},
    status: {connected: true, attached: true, documentId: 'fixture-document', sessionId: 'fixture-session'},
    acquire_control: {result: {sessionId: 'fixture-session', controlToken: token}},
    observe: {result: {documentId: 'fixture-document', snapshotId: 'snapshot-observe', nodes: [{name: 'Проба'}]}},
    release_control: {result: {released: true}}, ...override,
  };
  const client = {
    connect: async () => {}, close: async () => {}, listTools: async () => ({tools: [{name: 'vids_status'}]}),
    callTool: async ({name}) => {
      const method = name.slice(5); calls.push(method);
      if (method === 'screenshot') return {content: [text({snapshotId: 'snapshot-image', image: {width: 1, height: 1}}), {type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZJkAAAAASUVORK5CYII='}]};
      return {content: [text(result[method])]};
    },
  };
  return {client, calls};
}

test('read-only smoke passes only after matching snapshots and explicit release, without exposing capabilities', async () => {
  const f = fixture(); const evidence = await runSmoke(f.client, {documentId: 'fixture-document'});
  assert.equal(evidence.passed, true); assert.equal(evidence.released, true); assert.equal(evidence.observation.hasCyrillic, true);
  assert.deepEqual(f.calls, ['diagnostics', 'status', 'acquire_control', 'observe', 'screenshot', 'release_control']);
  assert.equal(JSON.stringify(evidence).includes(token), false);
});

test('incompatible runtime or incorrect attached document never acquires control', async () => {
  for (const override of [{diagnostics: {compatibility: {ready: false}}}, {status: {connected: true, attached: true, documentId: 'wrong', sessionId: 'fixture-session'}}]) {
    const f = fixture(override); const evidence = await runSmoke(f.client, {documentId: 'fixture-document'});
    assert.equal(evidence.passed, false); assert.equal(f.calls.includes('acquire_control'), false);
  }
});

test('wrong observation document and unconfirmed release cannot produce a false PASS', async () => {
  for (const override of [{observe: {result: {documentId: 'wrong', snapshotId: 's', nodes: []}}}, {release_control: {result: {released: false}}}]) {
    const f = fixture(override); const evidence = await runSmoke(f.client, {documentId: 'fixture-document'});
    assert.equal(evidence.passed, false); assert.equal(f.calls.at(-1), 'release_control');
  }
});

test('screenshot output failure still releases the own lease and remains failed', async () => {
  const f = fixture(); const evidence = await runSmoke(f.client, {documentId: 'fixture-document', screenshotPath: '/absolute/new.png', write: async () => {throw new Error('fixture output exists');}});
  assert.equal(evidence.passed, false); assert.equal(evidence.released, true); assert.match(evidence.error, /output exists/);
});
