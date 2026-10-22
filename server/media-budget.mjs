import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {jobError} from './jobs-store.mjs';

const helper = fileURLToPath(new URL('../native/media_budget.py', import.meta.url));
const aborted = () => jobError('MEDIA_CHECK_CANCELED', 'Local media verification was stopped; the source download is unchanged.');

// The keeper retains a durable marker after pipe/process loss. Releasing is
// permitted only after operation() has waited for its media children to exit.
export async function withMediaBudget({jobId, signal, onBudgetState = () => {}, directory, waitSeconds = 600, env = process.env}, operation) {
  if (signal?.aborted) throw aborted();
  const args = [helper, 'acquire', '--wait-seconds', String(waitSeconds)];
  if (directory) args.push('--directory', directory);
  const child = spawn(env.VIDS_STUDIO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), args, {env, stdio:['pipe','pipe','ignore'], windowsHide:true});
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, {once:true});
  let input = '', permit, lost = false, finished = false, resolveAcquire, rejectAcquire, resolveRelease;
  const acquisition = new Promise((resolve,reject)=>{resolveAcquire=resolve;rejectAcquire=reject;});
  const released = new Promise(resolve=>{resolveRelease=resolve;});
  const closed = new Promise(resolve=>child.once('close',resolve));
  const fail = code => {
    if (finished) return;
    lost = true; controller.abort();
    rejectAcquire(jobError(code || 'MEDIA_BUDGET_LOST', 'Local verification admission lost its keeper. The permit is retained until the old media work is explicitly checked.'));
    resolveRelease(false);
  };
  child.on('error',()=>fail('MEDIA_BUDGET_UNAVAILABLE'));
  child.stdin.on('error',()=>fail());
  child.on('close',()=>{if(!finished)fail();});
  child.stdout.on('data',chunk=>{
    input += chunk;
    if(Buffer.byteLength(input)>16384){fail();child.stdin.destroy();return;}
    let end;
    while((end=input.indexOf('\n'))>=0){
      let message;
      try{message=JSON.parse(input.slice(0,end));}catch{fail();return;}
      input=input.slice(end+1);
      if(message.event==='waiting'){try{onBudgetState({state:'waiting',reason:message.reason,effectiveSlots:message.effectiveSlots});}catch{controller.abort();}}
      else if(message.event==='acquired' && typeof message.leaseId==='string' && !permit){permit=message;resolveAcquire(message);}
      else if(message.event==='released'){finished=true;resolveRelease(true);}
      else if(message.event==='error'){rejectAcquire(jobError(message.code || 'MEDIA_BUDGET_UNAVAILABLE',message.message || 'Local verification admission is unavailable.'));fail(message.code);}
      else {fail();return;}
    }
  });
  // Aborting before admission tells the keeper not to create a new permit.
  const interruptWait = () => {if(!permit){child.stdin.end('{"action":"cancel"}\n');rejectAcquire(aborted());}};
  controller.signal.addEventListener('abort',interruptWait,{once:true});
  child.stdin.write(JSON.stringify({jobId,ownerPid:process.pid})+'\n');
  let result, operationError;
  try {
    await acquisition;
    if(controller.signal.aborted)throw aborted();
    onBudgetState({state:'acquired',effectiveSlots:permit.effectiveSlots});
    result=await operation(controller.signal);
  } catch(error) {operationError=error;}
  finally {
    controller.signal.removeEventListener('abort',interruptWait);
    signal?.removeEventListener('abort',cancel);
    if(permit && !lost && !finished){
      // operation has settled, including confirmed child exit on cancellation.
      child.stdin.end(JSON.stringify({action:'release',leaseId:permit.leaseId})+'\n');
      let timer;
      const confirmed=await Promise.race([released,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);
      clearTimeout(timer);
      if(!confirmed){lost=true;child.stdin.destroy();child.kill();}
    } else {child.stdin.destroy();child.kill();}
    await closed;
  }
  if(lost && !operationError)throw jobError('MEDIA_BUDGET_LOST','Local verification completed but permit release was not confirmed; inspect local media permit status.');
  if(operationError)throw operationError;
  return result;
}
