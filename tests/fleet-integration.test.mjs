import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {launchFullChainFixture} from './fleet-chain-fixture.mjs';

const execute=promisify(execFile);
const parse = response => JSON.parse(response.content.find(item=>item.type==='text').text);
const errorCode = response => parse(response).error?.code;
const success = response => {
  assert.notEqual(response.isError,true,`MCP call failed: ${errorCode(response)}`);
  return parse(response);
};

// These are ten actual client/host processes and ten Chrome debugger targets.
// No real Google document, user browser profile, mouse or keyboard is involved.
test('ten independent MCP clients own ten real extension tabs; cross-binding and stalled capture cannot affect other tasks', {timeout:90000}, async()=>{
  const chain=await launchFullChainFixture({count:10});
  const {browserFixture:f,clients,sessions}=chain;
  const bindings=sessions.map((session,i)=>({sessionId:session.sessionId,expectedDocumentId:session.documentId,
    bindingId:randomUUID(),bindingToken:randomBytes(32).toString('base64url'),intentId:randomUUID(),ownerLabel:`Fixture task ${i}`}));
  const call=(i,method,args={})=>clients[i].callTool({name:`vids_${method}`,arguments:args});
  // Resource pressure can legitimately reject an undispatched request. Retry
  // only that explicit not_performed admission outcome, never unknown input.
  const admitted=async(i,method,args)=>{
    for(let attempt=0;attempt<100;attempt++){
      const response=await call(i,method,args);
      if(errorCode(response)!=='FLEET_BUSY')return response;
      assert.equal(parse(response).error.outcome,'not_performed');
      await delay(20+attempt*5);
    }
    throw new Error(`Admission remained busy for ${method}`);
  };
  try{
    assert.equal(clients.length,10);
    assert.equal(new Set(chain.nativeProcesses.map(child=>child.pid)).size,10);
    assert.equal(new Set(sessions.map(session=>session.sessionId)).size,10);
    const addressedStatus=success(await call(0,'status',{sessionId:sessions[0].sessionId}));
    assert.equal(addressedStatus.connected,true);
    assert.equal(addressedStatus.compatibility.ready,true,'An addressed fleet session must retain the complete MCP/host/extension compatibility check');
    const discovery=success(await call(0,'list_sessions'));
    assert.equal(discovery.sessions.length,10);
    assert.deepEqual(new Set(discovery.sessions.map(session=>session.sessionId)),new Set(sessions.map(session=>session.sessionId)));
    const publicMetadata=JSON.stringify(discovery);
    assert.ok(chain.attached.every(item=>!publicMetadata.includes(item.pairing.ticket)));
    const claims=await Promise.all(bindings.map((binding,i)=>call(i,'claim_attachment',{
      ...binding,pairingTicket:chain.attached[i].pairing.ticket})));
    claims.forEach((response,i)=>assert.equal(success(response).result.documentId,sessions[i].documentId));
    const acquired=await Promise.all(bindings.map((binding,i)=>call(i,'acquire_control',binding)));
    const controls=acquired.map(response=>success(response).result.controlToken);
    assert.equal(new Set(controls).size,10);
    const controlled=i=>({sessionId:sessions[i].sessionId,controlToken:controls[i]});
    const foreignBinding=await call(0,'acquire_control',{
      ...bindings[0],sessionId:sessions[1].sessionId,expectedDocumentId:sessions[1].documentId});
    assert.equal(errorCode(foreignBinding),'BINDING_MISMATCH');
    const foreignControl=await call(0,'observe',{sessionId:sessions[1].sessionId,controlToken:controls[0]});
    assert.equal(errorCode(foreignControl),'CONTROL_BUSY');
    const observed=await Promise.all(sessions.map((_,i)=>admitted(i,'observe',controlled(i))));
    const snapshots=observed.map(response=>success(response).result);
    const wrongSnapshot=await admitted(1,'click',{...controlled(1),snapshotId:snapshots[0].snapshotId,
      nodeRef:snapshots[0].nodes.find(node=>node.name==='Apply 0').ref,operation_id:randomUUID()});
    assert.equal(errorCode(wrongSnapshot),'STALE_SNAPSHOT');
    const clicks=await Promise.all(snapshots.map((snapshot,i)=>admitted(i,'click',{
      ...controlled(i),snapshotId:snapshot.snapshotId,nodeRef:snapshot.nodes.find(node=>node.name===`Apply ${i}`).ref,
      operation_id:randomUUID()})));
    clicks.forEach(success);
    assert.deepEqual(await Promise.all(f.pages.map(page=>page.locator('output').textContent())),Array.from({length:10},(_,i)=>`edited ${i}`));
    // Configure a real two-slot budget through the same CLI as the monitor.
    // One heavy permit must leave the other slot for ordinary browser work.
    const python=chain.env.VIDS_STUDIO_PYTHON||(process.platform==='win32'?'python':'python3');
    const policy=JSON.parse((await execute(python,[fileURLToPath(new URL('../native/fleet.py',import.meta.url)),
      'policy','--max-concurrency','2','--json'],{env:chain.env})).stdout);
    assert.equal(policy.ok,true);assert.equal(policy.result.policy.effectiveConcurrency,2);
    await f.worker.evaluate(()=>{
      globalThis.fixtureCaptureDispatches={};
      for(const port of fixturePorts)port.receivers.push(message=>{
        if(message.type==='request'&&message.method==='screenshot')
          fixtureCaptureDispatches[message.sessionId]=(fixtureCaptureDispatches[message.sessionId]||0)+1;
      });
    });
    const captures=index=>f.worker.evaluate(sessionId=>fixtureCaptureDispatches[sessionId]||0,sessions[index].sessionId);
    await f.holdCapture(0);
    const held=call(0,'screenshot',{...controlled(0),format:'jpeg',quality:35});
    await Promise.race([f.waitCaptureHeld(),held.then(response=>{throw new Error(`Held capture ended before dispatch: ${errorCode(response)||'unexpected success'}`)})]);
    assert.equal(await captures(0),1);
    const otherReads=await Promise.all(sessions.slice(1).map((_,i)=>admitted(i+1,'observe',controlled(i+1))));
    otherReads.forEach(success);
    const blocked=await call(1,'screenshot',{...controlled(1),format:'jpeg',quality:35});
    assert.equal(errorCode(blocked),'FLEET_BUSY');
    assert.equal(parse(blocked).error.outcome,'not_performed');
    assert.equal(await captures(1),0,'Reserved ordinary slot must not dispatch a second heavy command');
    const timeout=await held;
    assert.equal(errorCode(timeout),'BROWSER_TIMEOUT');
    const pending=success(await call(0,'list_sessions'));
    assert.equal(pending.sessions.filter(session=>session.state==='attached').length,10);
    assert.equal(pending.sessions.find(session=>session.sessionId===sessions[0].sessionId).pending,1);
    assert.equal(pending.sessions.find(session=>session.sessionId===sessions[0].sessionId).recovery.phase,'read_quarantined');
    const afterTimeout=await Promise.all(sessions.slice(1).map((_,i)=>admitted(i+1,'observe',controlled(i+1))));
    afterTimeout.forEach(success);
    const stillBlocked=await call(1,'screenshot',{...controlled(1),format:'jpeg',quality:35});
    assert.equal(errorCode(stillBlocked),'FLEET_BUSY');assert.equal(parse(stillBlocked).error.outcome,'not_performed');
    assert.equal(await captures(1),0,'A timeout must not manufacture free heavy capacity');
    await f.releaseCapture();
    let resolved=false;
    for(let attempt=0;attempt<100;attempt++){
      const state=success(await call(0,'list_sessions')).sessions.find(session=>session.sessionId===sessions[0].sessionId);
      if(state.pending===0&&!state.recovery){resolved=true;break}await delay(20);
    }
    assert.ok(resolved,'Original held read must settle before disconnect');
    const shot=await admitted(1,'screenshot',{...controlled(1),format:'jpeg',quality:35});
    success(shot);assert.ok(shot.content.some(item=>item.type==='image'&&item.mimeType==='image/jpeg'&&item.data.length>100));
    assert.equal(await captures(1),1,'A new capture is admitted after the original heavy permit settles');
    await f.worker.evaluate(sessionId=>fixtureFleet.detach(sessionId),sessions[0].sessionId);
    const remaining=await Promise.all(sessions.slice(1).map((_,i)=>admitted(i+1,'observe',controlled(i+1))));
    remaining.forEach(success);
    assert.equal((await f.worker.evaluate(()=>fixtureFleet.status())).sessions.length,9);
    assert.deepEqual(await f.activeTabs(),f.activeBefore);
    assert.equal(await f.cover.getByLabel('Human input').inputValue(),'untouched');
    chain.check();
  }finally{await chain.close();}
});


test('full-chain fixture cleans up a native interpreter startup failure', {timeout:15000}, async()=>{
  const previous=process.env.VIDS_STUDIO_PYTHON;
  process.env.VIDS_STUDIO_PYTHON='/nonexistent/vids-fixture-python';
  try{await assert.rejects(launchFullChainFixture({count:1,connectClients:false}),{code:'ENOENT'});}
  finally{if(previous===undefined)delete process.env.VIDS_STUDIO_PYTHON;else process.env.VIDS_STUDIO_PYTHON=previous;}
});
