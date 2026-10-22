#!/usr/bin/env node
// Explicit-document, read-only live acceptance. Never prints owner capabilities.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {writeFile,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {privateDirectory} from '../server/jobs-store.mjs';
import {windowsFileCheck} from '../server/platform-files.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TICKET=/^[0-9a-f]{64}$/i;
const CAPABILITY=/^[A-Za-z0-9_-]{32,128}$/;

export async function readPairingInput(file,{stdin=process.stdin}={}) {
  let bytes;
  if(file==='-'){
    const chunks=[];let length=0;
    for await(const chunk of stdin){const data=Buffer.from(chunk);length+=data.length;if(length>256)throw new Error('Pairing input exceeds 256 bytes.');chunks.push(data)}
    bytes=Buffer.concat(chunks);
  }else{
    if(!path.isAbsolute(file))throw new Error('Pairing file must be an absolute private path.');
    privateDirectory(path.dirname(file));
    const before=await lstat(file);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>256)throw new Error('Pairing file must be a small regular file with one link.');
    if(process.platform==='win32')windowsFileCheck('verify-file',file);
    else if(before.uid!==process.getuid()||(before.mode&0o777)!==0o600)throw new Error('Pairing file must be owned and mode 0600.');
    const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      const opened=await handle.stat();
      if(opened.dev!==before.dev||opened.ino!==before.ino)throw new Error('Pairing file changed identity.');
      const buffer=Buffer.alloc(257);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
      if(bytesRead>256)throw new Error('Pairing input exceeds 256 bytes.');
      bytes=buffer.subarray(0,bytesRead);
      const after=await handle.stat();
      if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('Pairing file changed while reading.');
    }finally{await handle.close()}
  }
  const ticket=bytes.toString('utf8').trim();
  if(!TICKET.test(ticket))throw new Error('Pairing input must contain only the popup code (64 hex characters).');
  return ticket;
}

export async function writeSmokeRecovery(file,binding) {
  if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('A new absolute private recovery path is required.');
  privateDirectory(path.dirname(file));
  if(process.platform==='win32')windowsFileCheck('create-file',file);
  const handle=await open(file,process.platform==='win32'?'r+':'wx',0o600);
  try{await handle.writeFile(JSON.stringify({kind:'vids-read-only-smoke',...binding},null,2)+'\n');await handle.sync()}
  finally{await handle.close()}
  if(process.platform==='win32')windowsFileCheck('verify-file',file);
}

