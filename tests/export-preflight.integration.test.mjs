import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {launchFullChainFixture} from './fleet-chain-fixture.mjs';

const body = response => JSON.parse(response.content.find(item => item.type === 'text').text);
const success = response => { assert.notEqual(response.isError, true, JSON.stringify(body(response))); return body(response); };

test('fleet export preflight reads the exact live watcher and fails closed before any menu on missing fresh receipt', {timeout:30000}, async () => {
  const chain = await launchFullChainFixture({count:2});
  const f = chain.browserFixture;
  const call = (index, method, args) => chain.clients[index].callTool({name:`vids_${method}`, arguments:args});
  try {
    const controls = [];
    for (const [index, session] of chain.sessions.entries()) {
      const binding = {sessionId:session.sessionId, expectedDocumentId:session.documentId,
        bindingId:randomUUID(), bindingToken:randomBytes(32).toString('base64url'), intentId:randomUUID(), ownerLabel:`Export fixture ${index}`};
      success(await call(index, 'claim_attachment', {...binding, pairingTicket:chain.attached[index].pairing.ticket}));
      controls.push(success(await call(index, 'acquire_control', binding)).result.controlToken);
      // Fixture-only page content. The production driver still has no evaluate API.
      await f.pages[index].evaluate(() => {
        document.body.innerHTML = '<button role="menuitem" id="file">File</button><button role="menuitem" id="download">Download d ►</button><button role="menuitem" id="mp4">MP4 video (.mp4) d</button>';
        document.head.querySelector('style').remove();
        window.menuClicks = 0; window.exportClicks = 0;
        document.querySelector('#file').onclick = document.querySelector('#download').onclick = () => window.menuClicks++;
        document.querySelector('#mp4').onclick = () => window.exportClicks++;
      });
    }
    const args = index => ({jobId:randomUUID(), jobToken:randomBytes(32).toString('base64url'), kind:'export_mp4', intentId:randomUUID(),
      sessionId:chain.sessions[index].sessionId, documentId:chain.sessions[index].documentId, controlToken:controls[index],
      automaticDownload:{confirmed:true, checkedAt:new Date().toISOString(), source:'Isolated fixture; no real download is triggered'}});

    // Establish an existing watch through the real driver/Chrome click. The
    // fixture button intentionally produces no download, leaving a sent watch.
    const observed = (await f.request(0, 'observe')).result;
    const triggered = await f.request(0, 'export_trigger', {jobId:randomUUID(), snapshotId:observed.snapshotId,
      nodeRef:observed.nodes.find(node => node.name === 'MP4 video (.mp4) d').ref,
      automaticDownloadConfirmed:true, downloadModeCheckedAt:new Date().toISOString()});
    assert.equal(triggered.ok, true);
    assert.equal(await f.pages[0].evaluate(() => window.exportClicks), 1);
    // Fleet diagnostics are intentionally local; the new guard must not infer
    // "clear" from their lack of fresh watcher metadata.
    const cached = success(await call(0, 'status', {sessionId:chain.sessions[0].sessionId}));
    assert.equal(cached.attached, true); assert.equal(cached.exportWatch, undefined);
    const busyArgs = args(0);
    assert.equal(body(await call(0, 'job_start', busyArgs)).error.code, 'EXPORT_WATCH_BUSY');
    assert.equal(body(await call(0, 'job_status', {jobId:busyArgs.jobId, jobToken:busyArgs.jobToken})).error.code, 'JOB_NOT_FOUND');
    assert.equal(await f.pages[0].evaluate(() => window.menuClicks), 0);
    assert.equal(await f.pages[0].evaluate(() => window.exportClicks), 1);

    // Hold only the native messaging delivery of the fresh read for the second
    // attachment. Its real native timeout must not be replaced by cached null.
    await f.worker.evaluate(sessionId => {
      globalThis.fixtureOriginalDeliver = fixtureDeliver;
      globalThis.fixtureHeldPreflight = null;
      globalThis.fixturePreflightSent = new Promise(resolve => { globalThis.fixtureNotifyPreflight = resolve; });
      globalThis.fixtureDeliver = (id, message) => {
        if (message.type === 'request' && message.method === 'export_preflight' && message.sessionId === sessionId) {
          fixtureHeldPreflight = {id, message}; fixtureNotifyPreflight(); return;
        }
        return fixtureOriginalDeliver(id, message);
      };
    }, chain.sessions[1].sessionId);
    const lostArgs = args(1);
    const lost = call(1, 'job_start', lostArgs);
    await f.worker.evaluate(() => fixturePreflightSent);
    const statusWhileWaiting = success(await call(1, 'status', {sessionId:chain.sessions[1].sessionId}));
    assert.equal(statusWhileWaiting.attached, true, 'Local status stays available during a missing preflight reply');
    const timeout = body(await lost);
    assert.equal(timeout.error.code, 'TIMEOUT');
    assert.equal(body(await call(1, 'job_status', {jobId:lostArgs.jobId, jobToken:lostArgs.jobToken})).error.code, 'JOB_NOT_FOUND');
    assert.equal(await f.pages[1].evaluate(() => window.menuClicks + window.exportClicks), 0);
    await f.worker.evaluate(() => {
      const {id, message} = fixtureHeldPreflight;
      fixtureDeliver = fixtureOriginalDeliver;
      fixtureOriginalDeliver(id, message);
    });
    // A late clear reply settles only the old read; it cannot resume the job.
    await delay(100);
    assert.equal(await f.pages[1].evaluate(() => window.menuClicks + window.exportClicks), 0);
    success(await call(1, 'observe', {sessionId:chain.sessions[1].sessionId, controlToken:controls[1]}));
    assert.deepEqual(await f.activeTabs(), f.activeBefore);
    assert.equal(await f.cover.getByLabel('Human input').inputValue(), 'untouched');
    chain.check();
  } finally { await chain.close(); }
});
