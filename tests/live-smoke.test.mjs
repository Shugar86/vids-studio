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

const sessionId='8e2fbc11-8aa1-45d2-a6e1-44772e4906e1';
const pairingTicket='f'.repeat(64);
function fleetFixture({claimError,releaseError,grantSession=sessionId}={}) {
  const f=fixture({status:{connected:true,attached:true,documentId:'fixture-document',sessionId,fleet:true},
    acquire_control:{result:{sessionId:grantSession,controlToken:token}},
    release_control:{result:{released:!releaseError}}});
  const requests=[];const original=f.client.callTool;
  f.client.callTool=async request=>{
    requests.push(request);
    if(request.name==='vids_claim_attachment'){
      f.calls.push('claim_attachment');
      if(claimError)return {isError:true,content:[text({error:{code:claimError,outcome:'not_performed'}})]};
      return {content:[text({result:{bindingId:request.arguments.bindingId,sessionId,documentId:'fixture-document'}})]};
    }
    if(request.name==='vids_release_binding'){f.calls.push('release_binding');return {content:[text({result:{released:true}})]};}
    return original(request);
  };
  return {...f,requests};
}
const fleetOptions={documentId:'fixture-document',sessionId,pairingTicket};

test('fleet smoke persists its own claim before dispatch and releases only that exact binding',async()=>{
  const f=fleetFixture();let saved;
  const evidence=await runSmoke(f.client,{...fleetOptions,saveBinding:async binding=>{
    assert.equal(f.calls.includes('claim_attachment'),false);saved={...binding};
  }});
  assert.equal(evidence.passed,true);assert.equal(evidence.bindingReleased,true);
  assert.deepEqual(f.calls,['diagnostics','status','claim_attachment','acquire_control','observe','screenshot','release_control','release_binding']);
  assert.ok(f.requests.every(request=>request.arguments.sessionId===sessionId));
  const acquire=f.requests.find(request=>request.name==='vids_acquire_control').arguments;
  assert.equal(acquire.bindingId,saved.bindingId);assert.equal(acquire.bindingToken,saved.bindingToken);
  assert.equal(acquire.expectedDocumentId,'fixture-document');
  assert.deepEqual(f.requests.at(-1).arguments,{sessionId,bindingId:saved.bindingId,bindingToken:saved.bindingToken});
  for(const secret of [token,pairingTicket,saved.bindingToken])assert.equal(JSON.stringify(evidence).includes(secret),false);
});

test('fleet smoke cannot borrow an existing assignment or acquire without saving private recovery',async()=>{
  const busy=fleetFixture({claimError:'DOCUMENT_ALREADY_BOUND'});
  const rejected=await runSmoke(busy.client,{...fleetOptions,saveBinding:async()=>{}});
  assert.equal(rejected.passed,false);assert.equal(busy.calls.includes('acquire_control'),false);assert.equal(busy.calls.includes('release_binding'),false);
  const unsaved=fleetFixture();
  const unavailable=await runSmoke(unsaved.client,{...fleetOptions,saveBinding:async()=>{throw new Error('Recovery file exists')}});
  assert.equal(unavailable.passed,false);assert.equal(unsaved.calls.includes('claim_attachment'),false);
  const noTicket=fleetFixture();
  const missing=await runSmoke(noTicket.client,{documentId:'fixture-document',sessionId});
  assert.equal(missing.passed,false);assert.equal(noTicket.calls.includes('acquire_control'),false);
});

test('fleet smoke does not release another session or claim success while its own control is unsettled',async()=>{
  const wrong=fleetFixture({grantSession:'other-session'});
  const mismatch=await runSmoke(wrong.client,{...fleetOptions,saveBinding:async()=>{}});
  assert.equal(mismatch.passed,false);assert.equal(wrong.calls.includes('release_control'),false);
  assert.ok(wrong.requests.every(request=>request.arguments.sessionId===sessionId));
  const unsettled=fleetFixture({releaseError:true});
  const failed=await runSmoke(unsettled.client,{...fleetOptions,saveBinding:async()=>{}});
  assert.equal(failed.passed,false);assert.equal(failed.released,false);assert.equal(failed.bindingReleased,false);
  assert.equal(unsettled.calls.includes('release_binding'),false);
});