export async function runSmoke(client,{documentId,sessionId,pairingTicket,saveBinding,screenshotPath,write=writeFile,transport}) {
  if(typeof documentId!=='string'||!documentId)throw new Error('An explicit expected document ID is required.');
  if(sessionId!==undefined&&!UUID.test(sessionId))throw new Error('An exact session UUID is required.');
  const fleet=pairingTicket!==undefined;
  if(fleet&&(!sessionId||!TICKET.test(pairingTicket)||typeof saveBinding!=='function'))throw new Error('Fleet smoke requires an exact session, popup code and private recovery writer.');
  if(screenshotPath&&!path.isAbsolute(screenshotPath))throw new Error('Screenshot output must be absolute.');
  let control,binding,claimMayExist=false;
  const evidence={readOnly:true,passed:false,documentMatched:false,stages:[],released:false,bindingReleased:false};
  async function call(method,args={}){
    const response=await client.callTool({name:`vids_${method}`,arguments:args});
    let data;
    try{data=JSON.parse(response.content.find(item=>item.type==='text').text)}
    catch{throw new Error(`${method}: INVALID_RESPONSE`)}
    if(response.isError||data.error||data.ok===false){
      const error=new Error(`${method}: ${data.error?.code||'FAILED'}`);error.outcome=data.error?.outcome;throw error;
    }
    return {response,data};
  }
  try{
    await client.connect(transport??new StdioClientTransport({command:process.execPath,
      args:[fileURLToPath(new URL('../server/index.mjs',import.meta.url))]}));
    evidence.tools=(await client.listTools()).tools.map(tool=>tool.name);
    const target=sessionId?{sessionId}:{};
    const {data:diagnostics}=await call('diagnostics',target);
    evidence.runtime=diagnostics.runtime;
    if(diagnostics.selectionRequired)throw new Error('Fleet acceptance requires the exact session, its popup code and a private recovery file; no tab was selected.');
    if(!diagnostics.compatibility?.ready)throw new Error('Loaded MCP, native host and extension do not match. Reload this profile and refresh the MCP client.');
    const {data:status}=await call('status',target);
    if(!status.connected||!status.attached||status.documentId!==documentId||typeof status.sessionId!=='string'||!status.sessionId||(sessionId&&status.sessionId!==sessionId))throw new Error('The attached document/session differs from the explicit smoke target.');
    if((status.fleet||status.browserInstanceId)&&!fleet)throw new Error('This attachment requires its popup code and a private recovery file; no control was acquired.');
    evidence.documentMatched=true;evidence.stages.push('status');
    if(fleet){
      binding={sessionId,expectedDocumentId:documentId,bindingId:randomUUID(),bindingToken:randomBytes(32).toString('base64url'),
        intentId:randomUUID(),pairingTicket,ownerLabel:'Upgrade read-only acceptance'};
      await saveBinding(binding);evidence.stages.push('recovery_saved');
      claimMayExist=true;
      let claimed;
      try{claimed=(await call('claim_attachment',binding)).data.result;}
      catch(error){if(error.outcome==='not_performed')claimMayExist=false;throw error;}
      if(claimed?.bindingId!==binding.bindingId||claimed.sessionId!==sessionId||claimed.documentId!==documentId)throw new Error('Claim receipt does not match this smoke assignment.');
      evidence.stages.push('claim');
    }
    const acquire={sessionId:status.sessionId,ownerLabel:'Upgrade read-only acceptance',
      ...(binding?{bindingId:binding.bindingId,bindingToken:binding.bindingToken,expectedDocumentId:documentId}:{})};
    const granted=(await call('acquire_control',acquire)).data.result;
    if(granted?.sessionId!==status.sessionId||!CAPABILITY.test(granted?.controlToken||''))throw new Error('Control receipt does not match the observed attached session.');
    control={sessionId:status.sessionId,controlToken:granted.controlToken};evidence.stages.push('acquire');
    const snapshot=(await call('observe',{...control,maxNodes:200})).data.result;
    if(snapshot?.documentId!==documentId||typeof snapshot.snapshotId!=='string'||!snapshot.snapshotId||!Array.isArray(snapshot.nodes))throw new Error('Observation does not identify the expected document and a fresh snapshot.');
    evidence.observation={nodes:snapshot.nodes.length,hasCyrillic:snapshot.nodes.some(node=>/[А-Яа-яЁё]/.test(node.name||''))};evidence.stages.push('observe');
    const {response:screenshot,data:metadata}=await call('screenshot',{...control,format:'png'});
    const frame=screenshot.content.find(item=>item.type==='image');
    if(frame?.mimeType!=='image/png'||typeof frame.data!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)||typeof metadata.snapshotId!=='string'||!metadata.snapshotId||!(metadata.image?.width>0&&metadata.image?.height>0))throw new Error('No standard MCP PNG ImageContent with snapshot metadata returned.');
    const bytes=Buffer.from(frame.data,'base64');
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Screenshot content is not a PNG.');
    evidence.screenshot={mimeType:frame.mimeType,bytes:bytes.length};
    if(screenshotPath)await write(screenshotPath,bytes,{flag:'wx',mode:0o600});
    evidence.stages.push('screenshot');
  }catch(error){evidence.error=String(error.message)}
  finally{
    if(control){
      try{
        if((await call('release_control',control)).data.result?.released!==true)throw new Error('Release receipt did not confirm that control was released.');
        evidence.released=true;evidence.stages.push('release');
      }catch(error){evidence.releaseError=String(error.message)}
    }
    if(claimMayExist){
      if(control&&!evidence.released)evidence.bindingReleaseError='Own control release is unconfirmed; retain the private recovery file.';
      else try{
        const released=(await call('release_binding',{sessionId:binding.sessionId,bindingId:binding.bindingId,bindingToken:binding.bindingToken})).data.result;
        if(released?.released!==true)throw new Error('Binding release receipt was not confirmed.');
        evidence.bindingReleased=true;evidence.stages.push('binding_release');
      }catch(error){evidence.bindingReleaseError=String(error.message)}
    }
    try{await client.close()}catch(error){evidence.closeError=String(error.message)}
  }
  evidence.passed=!evidence.error&&!evidence.releaseError&&!evidence.bindingReleaseError&&!evidence.closeError&&evidence.released&&(!fleet||evidence.bindingReleased)&&evidence.stages.includes('screenshot');
  return evidence;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const options={};
    for(let i=2;i<process.argv.length;i+=2){
      const key=process.argv[i];
      if(!['--document','--session','--pairing-file','--recovery','--screenshot'].includes(key)||!process.argv[i+1]||options[key]!==undefined)throw new Error('Usage: node scripts/live_smoke.mjs --document ID --session UUID --pairing-file /private/code.txt|- --recovery /private/new.json [--screenshot /absolute/new.png]');
      options[key]=process.argv[i+1];
    }
    if(Boolean(options['--pairing-file'])!==Boolean(options['--recovery']))throw new Error('Pairing input and a new private recovery path are required together.');
    const pairingTicket=options['--pairing-file']?await readPairingInput(options['--pairing-file']):undefined;
    const evidence=await runSmoke(new Client({name:'vids-explicit-read-only-smoke',version:'2'}),{
      documentId:options['--document'],sessionId:options['--session'],pairingTicket,
      saveBinding:pairingTicket?binding=>writeSmokeRecovery(options['--recovery'],binding):undefined,screenshotPath:options['--screenshot']});
    process.exitCode=evidence.passed?0:1;console.log(JSON.stringify(evidence,null,2));
  }catch(error){process.stderr.write(`Live acceptance stopped: ${error.message}\n`);process.exitCode=1}
}
