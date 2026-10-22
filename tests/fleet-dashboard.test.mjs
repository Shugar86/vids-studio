import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import http from 'node:http';
import {createFleetCLI, publicSnapshot, startDashboard} from '../server/fleet-dashboard.mjs';

const executeFile = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const sessionId = 'da152e97-6f1c-4c43-b513-5979ac917001';
function sample() {
  return {schemaVersion:1,generatedAt:Date.now()/1000,policy:{paused:false,maxConcurrency:10,effectiveConcurrency:10},resources:{memoryAvailableBytes:8e9,memoryTotalBytes:16e9,cpuPercent:20,pressure:{memory:{avg10:0}}},summary:{attached:1,pending:1},sessions:[{id:sessionId,sessionId,documentId:'fixture-video',profileId:'claude',browserInstanceId:'browser-fixture',ownerLabel:'Synthetic fixture',state:'attached',updatedAt:Date.now()/1000,pending:1,paused:false,runtime:{version:'0.3.0'},lastAction:'observe',recovery:null}]};
}
async function fixture(t, fleet = async () => sample()) {
  const monitor = await startDashboard({fleet}); t.after(()=>monitor.close());
  const headers = {Authorization:`Bearer ${monitor.token}`,'X-Vids-Monitor':'1'};
  return {...monitor,headers,api:(path,options={})=>fetch(monitor.origin+path,{...options,headers:{...headers,...options.headers}})};
}

test('monitor serves only bundled assets and redacts secrets from real-shaped telemetry', async t=>{
  const value = sample(); value.token = 'DO_NOT_EXPOSE'; value.policy.secret = 'DO_NOT_EXPOSE'; value.resources.endpoint = 'DO_NOT_EXPOSE'; value.sessions[0].pairingTicket = 'DO_NOT_EXPOSE'; value.sessions[0].runtime={host:{version:'0.4.0',buildId:'actual-host',profileId:'claude',protocol:4,token:'DO_NOT_EXPOSE'},extension:{version:'0.4.0',buildId:'actual-extension',profileId:'claude',protocol:3}}; value.sessions[0].recovery = {phase:'cdp_timeout',method:'Page.startScreencast',raw:'DO_NOT_EXPOSE',blocks:['mutations','screenshot','DO_NOT_EXPOSE']}; value.policy.adaptationReason='telemetry_stale';value.policy.telemetryAvailable=false;
  const m = await fixture(t,async()=>value);
  const page = await fetch(m.origin); assert.equal(page.status,200); assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/); assert.equal(page.headers.get('cache-control'),'no-store'); assert.ok(!(await page.text()).includes(m.token));
  const response = await m.api('/api/snapshot'); const data = await response.json();
  assert.equal(response.status,200); assert.equal(data.sessions[0].documentId,'fixture-video'); assert.equal(data.sessions[0].updatedAt,value.sessions[0].updatedAt); assert.equal(data.sessions[0].recovery.phase,'cdp_timeout'); assert.ok(!JSON.stringify(data).includes('DO_NOT_EXPOSE'));
  assert.equal(data.sessions[0].runtime.host.version,'0.4.0');assert.equal(data.sessions[0].runtime.extension.buildId,'actual-extension');assert.deepEqual(data.sessions[0].recovery.blocks,['mutations','screenshot']);assert.equal(data.policy.telemetryAvailable,false);assert.equal(data.policy.adaptationReason,'telemetry_stale');
  for (const path of ['/server/fleet-dashboard.mjs','/native/fleet.py','/etc/passwd','/app.js?token=x','/api/snapshot?file=/etc/passwd']) assert.equal((await m.api(path)).status,404);
});

