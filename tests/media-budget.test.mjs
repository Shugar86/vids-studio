import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, readFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {withMediaBudget} from '../server/media-budget.mjs';
import {createFleetCLI} from '../server/fleet-dashboard.mjs';

const execute=promisify(execFile),root=resolve(import.meta.dirname,'..');
async function fixture(t){
  const temporary=await mkdtemp(join(tmpdir(),'vids-media-permit-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
  const directory=join(temporary,'budget'),fleetDirectory=join(temporary,'fleet');
  await createFleetCLI({registryDirectory:fleetDirectory})('policy',{maxConcurrency:1});
  return {temporary,directory,env:{...process.env,VIDS_STUDIO_FLEET_DIR:fleetDirectory,VIDS_STUDIO_MEDIA_BUDGET_DIR:directory}};
}
test('five independent local verifications obey one shared permit and remove normal markers',async t=>{
  const f=await fixture(t);let active=0,maximum=0;const waiting=[];
  const result=await Promise.all(Array.from({length:5},(_,index)=>withMediaBudget({...f,jobId:`fixture-${index}`,waitSeconds:5,onBudgetState:value=>waiting.push(value.state)},async()=>{maximum=Math.max(maximum,++active);await delay(60);active--;return index;})));
  assert.deepEqual(result,[0,1,2,3,4]);assert.equal(maximum,1);assert.ok(waiting.includes('waiting'));assert.equal((await readdir(f.directory)).filter(file=>file.endsWith('.json')).length,0);
});
test('cancellation waits for operation cleanup before releasing local capacity',async t=>{
  const f=await fixture(t),abort=new AbortController();let started,finished=false;const entered=new Promise(resolve=>{started=resolve;});
  const first=withMediaBudget({...f,jobId:'cancelled',signal:abort.signal},async signal=>{started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await delay(100);finished=true;});
  await entered;abort.abort();let acquiredTooSoon=false;
  await withMediaBudget({...f,jobId:'after-cancel'},async()=>{acquiredTooSoon=!finished;});await first;
  assert.equal(acquiredTooSoon,false);assert.equal(finished,true);assert.equal((await readdir(f.directory)).filter(file=>file.endsWith('.json')).length,0);
});
test('waiting cancellation never runs work or leaks a permit',async t=>{
  const f=await fixture(t);let release,entered;const gate=new Promise(resolve=>{release=resolve;});const firstStarted=new Promise(resolve=>{entered=resolve;});
  const first=withMediaBudget({...f,jobId:'held'},async()=>{entered();await gate;});await firstStarted;
  const abort=new AbortController();let ran=false;
  const second=withMediaBudget({...f,jobId:'waiting',signal:abort.signal,onBudgetState:({state})=>{if(state==='waiting')abort.abort();}},async()=>{ran=true;});
  await assert.rejects(second,error=>error.code==='MEDIA_CHECK_CANCELED');assert.equal(ran,false);release();await first;
  assert.equal((await readdir(f.directory)).filter(file=>file.endsWith('.json')).length,0);
});
test('owner process death retains an actionable marker instead of admitting an orphan replacement',async t=>{
  const f=await fixture(t);const moduleUrl=new URL('../server/media-budget.mjs',import.meta.url).href;
  const script=`import {withMediaBudget} from ${JSON.stringify(moduleUrl)}; await withMediaBudget({jobId:'lost-owner'},async()=>{process.stdout.write('acquired\\n');await new Promise(()=>{});});`;
  const owner=spawn(process.execPath,['--input-type=module','-e',script],{env:f.env,stdio:['ignore','pipe','pipe']});const closed=new Promise(resolve=>owner.once('close',resolve));t.after(()=>owner.kill());
  await new Promise((resolve,reject)=>{let data='';owner.stdout.on('data',chunk=>{data+=chunk;if(data.includes('acquired\n'))resolve();});owner.once('error',reject);owner.once('exit',code=>reject(new Error(`Owner exited ${code}`)));});
  owner.kill('SIGKILL');await closed;await delay(150);
  await assert.rejects(withMediaBudget({...f,jobId:'replacement',waitSeconds:2},async()=>assert.fail('Unconfirmed old media must prevent admission')),error=>error.code==='MEDIA_PERMIT_UNCONFIRMED');
  const marker=JSON.parse(await readFile(join(f.directory,'slot-0.json'),'utf8'));assert.equal(marker.jobId,'lost-owner');
  const result=await execute(f.env.VIDS_STUDIO_PYTHON || (process.platform==='win32'?'python':'python3'),[join(root,'native/media_budget.py'),'status','--directory',f.directory],{env:f.env});assert.equal(JSON.parse(result.stdout).result.slots[0].leaseId,marker.leaseId);
});
