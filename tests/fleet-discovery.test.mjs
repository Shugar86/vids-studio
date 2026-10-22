import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fleetSnapshot} from '../server/fleet-client.mjs';
import {PROFILE} from '../server/runtime.mjs';

const execute=promisify(execFile);
const native=fileURLToPath(new URL('../native',import.meta.url));

test('discovery cache and pending reads remain scoped to the effective private registry',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'vids-discovery-'));
  try{
    const environments=[];
    for(const name of ['first','second']){
      const parent=join(temporary,name);await mkdir(parent,{mode:0o700});
      const env={...process.env,VIDS_STUDIO_REGISTRY_DIR:join(parent,'coordinator')};
      delete env.VIDS_STUDIO_FLEET_DIR;delete env.VIDS_STUDIO_SOCKET;
      const python=env.VIDS_STUDIO_PYTHON||(process.platform==='win32'?'python':'python3');
      await execute(python,['-c',
        'import sys,uuid,secrets;sys.path.insert(0,sys.argv[1]);from fleet import FleetRegistry;FleetRegistry().register(str(uuid.uuid4()),sys.argv[2],sys.argv[3],str(uuid.uuid4()),"fixture-unused-endpoint",secrets.token_hex(32),{})',
        native,PROFILE.id,`fixture_${name}`],{env});
      environments.push(env);
    }
    const first=await fleetSnapshot({env:environments[0],fresh:true});
    const second=await fleetSnapshot({env:environments[1]});
    assert.equal(first.sessions[0].documentId,'fixture_first');
    assert.equal(second.sessions[0].documentId,'fixture_second','a cached snapshot must not cross registry directories');
    const concurrent=await Promise.all(environments.map(env=>fleetSnapshot({env,fresh:true})));
    assert.deepEqual(concurrent.map(value=>value.sessions[0].documentId),['fixture_first','fixture_second'],
      'in-flight discovery must not coalesce different private registries');
  }finally{await rm(temporary,{recursive:true,force:true});}
});
