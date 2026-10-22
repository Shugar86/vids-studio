// Isolated end-to-end fixture. Chrome Native Messaging's pipe connection is the
// only adapter: the extension, native hosts, coordinator and MCP server are real.
import {spawn} from 'node:child_process';
import {mkdtemp, chmod, rm, stat} from 'node:fs/promises';
import {tmpdir, endianness} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {launchFleetFixture} from '../extension/fleet-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const littleEndian = endianness() === 'LE';
const isAlive = child => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
const frame = message => {
  const data = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  littleEndian ? header.writeUInt32LE(data.length) : header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
};

export async function launchFullChainFixture({count = 10, connectClients = true} = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'vids-chain-'));
  await chmod(temporary, 0o700);
  const env = {...process.env, PYTHONUNBUFFERED:'1',
    VIDS_STUDIO_SOCKET:join(temporary,'bridge.sock'),
    VIDS_STUDIO_FLEET_DIR:join(temporary,'fleet'),
    VIDS_STUDIO_REGISTRY_DIR:join(temporary,'coordinator')};
  const nativeProcesses = [], clients = [], ports = new Map(), failures = [];
  let browserFixture, pump, stopping = false, closing = false, closed = false;
  const check = () => { if (failures.length) throw failures[0]; };
  const fail = error => { if (!closing) failures.push(error); };
  async function close() {
    if (closed) return;
    closed = true; closing = true;
    await Promise.allSettled(clients.map(client => client.close()));
    await browserFixture?.releaseCapture().catch(()=>{});
    // EOF is the real native-host teardown; no user process is enumerated/killed.
    for (const entry of ports.values()) entry.child.stdin.end();
    await Promise.all([...ports.values()].map(async entry => {
      await Promise.race([entry.exited, delay(2000, undefined, {ref:false})]);
      if (isAlive(entry.child)) entry.child.kill('SIGTERM');
      await Promise.race([entry.exited, delay(1000, undefined, {ref:false})]);
      if (isAlive(entry.child)) { entry.child.kill('SIGKILL'); await entry.exited; }
    }));
    stopping = true; await pump;
    await Promise.allSettled([...ports.values()].map(entry => entry.delivery));
    await browserFixture?.close();
    await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
  function startPort(port) {
    const hello = port.messages[0];
    if (!hello || hello.type !== 'hello' || !hello.fleet) throw new Error('Fleet port must begin with its own hello');
    const python = env.VIDS_STUDIO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const child = spawn(python,[join(root,'native/bridge.py')],{cwd:root,env,stdio:['pipe','pipe','pipe']});
    const entry = {id:port.id,sessionId:hello.status.sessionId,child,delivery:Promise.resolve(),stderr:'',incoming:Buffer.alloc(0)};
    // 'close' also fires when spawning fails; 'exit' does not.
    entry.exited = new Promise(resolve => child.once('close',(code,signal)=>{
      if (!closing && !entry.ended) fail(new Error(`Native fixture host exited (${code ?? signal}): ${entry.stderr}`));
      resolve();
    }));
    entry.started = new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
    child.once('error',fail);
    child.stdin.on('error',error=>{if(!entry.ended)fail(error)});
    child.stderr.on('data',data=>{entry.stderr=(entry.stderr+data).slice(-4000)});
    child.stdout.on('data',data=>{
      try {
        entry.incoming=Buffer.concat([entry.incoming,data]);
        while(entry.incoming.length>=4){
          const length=littleEndian?entry.incoming.readUInt32LE():entry.incoming.readUInt32BE();
          if(length<1||length>64*1024*1024)throw new Error('Invalid native fixture frame length');
          if(entry.incoming.length<length+4)break;
          const message=JSON.parse(entry.incoming.subarray(4,length+4).toString());
          entry.incoming=entry.incoming.subarray(length+4);
          entry.delivery=entry.delivery.then(()=>browserFixture.deliver(port.id,message)).catch(fail);
        }
      } catch(error) { fail(error); }
    });
    ports.set(port.id,entry);nativeProcesses.push(child);return entry;
  }
  async function transfer() {
    for(const port of await browserFixture.drain()) {
      const entry=ports.get(port.id)??(port.messages.length?startPort(port):null);
      if(!entry)continue;
      await entry.started;
      for(const message of port.messages){
        if(entry.ended)throw new Error('Extension sent after native port closure');
        await new Promise((resolve,reject)=>entry.child.stdin.write(frame(message),error=>error?reject(error):resolve()));
      }
      if(port.closed&&!entry.ended){entry.ended=true;entry.child.stdin.end();}
    }
  }
  async function connectClient(index) {
    check();
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('Invalid fixture client index');
    const client=new Client({name:`fleet-fixture-${index}`,version:'1.0.0'});
    clients.push(client);
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'server/index.mjs')],env,stderr:'pipe'}));
    return client;
  }
  try {
    browserFixture=await launchFleetFixture({count});
    await transfer();
    pump=(async()=>{
      while(!stopping){try{await transfer()}catch(error){fail(error);break}await delay(8);}
    })();
    for(let attempt=0;attempt<200;attempt++){
      check();
      const ready=await Promise.all(browserFixture.sessions.map(async session=>{
        try{return (await stat(join(temporary,'sessions',`${session.sessionId}.${process.platform==='win32'?'json':'sock'}`))).size>=0}catch{return false}
      }));
      if(ready.every(Boolean))break;
      if(attempt===199)throw new Error('Native fleet endpoints did not become ready');
      await delay(25);
    }
    if(connectClients){
      const connected=await Promise.allSettled(Array.from({length:count},(_,i)=>connectClient(i)));
      const failure=connected.find(result=>result.status==='rejected');
      if(failure)throw failure.reason;
    }
    check();
    return {env,sessions:browserFixture.sessions,attached:browserFixture.attached,browserFixture,
      nativeProcesses,clients,connectClient,check,close};
  }catch(error){await close();throw error;}
}