test('capability, exact host, cross-origin and CSRF guards precede registry access', async t=>{
  let calls=0; const m=await fixture(t,async()=>{calls++;return sample();});
  assert.equal((await fetch(m.origin+'/api/snapshot')).status,401);
  assert.equal((await m.api('/api/snapshot',{headers:{Authorization:'Bearer invalid'}})).status,401);
  assert.equal((await m.api('/api/snapshot',{headers:{'X-Vids-Monitor':'0'}})).status,401);
  for(const headers of [{Origin:'https://attacker.invalid'},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Site':'same-site'}]) assert.equal((await m.api('/api/snapshot',{headers})).status,403);
  // Fetch deliberately normalizes Host; use a real wire request to test rebinding.
  const hostStatus=await new Promise((resolve,reject)=>{const request=http.request(m.origin+'/api/snapshot',{headers:{...m.headers,Host:'attacker.invalid'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});assert.equal(hostStatus,403);
  assert.equal((await m.api('/api/policy',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"paused":true}'})).status,403);
  assert.equal((await m.api('/api/policy',{method:'OPTIONS',headers:{Origin:'https://attacker.invalid'}})).status,403);
  assert.equal(calls,0);
});

test('policy changes are explicit, bounded, scoped and never contain browser commands',async t=>{
  let value=sample();const calls=[];
  const m=await fixture(t,async(op,policy)=>{calls.push([op,policy]);if(op==='policy'){if(policy.sessionId)value.sessions[0].paused=policy.paused;else Object.assign(value.policy,policy);}return value;});
  const post=body=>m.api('/api/policy',{method:'POST',headers:{Origin:m.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({paused:true,sessionId})).status,200);
  assert.deepEqual(calls[0],['policy',{paused:true,sessionId}]);assert.equal(value.sessions[0].paused,true);assert.equal(value.policy.paused,false);
  assert.equal((await post({maxConcurrency:50})).status,200);assert.equal(value.policy.maxConcurrency,50);
  for(const invalid of [{},{maxConcurrency:0},{maxConcurrency:101},{maxConcurrency:2.5},{paused:'true'},{method:'click'},{sessionId},{sessionId,paused:true,maxConcurrency:5},{paused:true,maxConcurrency:5},{sessionId:'../private',paused:true},{paused:true,data:'x'.repeat(3000)}])assert.equal((await post(invalid)).status,400);
  assert.equal(calls.filter(([op])=>op==='policy').length,2);
});

test('snapshot requests coalesce and cache without browser polling or policy mutation',async t=>{
  let count=0;let release;const gate=new Promise(resolve=>{release=resolve;});const m=await fixture(t,async(op)=>{assert.equal(op,'snapshot');count++;await gate;return sample();});
  const requests=Array.from({length:8},()=>m.api('/api/snapshot'));await new Promise(resolve=>setTimeout(resolve,25));release();
  assert.ok((await Promise.all(requests)).every(response=>response.status===200));assert.equal(count,1);
  assert.equal((await m.api('/api/snapshot')).status,200);assert.equal(count,1);
});

test('malformed registry data and runtime failures return a bounded unavailable response',async t=>{
  for(const value of [{schemaVersion:2,sessions:[]},{schemaVersion:1,generatedAt:{token:'private'},sessions:[]},{schemaVersion:1,generatedAt:0,sessions:Array(513).fill({})}])assert.throws(()=>publicSnapshot(value));
  const m=await fixture(t,async()=>{throw new Error('private path /secret/token');});const response=await m.api('/api/snapshot');assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'FLEET_UNAVAILABLE'});
});

test('real fleet CLI reads isolated registry metadata across both profiles and policy persists',async t=>{
  const temporary=await mkdtemp(join(tmpdir(),'vids-monitor-registry-'));t.after(()=>rm(temporary,{recursive:true,force:true}));const directory=join(temporary,'fleet');
  const fleet=createFleetCLI({registryDirectory:directory,jobsDirectory:join(temporary,'jobs'),mediaBudgetDirectory:join(temporary,'media-budget')});const before=await fleet('snapshot');assert.equal(before.sessions.length,0);await assert.rejects(access(directory));
  const script=`import sys,uuid\nsys.path.insert(0,sys.argv[1])\nfrom fleet import FleetRegistry\nf=FleetRegistry(sys.argv[2])\nfor p in ('codex','claude'):\n s=str(uuid.uuid4());f.register(s,p,'fixture-'+p,str(uuid.uuid4()),'/private/fixture.sock','a'*43,{'version':'0.3.0','buildId':'fixture','profileId':p});\n`;
  await executeFile(process.env.VIDS_STUDIO_PYTHON || (process.platform==='win32'?'python':'python3'),['-c',script,join(root,'native'),directory],{timeout:10000});
  const m=await fixture(t,fleet);const response=await m.api('/api/snapshot');const data=await response.json();assert.equal(response.status,200);assert.deepEqual(data.sessions.map(s=>s.profileId).sort(),['claude','codex']);assert.ok(!JSON.stringify(data).includes('/private/fixture.sock'));
  const changed=await m.api('/api/policy',{method:'POST',headers:{Origin:m.origin,'Content-Type':'application/json'},body:JSON.stringify({maxConcurrency:50})});assert.equal(changed.status,200);assert.equal((await fleet('snapshot')).policy.maxConcurrency,50);
});
