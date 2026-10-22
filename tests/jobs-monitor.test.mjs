import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,readFile,access,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {JobStore} from '../server/jobs-store.mjs';
import {readMonitoredJobs} from '../server/jobs-monitor.mjs';

test('monitor reads both job stores without mutation, media paths or secret hashes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vids-jobs-monitor-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const files=[];
  for(const profile of ['codex','claude']){
    const store=new JobStore(join(directory,profile));
    store.create({schemaVersion:1,id:randomUUID(),profileId:profile,documentId:`fixture-${profile}`,sessionId:'fixture-session',intentId:randomUUID(),state:'waiting',stage:'waiting_for_correlated_download',updatedAt:new Date().toISOString(),runner:{kind:'detached',lastSeen:new Date().toISOString()},ownerHash:'PRIVATE-HASH',leaseHash:'PRIVATE-LEASE',automaticDownload:{source:'PRIVATE-DETAIL'},result:{path:'/PRIVATE-MEDIA.mp4'}});
    store.close();files.push(join(directory,profile,'jobs.sqlite'));
  }
  const before=await Promise.all(files.map(file=>readFile(file)));const result=await readMonitoredJobs(directory);const after=await Promise.all(files.map(file=>readFile(file)));
  assert.equal(result.status,'available');assert.equal(result.records.length,2);assert.equal(result.records[0].state,'waiting');assert.equal(result.records[0].runnerFresh,true);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  assert.deepEqual(before,after);
});

test('stale runner is unconfirmed; terminal success requires its saved outcome and file evidence',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vids-jobs-stages-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=new JobStore(join(directory,'codex'));
  for(const [state,document] of [['running','stale'],['succeeded','done'],['cancelled','cancelled']])store.create({id:randomUUID(),profileId:'codex',documentId:document,intentId:randomUUID(),state,stage:state==='succeeded'?'verified_file':'verifying_local_file',updatedAt:new Date().toISOString(),runner:{kind:'detached',lastSeen:new Date(Date.now()-60000).toISOString()},result:state==='succeeded'?{path:'/private/result.mp4',verification:{container:'verified',decode:'verified'}}:null});store.close();
  const records=(await readMonitoredJobs(directory)).records;assert.equal(records.find(job=>job.documentId==='stale').state,'needs_reconciliation');assert.equal(records.find(job=>job.documentId==='stale').stage,'runner_unconfirmed');assert.equal(records.find(job=>job.documentId==='done').hasVerifiedFile,true);assert.equal(records.find(job=>job.documentId==='cancelled').state,'cancelled');
});

test('missing job stores are not created and unsafe stores are shown unavailable',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vids-jobs-readonly-'));t.after(()=>rm(directory,{recursive:true,force:true}));const absent=join(directory,'absent');assert.equal((await readMonitoredJobs(absent)).records.length,0);await assert.rejects(access(absent));
  if(process.platform!=='win32'){const store=new JobStore(join(directory,'codex'));store.close();await chmod(join(directory,'codex','jobs.sqlite'),0o644);const result=await readMonitoredJobs(directory);assert.equal(result.status,'partial');assert.deepEqual(result.profiles.find(item=>item.profileId==='codex'),{profileId:'codex',status:'unavailable'});}
});
