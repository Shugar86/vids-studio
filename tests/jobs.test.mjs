import assert from 'node:assert/strict';
import {test, before, after} from 'node:test';
import {mkdtemp, mkdir, rm, lstat, readFile, writeFile, symlink} from 'node:fs/promises';
import {join, resolve, delimiter} from 'node:path';
import {accessSync, constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID, randomBytes} from 'node:crypto';
import {ExportJobs} from '../server/jobs.mjs';
import {verifyExport} from '../server/jobs-media.mjs';
import {JobStore} from '../server/jobs-store.mjs';
let temporary, source;
const priorMediaEnvironment = Object.fromEntries(['VIDS_STUDIO_MEDIA_BUDGET_DIR','VIDS_STUDIO_FLEET_DIR','VIDS_STUDIO_PYTHON'].map(key=>[key,process.env[key]]));
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'vids-jobs-test-')); source = join(temporary, 'source.mp4');
  process.env.VIDS_STUDIO_MEDIA_BUDGET_DIR = join(temporary,'media-budget');
  process.env.VIDS_STUDIO_FLEET_DIR = join(temporary,'fleet');
  const python = spawnSync(process.env.VIDS_STUDIO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c','import sys; print(sys.executable)'], {encoding:'utf8'});
  assert.equal(python.status,0); process.env.VIDS_STUDIO_PYTHON = python.stdout.trim();
  const render = spawnSync('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=64x48:r=5:d=0.4','-an','-threads','1','-c:v','libx264','-pix_fmt','yuv420p',source]);
  assert.equal(render.status,0,render.stderr?.toString());
});
after(async () => { for(const [key,value] of Object.entries(priorMediaEnvironment)) { if(value===undefined)delete process.env[key];else process.env[key]=value; } await rm(temporary,{recursive:true,force:true}); });
const token='x'.repeat(43);
async function fixture(t, overrides={}) {
  const directory=await mkdtemp(join(temporary,'store-')); let now=Date.now(); let menu=0;let snapshot=0;let lastSnapshot;const calls=[];
  const profile={id:'codex'};
  const bridge=async (method,args) => {
    calls.push({method,args});
    const supplied=await overrides.bridge?.(method,args,{calls}); if(supplied) return supplied;
    if(method==='status')return {ok:true,result:{attached:true,sessionId:'session-a',documentId:'document-a',control:{mode:'write'},capabilities:['export_trigger','export_download_status']}};
    if(method==='renew_control')return {ok:true,result:{}};
    if(method==='release_control')return {ok:true,result:{released:true}};
    if(method==='observe'){lastSnapshot=`snapshot-${++snapshot}`;return {ok:true,result:{snapshotId:lastSnapshot,nodes:[{ref:`node-${snapshot}`,role:'menuitem',name:['File','Download d ►','MP4 video (.mp4) d'][menu]}]}};}
    if(method==='click'||method==='export_trigger'){assert.equal(args.snapshotId,lastSnapshot);assert.equal(args.nodeRef,`node-${snapshot}`);menu++;return {ok:true,result:{performed:true}};}
    if(method==='export_download_status')return {ok:true,result:{jobId:args.jobId,sessionId:'session-a',documentId:'document-a',frameId:'frame-a',state:'completed',guid:'guid-a',downloadId:7,filename:source}};
    throw Error(method);
  };
  const jobs=new ExportJobs({directory,bridgeRequest:bridge,profile,now:()=>now,wait:async ms=>{now+=ms;},...(overrides.verify?{verify:overrides.verify}:{})});
  t.after(async()=>{await jobs.drain();jobs.close();});
  const args={jobId:randomUUID(),jobToken:randomBytes(32).toString('base64url'),kind:'export_mp4',intentId:randomUUID(),documentId:'document-a',sessionId:'session-a',controlToken:token,automaticDownload:{confirmed:true,checkedAt:new Date(now).toISOString(),source:'Operator checked this temporary profile'}};
  return {jobs,args,calls,directory,advance:ms=>{now+=ms;}};
}
test('typed export uses fresh observed menu targets, releases control, and verifies the correlated actual MP4',async t=>{
  const f=await fixture(t);const started=await f.jobs.start(f.args);await f.jobs.drain();
  const status=f.jobs.status({jobId:started.id,jobToken:started.jobToken});assert.equal(status.state,'succeeded');
  const actions=f.calls.filter(c=>['click','export_trigger'].includes(c.method));assert.equal(actions.length,3);assert.equal(new Set(actions.map(c=>c.args.snapshotId)).size,3);
  assert.equal(status.receipts.length,3);assert.equal(status.result.width,64);assert.equal(status.result.height,48);assert.equal(status.result.sha256.length,64);
  assert.equal(status.result.verification.sound,'not_checked');assert.deepEqual(status.result.streams.map(s=>s.type),['video']);
  assert.ok(status.evidence.some(e=>e.kind==='control_released'));assert.equal(status.result.provenance.downloadId,7);
  assert.equal('jobToken' in status,false);assert.equal('ownerHash' in status,false);
  assert.equal((await lstat(join(f.directory,'jobs.sqlite'))).mode&0o777,0o600);
  assert.equal((await lstat(status.result.path)).mode&0o777,0o600);
  const database=await readFile(join(f.directory,'jobs.sqlite'));assert.equal(database.includes(Buffer.from(token)),false);assert.equal(database.includes(Buffer.from(started.jobToken)),false);
});
test('no automatic-download attestation means no browser call or job',async t=>{
  const f=await fixture(t);delete f.args.automaticDownload;await assert.rejects(f.jobs.start(f.args),e=>e.code==='AUTO_DOWNLOAD_PRECONDITION');assert.equal(f.calls.length,0);
});
test('stale attestation and reconciliation control cannot trigger an export',async t=>{
  const f=await fixture(t,{bridge:async method=>method==='status'?{ok:true,result:{attached:true,sessionId:'session-a',documentId:'document-a',control:{mode:'reconcile'}}}:null});
  await assert.rejects(f.jobs.start(f.args),e=>e.code==='CONTROL_RECONCILIATION_REQUIRED');
  f.advance(900001);await assert.rejects(f.jobs.start(f.args),e=>e.code==='AUTO_DOWNLOAD_PRECONDITION');assert.equal(f.calls.filter(c=>c.method==='click').length,0);
});
test('foreign job capability cannot inspect, cancel or retrieve owner result',async t=>{
  const f=await fixture(t);const start=await f.jobs.start(f.args);const bad={jobId:start.id,jobToken:'wrong'.repeat(10)};
  for(const method of ['status','result','cancel'])assert.throws(()=>f.jobs[method](bad),e=>e.code==='JOB_NOT_FOUND');await f.jobs.drain();
});
test('same document and intent cannot launch duplicate exports',async t=>{
  const f=await fixture(t);await f.jobs.start(f.args);await assert.rejects(f.jobs.start({...f.args,jobId:randomUUID(),intentId:randomUUID()}),e=>e.code==='JOB_ALREADY_EXISTS');await f.jobs.drain();assert.equal((await f.jobs.start(f.args)).state,'succeeded');assert.equal(f.calls.filter(c=>c.method==='export_trigger').length,1);
});
test('unknown trigger is not retried and later evidence does not rewrite its receipt',async t=>{
  const f=await fixture(t,{bridge:async method=>method==='export_trigger'?{ok:false,error:{code:'TIMEOUT',outcome:'unknown'}}:null});
  const start=await f.jobs.start(f.args);await f.jobs.drain();const job=f.jobs.status({jobId:start.id,jobToken:start.jobToken});
  assert.equal(job.state,'succeeded');assert.equal(job.receipts.at(-1).outcome,'unknown');assert.ok(job.evidence.some(e=>e.kind==='correlated_download'));assert.equal(f.calls.filter(c=>c.method==='export_trigger').length,1);
});
test('unknown menu mutation stops before export and is not retried',async t=>{
  const f=await fixture(t,{bridge:async method=>method==='click'?{ok:false,error:{code:'TIMEOUT',outcome:'unknown'}}:null});const start=await f.jobs.start(f.args);await f.jobs.drain();
  assert.equal(f.jobs.status({jobId:start.id,jobToken:start.jobToken}).state,'needs_reconciliation');assert.equal(f.calls.filter(c=>c.method==='click').length,1);assert.equal(f.calls.filter(c=>c.method==='export_trigger').length,0);
});
test('another or restarted MCP instance never resumes a persisted running job',async t=>{
  let unblock;const blocked=new Promise(r=>{unblock=r;});let reached;const startedRunning=new Promise(r=>{reached=r;});
  const f=await fixture(t,{bridge:async method=>{if(method==='observe'){reached();await blocked;}return null;}});const start=await f.jobs.start(f.args);await startedRunning;
  const other=new ExportJobs({directory:f.directory,bridgeRequest:async()=>{throw Error('must not replay');},profile:{id:'codex'}});t.after(()=>other.close());
  const status=other.status({jobId:start.id,jobToken:start.jobToken});assert.equal(status.state,'needs_reconciliation');assert.equal(status.issue.code,'JOB_RUNNER_UNAVAILABLE');unblock();await f.jobs.drain();assert.equal(other.status({jobId:start.id,jobToken:start.jobToken}).state,'succeeded');
});
test('queued cancel sends no menu or export mutation',async t=>{
  const f=await fixture(t);const start=await f.jobs.start(f.args);f.jobs.cancel({jobId:start.id,jobToken:start.jobToken});await f.jobs.drain();
  assert.equal(f.jobs.status({jobId:start.id,jobToken:start.jobToken}).state,'cancelled');assert.equal(f.calls.filter(c=>['click','export_trigger'].includes(c.method)).length,0);
});
test('cancel after trigger waits for outcome and does not claim Google cancellation',async t=>{
  let service,credentials;const f=await fixture(t,{bridge:async method=>{if(method==='export_download_status')service.cancel(credentials);return null;},verify:async()=>{throw Error('canceled job must not verify');}});
  service=f.jobs;const start=await f.jobs.start(f.args);credentials={jobId:start.id,jobToken:start.jobToken};await f.jobs.drain();const job=service.status(credentials);assert.equal(job.state,'cancelled');assert.equal(job.cancellation,'further_steps_stopped_google_export_not_canceled');assert.equal(f.calls.filter(c=>c.method==='export_trigger').length,1);
});
test('ambiguous download is not accepted and bounded status does not click again',async t=>{
  const f=await fixture(t,{bridge:async(method,args)=>method==='export_download_status'?{ok:true,result:{jobId:args.jobId,sessionId:'session-a',documentId:'document-a',state:'needs_reconciliation',code:'AMBIGUOUS_DOWNLOAD_ID'}}:null});const start=await f.jobs.start(f.args);await f.jobs.drain();const job=f.jobs.status({jobId:start.id,jobToken:start.jobToken});assert.equal(job.state,'needs_reconciliation');assert.equal(job.issue.code,'AMBIGUOUS_DOWNLOAD_ID');assert.equal(f.calls.filter(c=>c.method==='export_trigger').length,1);
});
test('media verification rejects a symlink and a fake MP4 instead of returning success',async()=>{
  const out=await mkdtemp(join(temporary,'media-'));const linked=join(out,'link.mp4');await symlink(source,linked);
  await assert.rejects(verifyExport({source:linked,outputDirectory:out,jobId:randomUUID()}));
  const invalid=join(out,'fake.mp4');await writeFile(invalid,'not a movie');await assert.rejects(verifyExport({source:invalid,outputDirectory:out,jobId:randomUUID()}),e=>e.code==='MEDIA_CHECK_FAILED');
});
test('private store rejects shared permissions and database symlinks',async()=>{
  const shared=join(temporary,'shared');await mkdir(shared,{mode:0o755});assert.throws(()=>new JobStore(shared),e=>e.code==='UNSAFE_JOB_STORE');
  const privateDir=await mkdtemp(join(temporary,'linked-db-'));await symlink(source,join(privateDir,'jobs.sqlite'));assert.throws(()=>new JobStore(privateDir),e=>e.code==='UNSAFE_JOB_STORE');
});

