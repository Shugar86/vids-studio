import test from 'node:test';
import assert from 'node:assert/strict';
import {createFleetDriver} from './fleet.js';
import {chromeStorage} from '../tests/chrome-storage.mjs';

function event() { const listeners = new Set(); return {listeners,addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}; }
function fixture() {
  const tabs = new Map(Array.from({length:10}, (_,i)=>[i+1,{id:i+1,title:`Video ${i}`,url:`https://docs.google.com/videos/d/fleet_${i}/edit`} ]));
  const calls=[], ports=[];
  const storage=chromeStorage(); storage.session=chromeStorage().local;
  const downloads={onCreated:event(),onChanged:event(),search:async()=>[]};
  const api={storage,downloads,tabs:{get:async id=>tabs.get(id)},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
    debugger:{attach:async target=>{calls.push(['attach',target.tabId]);},detach:async target=>{calls.push(['detach',target.tabId]);},
      sendCommand:async(target,method)=>method==='Page.getFrameTree'?{frameTree:{frame:{id:`frame-${target.tabId}`,url:tabs.get(target.tabId).url}}}:{}},
    runtime:{connectNative:()=>{const port={messages:[],onMessage:event(),onDisconnect:event(),postMessage(message){this.messages.push(message)},disconnect(){}};ports.push(port);return port;}}};
  return {api,tabs,calls,ports,downloads,fleet:createFleetDriver(api)};
}

test('ten attachments have independent ports and capabilities; attaching another never switches the existing tab', async()=>{
  const f=fixture();
  const attached=await Promise.all([...f.tabs.values()].map(tab=>f.fleet.attach(tab)));
  const current=await f.fleet.status();
  assert.equal(current.sessions.length,10);
  assert.equal(new Set(current.sessions.map(s=>s.sessionId)).size,10);
  assert.equal(new Set(attached.map(s=>s.pairing.ticket)).size,10);
  assert.ok(attached.every(s=>/^[a-f0-9]{64}$/.test(s.pairing.ticket)));
  assert.equal(f.ports.length,10);
  assert.equal(f.calls.filter(c=>c[0]==='detach').length,0);
  for(const port of f.ports){const hello=port.messages[0];assert.equal(hello.type,'hello');assert.equal(hello.v,2);assert.equal(hello.fleet.browserInstanceId,current.browserInstanceId);assert.match(hello.fleet.pairingTicket,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(hello.status).includes(hello.fleet.pairingTicket),false);}
  assert.equal(JSON.stringify(current).includes(attached[0].pairing.ticket),false);
  const first=attached[0].pairing;
  const same=await f.fleet.attach(f.tabs.get(1));
  assert.equal(same.pairing.ticket,first.ticket);
  assert.equal(f.ports.length,10);
  assert.equal(f.downloads.onCreated.listeners.size,1);
  assert.equal(f.downloads.onChanged.listeners.size,1);
  await f.fleet.detach(first.sessionId);
  assert.equal((await f.fleet.status()).sessions.length,9);
  assert.deepEqual(f.calls.filter(c=>c[0]==='detach'),[['detach',1]]);
  await assert.rejects(f.fleet.detach(first.sessionId),/not attached/);
  for(const s of (await f.fleet.status()).sessions)await f.fleet.detach(s.sessionId);
  assert.equal(f.downloads.onCreated.listeners.size,0);
  assert.equal(f.downloads.onChanged.listeners.size,0);
});

test('native claim clears only the exact popup ticket; untrusted or old events do not claim another session',async()=>{
  const f=fixture();
  const a=(await f.fleet.attach(f.tabs.get(1))).pairing;
  const b=(await f.fleet.attach(f.tabs.get(2))).pairing;
  const listener=[...f.ports[0].onMessage.listeners][0];
  listener({v:2,type:'event',event:'pairing_claimed',sessionId:b.sessionId});
  assert.equal(f.fleet.pairing(a.sessionId).ticket,a.ticket);
  listener({v:2,type:'event',event:'pairing_claimed',sessionId:a.sessionId});
  assert.equal(f.fleet.pairing(a.sessionId).ticket,null);
  assert.equal(f.fleet.pairing(b.sessionId).ticket,b.ticket);
  assert.equal((await f.fleet.status()).sessions.find(s=>s.sessionId===a.sessionId).pairingState,'claimed');
  await assert.rejects(f.fleet.detach(),/exact attached session/);
  for(const s of (await f.fleet.status()).sessions)await f.fleet.detach(s.sessionId);
});

test('a failing attachment cannot block or detach another tab, and incomplete attachments stay out of discovery', async()=>{
  const f=fixture();
  const original=f.api.debugger.sendCommand;
  let rejectFirst, notify;
  const sent=new Promise(resolve=>{notify=resolve});
  f.api.debugger.sendCommand=async(target,method,params)=>{
    if(target.tabId===1&&method==='Page.enable'){notify();return new Promise((_,reject)=>{rejectFirst=reject});}
    return original(target,method,params);
  };
  const failed=f.fleet.attach(f.tabs.get(1));
  const rejection=assert.rejects(failed,/Renderer unavailable/);
  await sent;
  const healthy=await f.fleet.attach(f.tabs.get(2));
  assert.deepEqual((await f.fleet.status()).sessions.map(s=>s.sessionId),[healthy.pairing.sessionId]);
  rejectFirst(new Error('Renderer unavailable'));await rejection;
  assert.deepEqual(f.calls.filter(c=>c[0]==='detach'),[['detach',1]]);
  assert.equal((await f.fleet.status()).sessions[0].sessionId,healthy.pairing.sessionId);
  assert.equal(f.downloads.onCreated.listeners.size,1);
  await f.fleet.detach(healthy.pairing.sessionId);
  assert.equal(f.downloads.onCreated.listeners.size,0);
});
