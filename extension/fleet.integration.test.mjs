import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {launchFleetFixture} from './fleet-fixture.mjs';

test('ten real extension tabs edit in parallel; one held capture and targeted disconnect leave nine sessions and the human tab intact', {timeout:60000}, async()=>{
  const f=await launchFleetFixture({count:10});
  try{
    assert.equal(f.sessions.length,10);
    assert.equal(new Set(f.sessions.map(s=>s.sessionId)).size,10);
    assert.deepEqual(await f.activeTabs(),f.activeBefore);
    const observed=await Promise.all(f.sessions.map((_,i)=>f.request(i,'observe')));
    assert.ok(observed.every(result=>result.ok));
    const edited=await Promise.all(observed.map((result,i)=>{
      const button=result.result.nodes.find(node=>node.name===`Apply ${i}`);assert.ok(button);
      return f.request(i,'click',{snapshotId:result.result.snapshotId,nodeRef:button.ref});
    }));
    assert.ok(edited.every(result=>result.ok),JSON.stringify(edited.filter(result=>!result.ok)));
    assert.deepEqual(await Promise.all(f.pages.map(page=>page.locator('output').textContent())),Array.from({length:10},(_,i)=>`edited ${i}`));
    const native=await f.drain();
    assert.equal(native.filter(port=>port.messages.some(message=>message.type==='hello')).length,10);
    await f.holdCapture(0);
    const held=f.request(0,'screenshot',{format:'jpeg',quality:35});
    await f.waitCaptureHeld();
    const shots=await Promise.all(f.sessions.slice(1).map((_,i)=>f.request(i+1,'screenshot',{format:'jpeg',quality:35})));
    assert.ok(shots.every(result=>result.ok&&result.result.data.length>100),JSON.stringify(shots.filter(result=>!result.ok)));
    const timeout=await held;
    assert.equal(timeout.error.code,'BROWSER_TIMEOUT');
    const state=await f.worker.evaluate(()=>fixtureFleet.status());
    assert.equal(state.sessions.length,10);
    assert.equal(state.sessions.find(s=>s.sessionId===f.sessions[0].sessionId).recovery.state,'screenshot_read_pending');
    await f.releaseCapture();
    // Drain the original operation before intentionally disconnecting its tab.
    for(let i=0;i<50;i++){
      const current=(await f.request(0,'status')).result;
      if(!current.recovery)break;await delay(20);
    }
    await f.worker.evaluate(sessionId=>fixtureFleet.detach(sessionId),f.sessions[0].sessionId);
    const remaining=await f.worker.evaluate(()=>fixtureFleet.status());
    assert.equal(remaining.sessions.length,9);
    assert.deepEqual(new Set(remaining.sessions.map(s=>s.sessionId)),new Set(f.sessions.slice(1).map(s=>s.sessionId)));
    const fresh=await Promise.all(f.sessions.slice(1).map((_,i)=>f.request(i+1,'observe')));
    assert.ok(fresh.every(result=>result.ok));
    assert.deepEqual(await f.activeTabs(),f.activeBefore);
    assert.equal(await f.cover.getByLabel('Human input').inputValue(),'untouched');
  }finally{await f.close();}
});