test('queued cancellation releases its explicitly supplied writer lease',async t=>{
  const f=await fixture(t);const job=await f.jobs.start(f.args);f.jobs.cancel({jobId:job.id,jobToken:job.jobToken});await f.jobs.drain();
  assert.deepEqual(f.calls.filter(c=>c.method==='release_control').map(c=>c.args),[{sessionId:f.args.sessionId,controlToken:token}]);
});
test('cancel from another process atomically preserves the latest stage and evidence',async t=>{
  const f=await fixture(t);const job=await f.jobs.start(f.args);const other=new JobStore(f.directory);t.after(()=>other.close());
  const current=f.jobs.store.get(job.id);current.stage='newer_stage';current.evidence.push({kind:'newer_evidence'});f.jobs.store.save(current);
  other.requestCancel(job.id,job.jobToken);const actual=f.jobs.store.get(job.id);assert.equal(actual.stage,'newer_stage');assert.equal(actual.evidence.at(-1).kind,'newer_evidence');assert.equal(actual.cancelRequested,true);
});
test('cancellation accepted during local verification is explicit and retains finished evidence',async t=>{
  let entered,finish;const reached=new Promise(r=>{entered=r;});const held=new Promise(r=>{finish=r;});
  const f=await fixture(t,{verify:async()=>{entered();await held;return {path:'/fixture/verified.mp4',sha256:'a'.repeat(64)};}});
  const job=await f.jobs.start(f.args);await reached;assert.equal(f.calls.at(-1).method,'release_control');f.jobs.cancel({jobId:job.id,jobToken:job.jobToken});finish();await f.jobs.drain();
  const actual=f.jobs.status({jobId:job.id,jobToken:job.jobToken});assert.equal(actual.state,'cancelled');assert.equal(actual.stage,'verification_finished_after_cancel');assert.equal(actual.result.sha256,'a'.repeat(64));assert.ok(actual.evidence.some(e=>e.kind==='local_file_verified'));
});
async function recoveryFixture(t,{downloadLost=false}={}) {
  let recovering=false;
  const f=await fixture(t,{bridge:async(method,args)=>{
    if(method==='export_trigger')return {ok:false,error:{code:'TIMEOUT',outcome:'unknown'}};
    if(method==='export_download_status'&&(!recovering||downloadLost))return {ok:false,error:{code:'EXPORT_WATCH_NOT_FOUND'}};
    return null;
  }});
  const started=await f.jobs.start(f.args);await f.jobs.drain();recovering=true;
  return {...f,started,access:{jobId:started.id,jobToken:started.jobToken},auth:{sessionId:f.args.sessionId,controlToken:'r'.repeat(43)}};
}
test('owner recovery observes a surviving completed watch, releases its lease, and never replays',async t=>{
  const f=await recoveryFixture(t);const before=f.jobs.status(f.access);assert.equal(before.state,'needs_reconciliation');
  const recovered=await f.jobs.status({...f.access,inspectDownload:f.auth});assert.equal(recovered.state,'succeeded');assert.equal(recovered.receipts.at(-1).outcome,'unknown');assert.ok(recovered.evidence.some(e=>e.kind==='recovery_observation'));
  assert.equal(f.calls.filter(c=>c.method==='export_trigger').length,1);assert.equal(f.calls.filter(c=>c.method==='release_control').length,1);
});
test('lost watcher remains unresolved; explicit checked acknowledgement frees only a new intent',async t=>{
  const f=await recoveryFixture(t,{downloadLost:true});const observed=await f.jobs.status({...f.access,inspectDownload:f.auth});assert.equal(observed.state,'needs_reconciliation');assert.ok(observed.evidence.some(e=>e.kind==='recovery_observation_failed'));
  const abandoned=await f.jobs.cancel({...f.access,acknowledgeUnknown:{...f.auth,controlToken:'s'.repeat(43),evidence:'Inspected current document and known downloads; the old export outcome remains unknown.'}});
  assert.equal(abandoned.state,'cancelled');assert.equal(abandoned.cancellation,'intent_abandoned_external_export_outcome_still_unknown');assert.equal(abandoned.receipts.at(-1).outcome,'unknown');
  assert.equal((await f.jobs.start(f.args)).state,'cancelled');const newJob=await f.jobs.start({...f.args,jobId:randomUUID(),intentId:randomUUID()});f.jobs.cancel({jobId:newJob.id,jobToken:newJob.jobToken});await f.jobs.drain();assert.equal(f.calls.filter(c=>c.method==='export_trigger').length,1);
});
test('recovery rejects wrong capability, original session, document, and unreconciled writer lease',async t=>{
  const f=await recoveryFixture(t,{downloadLost:true});
  assert.throws(()=>f.jobs.status({...f.access,jobToken:'wrong'.repeat(10),inspectDownload:f.auth}),e=>e.code==='JOB_NOT_FOUND');
  await assert.rejects(f.jobs.status({...f.access,inspectDownload:{...f.auth,sessionId:'other'}}),e=>e.code==='DOCUMENT_CHANGED');
  const original=f.jobs.bridge;
  for(const result of [{attached:true,sessionId:'session-a',documentId:'other-document',control:{mode:'write'}},{attached:true,sessionId:'session-a',documentId:'document-a',control:{mode:'reconcile'}}]){
    f.jobs.bridge=async(method,args)=>method==='status'?{ok:true,result}:original(method,args);
    await assert.rejects(f.jobs.cancel({...f.access,acknowledgeUnknown:{...f.auth,evidence:'Checked the current document and existing output.'}}),e=>['DOCUMENT_CHANGED','CONTROL_RECONCILIATION_REQUIRED'].includes(e.code));
  }
  f.jobs.bridge=async(method,args)=>method==='renew_control'?{ok:false,error:{code:'CONTROL_TOKEN_INVALID'}}:original(method,args);
  await assert.rejects(f.jobs.status({...f.access,inspectDownload:{...f.auth,controlToken:'wrong'.repeat(10)}}),e=>e.code==='CONTROL_TOKEN_INVALID');
  assert.equal(f.jobs.status(f.access).state,'needs_reconciliation');assert.equal(f.calls.filter(c=>c.method==='export_trigger').length,1);
});
test('recovery fencing stops a stale runner before its next browser mutation',async t=>{
  let resume,entered;const waiting=new Promise(r=>{entered=r;});const held=new Promise(r=>{resume=r;});
  const f=await fixture(t,{bridge:async method=>{if(method==='observe'){entered();await held;}return null;}});const job=await f.jobs.start(f.args);await waiting;
  const other=new ExportJobs({directory:f.directory,bridgeRequest:f.jobs.bridge,profile:{id:'codex'}});t.after(()=>other.close());
  const ack=await other.cancel({jobId:job.id,jobToken:job.jobToken,acknowledgeUnknown:{sessionId:f.args.sessionId,controlToken:'r'.repeat(43),evidence:'Inspected current writer document; stop the unresolved old intent.'}});assert.equal(ack.state,'cancelled');resume();await f.jobs.drain();
  assert.equal(other.status({jobId:job.id,jobToken:job.jobToken}).state,'cancelled');assert.equal(f.calls.filter(c=>['click','export_trigger'].includes(c.method)).length,0);
});
for (const mode of ['inspect', 'acknowledge']) test(`parallel ${mode} recoveries cannot replace the winner after both validated the same fresh native lease`, async t => {
  const f = await recoveryFixture(t);
  let renewed = 0, allowRenew, enteredStep, allowStep, verificationCalls = 0;
  const renewGate = new Promise(resolve => { allowRenew = resolve; });
  const stepEntered = new Promise(resolve => { enteredStep = resolve; });
  const stepGate = new Promise(resolve => { allowStep = resolve; });
  const steps = [];
  const bridge = async (method, args) => {
    if (method === 'renew_control') {
      if (++renewed === 2) allowRenew();
      await renewGate;
      return {ok: true, result: {}};
    }
    if (method === 'export_download_status' || method === 'release_control') {
      steps.push(method);
      if (method === (mode === 'inspect' ? 'export_download_status' : 'release_control')) {
        enteredStep();
        await stepGate;
      }
    }
    return f.jobs.bridge(method, args);
  };
  const services = [0, 1].map(() => new ExportJobs({directory: f.directory, bridgeRequest: bridge, profile: {id: 'codex'},
    verify: async () => { verificationCalls++; return {sha256: 'a'.repeat(64)}; }}));
  t.after(() => services.forEach(service => service.close()));
  const requests = services.map(service => (mode === 'inspect'
    ? service.status({...f.access, inspectDownload: f.auth})
    : service.cancel({...f.access, acknowledgeUnknown: {...f.auth, evidence: 'Inspected this document and its previous export; abandon only the old intent.'}}))
    .then(value => ({value}), error => ({error})));
  try {
    await stepEntered;
    // The winner is deliberately suspended after its claim. The loser must
    // reject before it can observe a download or release the shared token.
    const loser = await Promise.race(requests);
    assert.equal(loser.error?.code, 'JOB_RECOVERY_CONFLICT');
    assert.equal(steps.length, 1);
  } finally { allowStep(); }
  const outcomes = await Promise.all(requests);
  assert.equal(outcomes.filter(outcome => outcome.error?.code === 'JOB_RECOVERY_CONFLICT').length, 1);
  const winner = outcomes.find(outcome => outcome.value)?.value;
  assert.equal(winner?.state, mode === 'inspect' ? 'succeeded' : 'cancelled');
  assert.equal(winner.receipts.at(-1).outcome, 'unknown');
  assert.equal(f.jobs.store.get(f.access.jobId).runnerEpoch, 1);
  assert.equal(steps.filter(method => method === 'release_control').length, 1);
  assert.equal(verificationCalls, mode === 'inspect' ? 1 : 0);
  assert.equal(f.calls.filter(call => call.method === 'export_trigger').length, 1);
});
test('job metadata registration does not touch a configured unsafe store',async()=>{
  const {registerJobTools}=await import('../server/jobs.mjs');const {z}=await import('zod');const tools=new Map();
  const handle=registerJobTools({registerTool:(name,description,handler)=>tools.set(name,handler)},{z,bridgeRequest:async()=>{throw Error('must not call');},PROFILE:{id:'test'},directory:'/definitely-missing-parent/not-created/unsafe'});
  assert.equal(tools.size,4);handle.close();
});

