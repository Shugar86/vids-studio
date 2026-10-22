import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverBinding, rememberBinding, readFences, recordFence} from './fences.js';

function fixture(error) {
  const data = {};
  const detached = [];
  const api = {storage: {local: {
    get: async key => ({[key]: structuredClone(data[key])}),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async key => { delete data[key]; },
  }}, debugger: {detach: async target => { detached.push(target); if (error) throw new Error(error); }}};
  return {api, data, detached};
}

test('worker restart fences exactly its persisted target without discovering or attaching tabs', async () => {
  for (const outcome of [undefined, 'No tab with given id 7.', 'Debugger is not attached to the tab with id: 7.']) {
    const f = fixture(outcome);
    await rememberBinding(f.api, {profileId: 'codex', tabId: 7, sessionId: 'lost-session', documentId: 'document-a'});
    await recoverBinding(f.api, 'codex');
    assert.deepEqual(f.detached, [{tabId: 7}]);
    const receipts = await readFences(f.api);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].documentId, 'document-a');
    await recoverBinding(f.api, 'codex');
    assert.equal(f.detached.length, 1);
  }
});

test('mismatched profile and errors about a different tab are never fencing evidence', async () => {
  const f = fixture('Debugger is not attached to the tab with id: 8.');
  await rememberBinding(f.api, {profileId: 'codex', tabId: 7, sessionId: 'lost-session', documentId: 'document-a'});
  await assert.rejects(recoverBinding(f.api, 'claude'), /Invalid stored/);
  assert.equal(f.detached.length, 0);
  await assert.rejects(recoverBinding(f.api, 'codex'), /Could not fence/);
  assert.deepEqual(await readFences(f.api), []);
});

test('fence retention is bounded and carries no capabilities', async () => {
  const f = fixture();
  for (let i = 0; i < 70; i++) await recordFence(f.api, {profileId: 'codex', sessionId: `s${i}`, documentId: 'document-a'});
  const receipts = await readFences(f.api);
  assert.equal(receipts.length, 64);
  assert.equal(receipts.at(-1).sessionId, 's69');
  assert.equal(receipts[0].sessionId, 's6');
  assert.equal(Object.hasOwn(receipts[0], 'controlToken'), false);
});

test('parallel attachment writes and fence receipts retain every independent session', async () => {
  const f = fixture();
  const bindings = Array.from({length: 10}, (_, index) => ({profileId:'codex',tabId:index+1,sessionId:`fleet-${index}`,documentId:`video-${index}`}));
  await Promise.all(bindings.map(binding => rememberBinding(f.api, binding)));
  assert.equal(f.data.vidsStudioActiveBindingsV2.length, 10);
  await Promise.all(bindings.map(binding => recordFence(f.api, binding)));
  assert.equal((await readFences(f.api)).length, 10);
});

test('legacy binding migration and chosen-tab recovery never detach other persisted tabs', async () => {
  const f = fixture();
  f.data.vidsStudioActiveBindingV1 = {profileId:'codex',tabId:7,sessionId:'legacy',documentId:'legacy-video'};
  await rememberBinding(f.api, {profileId:'codex',tabId:8,sessionId:'healthy',documentId:'healthy-video'});
  assert.equal(f.data.vidsStudioActiveBindingV1, undefined);
  assert.equal(f.data.vidsStudioActiveBindingsV2.length, 2);
  await recoverBinding(f.api, 'codex', 7);
  assert.deepEqual(f.detached, [{tabId:7}]);
  assert.deepEqual(f.data.vidsStudioActiveBindingsV2.map(item => item.sessionId), ['healthy']);
  assert.deepEqual((await readFences(f.api)).map(item => item.sessionId), ['legacy']);
});

test('ambiguous legacy single-driver recovery refuses to revoke multiple tabs', async () => {
  const f = fixture();
  await Promise.all([7,8].map(tabId => rememberBinding(f.api, {profileId:'codex',tabId,sessionId:`s${tabId}`,documentId:`d${tabId}`})));
  await assert.rejects(recoverBinding(f.api, 'codex'), /select the tab/);
  assert.deepEqual(f.detached, []);
});
