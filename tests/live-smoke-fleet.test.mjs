import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,symlink,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {readPairingInput,writeSmokeRecovery,runSmoke} from '../scripts/live_smoke.mjs';
import {launchFullChainFixture} from './fleet-chain-fixture.mjs';

const ticket='b'.repeat(64);
test('smoke input rejects unsafe/oversized files and never overwrites recovery credentials',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vids-smoke-private-'));
  try{
    const input=join(directory,'ticket.txt');await writeFile(input,ticket+'\n',{mode:0o600});
    assert.equal(await readPairingInput(input),ticket);
    assert.equal(await readPairingInput('-',{stdin:Readable.from([ticket+'\n'])}),ticket);
    await assert.rejects(readPairingInput('-',{stdin:Readable.from(['x'.repeat(257)])}),/256 bytes/);
    await assert.rejects(readPairingInput('-',{stdin:Readable.from(['invalid'])}),/64 hex/);
    if(process.platform!=='win32'){
      await chmod(input,0o644);await assert.rejects(readPairingInput(input),/0600/);await chmod(input,0o600);
      const link=join(directory,'linked.txt');await symlink(input,link);await assert.rejects(readPairingInput(link),/regular file/);
    }
    await writeFile(input,'b'.repeat(257));await assert.rejects(readPairingInput(input),/small regular/);
    const recovery=join(directory,'recovery.json');await writeSmokeRecovery(recovery,{bindingToken:ticket});
    await assert.rejects(writeSmokeRecovery(recovery,{bindingToken:'never-overwrite'}));
    assert.equal(JSON.parse(await readFile(recovery,'utf8')).bindingToken,ticket);
    if(process.platform!=='win32')assert.equal((await stat(recovery)).mode&0o777,0o600);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('public smoke performs an exact fresh binding through real fleet MCP/native/Chrome and leaves the video untouched',{timeout:30000},async()=>{
  const f=await launchFullChainFixture({count:1,connectClients:false});
  const directory=await mkdtemp(join(tmpdir(),'vids-smoke-chain-'));
  try{
    const session=f.sessions[0];const recovery=join(directory,'recovery.json');
    const client=new Client({name:'live-smoke-fixture',version:'1'});
    const evidence=await runSmoke(client,{documentId:session.documentId,sessionId:session.sessionId,pairingTicket:f.attached[0].pairing.ticket,
      saveBinding:binding=>writeSmokeRecovery(recovery,binding),
      transport:new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server/index.mjs',import.meta.url))],env:f.env})});
    assert.equal(evidence.passed,true,JSON.stringify(evidence));assert.equal(evidence.bindingReleased,true);
    assert.equal(await f.browserFixture.pages[0].locator('output').textContent(),'untouched 0');
    assert.deepEqual(await f.browserFixture.activeTabs(),f.browserFixture.activeBefore);
    const saved=JSON.parse(await readFile(recovery,'utf8'));
    assert.equal(saved.sessionId,session.sessionId);assert.equal(saved.expectedDocumentId,session.documentId);
    assert.equal(JSON.stringify(evidence).includes(saved.bindingToken),false);f.check();
  }finally{await f.close();await rm(directory,{recursive:true,force:true})}
});
