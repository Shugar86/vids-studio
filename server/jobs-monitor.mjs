// Read-only metadata for the private local monitor; no job capability, media
// path, recovery action, pruning or store initialization is exposed here.
import {DatabaseSync} from 'node:sqlite';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {privateDirectory} from './jobs-store.mjs';
import {windowsFileCheck} from './platform-files.mjs';

const TERMINAL = new Set(['succeeded','failed','cancelled']);
const text = (value,max=256)=>typeof value==='string'?value.slice(0,max):null;
export function monitorJob(job, now=Date.now()) {
  if(!job || typeof job!=='object' || !['codex','claude'].includes(job.profileId) || typeof job.id!=='string') throw new Error('INVALID_JOB_METADATA');
  const seen=Date.parse(job.runner?.lastSeen), fresh=job.runner?.kind==='detached' && Number.isFinite(seen) && now-seen>=-5000 && now-seen<20000;
  return {jobId:text(job.id,128),profileId:job.profileId,documentId:text(job.documentId,256),sessionId:text(job.sessionId,128),
    state:!TERMINAL.has(job.state)&&!fresh?'needs_reconciliation':text(job.state,80),reportedState:text(job.state,80),
    stage:!TERMINAL.has(job.state)&&!fresh?'runner_unconfirmed':text(job.stage,100),updatedAt:text(job.updatedAt,64),
    runnerFresh:fresh,cancelRequested:job.cancelRequested===true,issueCode:text(job.issue?.code,100),
    hasVerifiedFile:job.result?.verification?.container==='verified'&&job.result?.verification?.decode==='verified'};
}

export async function readMonitoredJobs(directory,{now=Date.now()}={}) {
  const result={status:'available',profiles:[],records:[]};
  for(const profile of ['codex','claude']){
    const folder=join(directory,profile),file=join(folder,'jobs.sqlite');let database;
    try{
      const before=await lstat(file);
      privateDirectory(folder);
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1 || (process.platform!=='win32'&&(before.uid!==process.getuid()||(before.mode&0o777)!==0o600)))throw new Error('UNSAFE_JOB_STORE');
      if(process.platform==='win32')windowsFileCheck('verify-file',file);
      database=new DatabaseSync(file,{readOnly:true});
      const after=await lstat(file);if(after.dev!==before.dev||after.ino!==before.ino)throw new Error('JOB_STORE_CHANGED');
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;');
      const rows=database.prepare("SELECT CASE WHEN length(body)<=65536 THEN body ELSE NULL END AS body FROM jobs ORDER BY CASE WHEN state IN ('succeeded','failed','cancelled') THEN 1 ELSE 0 END,updated DESC LIMIT 100").iterate();
      let bytes=0;
      for(const row of rows){if(typeof row.body!=='string')throw new Error('JOB_METADATA_LIMIT');bytes+=Buffer.byteLength(row.body);if(bytes>4*1024*1024)throw new Error('JOB_METADATA_LIMIT');const job=JSON.parse(row.body);if(job.profileId!==profile)throw new Error('JOB_PROFILE_MISMATCH');result.records.push(monitorJob(job,now));}
      result.profiles.push({profileId:profile,status:'available'});
    }catch(error){
      const status=error.code==='ENOENT'?'empty':'unavailable';result.profiles.push({profileId:profile,status});
      if(status==='unavailable'){result.status='partial';result.records=result.records.filter(job=>job.profileId!==profile);}
    }finally{database?.close();}
  }
  return result;
}