test('lost start response is recoverable from the caller’s pre-saved ID and capability without replay',async t=>{
  const f=await recoveryFixture(t);const {jobId,jobToken}=f.args;const before=f.calls.length;
  const other=new ExportJobs({directory:f.directory,bridgeRequest:f.jobs.bridge,profile:{id:'codex'}});t.after(()=>other.close());
  assert.equal(other.status({jobId,jobToken}).state,'needs_reconciliation');const repeated=await other.start(f.args);assert.equal(repeated.id,jobId);assert.equal(f.calls.length,before);
  await assert.rejects(other.start({...f.args,intentId:randomUUID()}),e=>e.code==='JOB_INTENT_CONFLICT');
  await assert.rejects(other.start({...f.args,jobToken:'wrong'.repeat(10)}),e=>e.code==='JOB_NOT_FOUND');
  const final=await other.status({jobId,jobToken,inspectDownload:f.auth});assert.equal(final.state,'succeeded');assert.equal(f.calls.filter(c=>c.method==='export_trigger').length,1);
});

test('recovery rejects the old native token before it can acknowledge an unresolved dispatch',async t=>{
  const f=await recoveryFixture(t,{downloadLost:true});const before=f.calls.length;
  await assert.rejects(f.jobs.cancel({...f.access,acknowledgeUnknown:{...f.auth,controlToken:token,evidence:'Checked current document and previously known download state.'}}),e=>e.code==='FRESH_RECOVERY_LEASE_REQUIRED');assert.equal(f.calls.length,before);assert.equal(f.jobs.status(f.access).state,'needs_reconciliation');
});
test('an ok envelope without confirmed lease release never permits local verification',async t=>{
  const f=await fixture(t,{bridge:async method=>method==='release_control'?{ok:true,result:{released:false}}:null,verify:async()=>{throw Error('verification must not run with unconfirmed lease');}});
  const job=await f.jobs.start(f.args);await f.jobs.drain();const status=f.jobs.status({jobId:job.id,jobToken:job.jobToken});assert.equal(status.state,'needs_reconciliation');assert.equal(status.issue.code,'CONTROL_RELEASE_UNCONFIRMED');assert.equal(status.evidence.some(e=>e.kind==='control_released'),false);
});


test('explicit FFmpeg tools verify exports without PATH and do not fall back from a missing configured executable', async () => {
  const variables = ['PATH', 'VIDS_STUDIO_FFMPEG', 'VIDS_STUDIO_FFPROBE'];
  const original = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  const locate = binary => {
    const configured = original[`VIDS_STUDIO_${binary.toUpperCase()}`];
    if (configured) return configured;
    for (const directory of (original.PATH || '').split(delimiter)) {
      const candidate = resolve(directory, binary + (process.platform === 'win32' ? '.exe' : ''));
      try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
    }
    throw new Error(`${binary} is required by the export test fixture`);
  };
  const ffmpeg = locate('ffmpeg'), ffprobe = locate('ffprobe');
  const outputDirectory = await mkdtemp(join(temporary, 'explicit-tools-'));
  try {
    process.env.VIDS_STUDIO_FFMPEG = ffmpeg;
    process.env.VIDS_STUDIO_FFPROBE = ffprobe;
    process.env.PATH = join(temporary, 'no-tools-on-path');
    const result = await verifyExport({source, outputDirectory, jobId: randomUUID()});
    assert.equal(result.verification.container, 'verified');
    assert.equal(result.verification.decode, 'verified');
    process.env.PATH = original.PATH;
    process.env.VIDS_STUDIO_FFPROBE = join(temporary, 'missing-ffprobe');
    await assert.rejects(verifyExport({source, outputDirectory, jobId: randomUUID()}), error => error.code === 'MEDIA_TOOL_UNAVAILABLE');
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
