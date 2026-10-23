import assert from 'node:assert/strict';
import test from 'node:test';
import {createExportWatcher} from '../extension/export-watch.js';

function fixture() {
  let time=Date.now();let created,changed;const queries=[];let records=[];let searchOverride;
  const watch=createExportWatcher({downloads:{onCreated:{addListener:fn=>{created=fn;}},onChanged:{addListener:fn=>{changed=fn;}},search:async query=>{queries.push(query);return searchOverride?await searchOverride(query):records;}}},{now:()=>time});
  const binding={jobId:'job-1',sessionId:'session-1',documentId:'document-1',frameId:'frame-1',tabId:9};
  const item={id:42,url:'https://fixture.invalid/export.mp4',finalUrl:'https://fixture.invalid/export.mp4',referrer:'https://docs.google.com/videos/d/document-1/edit',startTime:new Date(time).toISOString(),state:'complete',filename:'/tmp/verified.mp4',exists:true};
  const begin=()=>watch.onDebuggerEvent({tabId:9},'Page.downloadWillBegin',{frameId:'frame-1',guid:'guid-1',url:item.finalUrl,suggestedFilename:'project.mp4'});
  const complete=()=>watch.onDebuggerEvent({tabId:9},'Page.downloadProgress',{guid:'guid-1',state:'completed'});
  records=[item];
  return {watch,binding,item,begin,complete,created:x=>created(x),changed:x=>changed(x),queries,records:x=>{records=x;},search:x=>{searchOverride=x;},advance:x=>{time+=x;}};
}
test('watch correlates own frame event and exact download id without exposing its URL',async()=>{
  const f=fixture();f.watch.arm(f.binding);f.begin();f.created(f.item);f.complete();f.watch.markTriggerAccepted('job-1');
  const result=await f.watch.status('job-1','session-1');assert.equal(result.state,'completed');assert.equal(result.downloadId,42);assert.equal(result.filename,'/tmp/verified.mp4');assert.equal(result.triggerOutcome,'performed');assert.equal(JSON.stringify(result).includes('fixture.invalid'),false);assert.deepEqual(f.queries,[{id:42}]);
});
test('reversed onCreated/Page event order still correlates using bounded race buffer',async()=>{
  const f=fixture();f.watch.arm(f.binding);f.created(f.item);f.begin();f.complete();assert.equal((await f.watch.status('job-1','session-1')).state,'completed');assert.deepEqual(f.queries,[{id:42}]);
});
test('redirect uses exact final URL, never partial filename or broad history search',async()=>{
  const f=fixture();f.item.url='https://fixture.invalid/redirect';f.watch.arm(f.binding);f.begin();f.created({...f.item,id:99,finalUrl:'https://fixture.invalid/unrelated.mp4'});f.created(f.item);f.complete();assert.equal((await f.watch.status('job-1','session-1')).downloadId,42);assert.deepEqual(f.queries,[{id:42}]);
});
test('another frame, tab, session, document or old download cannot satisfy a job',async()=>{
  const f=fixture();f.watch.arm(f.binding);
  for(const source of [{tabId:10},{tabId:9,sessionId:'child'}])f.watch.onDebuggerEvent(source,'Page.downloadWillBegin',{frameId:'frame-1',guid:'foreign',url:f.item.url,suggestedFilename:'project.mp4'});
  f.watch.onDebuggerEvent({tabId:9},'Page.downloadWillBegin',{frameId:'other-frame',guid:'foreign',url:f.item.url,suggestedFilename:'project.mp4'});
  f.created(f.item);assert.equal((await f.watch.status('job-1','session-1')).state,'armed');assert.equal(f.queries.length,0);await assert.rejects(f.watch.status('job-1','other-session'),e=>e.code==='EXPORT_WATCH_NOT_FOUND');
  f.begin();f.records([{...f.item,id:44}]);f.created({...f.item,id:44,referrer:'https://docs.google.com/videos/d/other-doc/edit'});f.complete();assert.equal((await f.watch.status('job-1','session-1')).code,'DOWNLOAD_RECORD_LOST');
});
test('two matching download ids or Page guids fail closed as ambiguous',async()=>{
  for(const mode of ['ids','guids']){
    const f=fixture();f.watch.arm(f.binding);f.begin();f.created(f.item);
    if(mode==='ids')f.created({...f.item,id:43});else f.watch.onDebuggerEvent({tabId:9},'Page.downloadWillBegin',{frameId:'frame-1',guid:'guid-2',url:f.item.url,suggestedFilename:'project.mp4'});
    f.complete();const status=await f.watch.status('job-1','session-1');assert.equal(status.state,'needs_reconciliation');assert.equal('filename' in status,false);assert.equal(f.queries.length,0);
  }
});
test('late complete cannot erase unknown trigger or revive revoked session',async()=>{
  const f=fixture();f.watch.arm(f.binding);f.watch.markTriggerUnknown('job-1');f.watch.markTriggerAccepted('job-1');f.begin();f.created(f.item);f.complete();assert.equal((await f.watch.status('job-1','session-1')).triggerOutcome,'unknown');
  f.watch.revoke('session-1');f.begin();f.complete();const status=await f.watch.status('job-1','session-1');assert.equal(status.state,'revoked');assert.equal('filename' in status,false);
});
test('revoke while search waits cannot publish a filename',async()=>{
  const f=fixture();f.watch.arm(f.binding);f.begin();f.created(f.item);f.complete();let resolve;f.search(()=>new Promise(r=>{resolve=r;}));const pending=f.watch.status('job-1','session-1');f.watch.revoke('session-1');resolve([f.item]);const status=await pending;assert.equal(status.state,'revoked');assert.equal('filename' in status,false);
});
test('missing file, canceled browser transfer, unsupported path and overflow stay unresolved',async()=>{
  for(const mode of ['missing','canceled','path','overflow']){
    const f=fixture();f.watch.arm(f.binding);f.begin();f.created(f.item);f.complete();
    if(mode==='missing')f.records([{...f.item,exists:false}]);
    if(mode==='path')f.records([{...f.item,filename:'/tmp/fake.html'}]);
    if(mode==='canceled')f.changed({id:42,state:{current:'interrupted'}});
    if(mode==='overflow')for(let i=100;i<165;i++)f.created({...f.item,id:i,url:`https://fixture.invalid/${i}`,finalUrl:`https://fixture.invalid/${i}`});
    assert.equal((await f.watch.status('job-1','session-1')).state,'needs_reconciliation');
  }
});
test('only a definitely untriggered armed watch can be discarded, and waits expire',async()=>{
  const f=fixture();f.watch.arm(f.binding);assert.equal(f.watch.discard('job-1','session-1'),true);f.watch.arm(f.binding);f.watch.markTriggerUnknown('job-1');assert.equal(f.watch.discard('job-1','session-1'),false);f.advance(900001);assert.equal((await f.watch.status('job-1','session-1')).code,'EXPORT_WATCH_EXPIRED');
});

test('pending export metadata is fresh, session-local and omits job/download capabilities',async()=>{
  const f=fixture();assert.equal(f.watch.pending('session-1'),null);
  f.watch.arm(f.binding);f.watch.markTriggerUnknown('job-1');
  const armed=f.watch.pending('session-1');
  assert.equal(armed.state,'armed');assert.equal(armed.triggerOutcome,'unknown');
  assert.deepEqual(Object.keys(armed).sort(),['expiresAt','retryBoundary','state','triggerOutcome']);
  assert.equal(f.watch.pending('other-session'),null);
  f.begin();assert.equal(f.watch.pending('session-1').state,'downloading');
  assert.equal(f.queries.length,0,'Preflight never searches browser download history');
  f.created(f.item);f.complete();await f.watch.status('job-1','session-1');
  assert.equal(f.watch.pending('session-1'),null);
});
test('accepted trigger cannot discard its watch while waiting for a late download event',async()=>{
  const f=fixture();f.watch.arm(f.binding);f.watch.markTriggerAccepted('job-1');
  assert.equal(f.watch.discard('job-1','session-1'),false);
  assert.throws(()=>f.watch.arm({...f.binding,jobId:'new-job'}),{code:'EXPORT_WATCH_BUSY'});
  f.begin();f.created(f.item);f.complete();
  assert.equal((await f.watch.status('job-1','session-1')).state,'completed');
});

test('real isolated MV3 debugger correlates ordinary HTTP, redirect and blob downloads without behavior overrides',async()=>{
  const {chromium}=await import('playwright');
  const {createServer}=await import('node:http');
  const fixtureServer=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'/fixture.mp4'});res.end();}else{res.writeHead(200,{'content-type':'video/mp4','content-disposition':'attachment; filename="fixture.mp4"'});res.end('fixture bytes');}});
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));const fixtureOrigin=`http://127.0.0.1:${fixtureServer.address().port}`;
  const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawn}=await import('node:child_process');
  const root=await mkdtemp(join(tmpdir(),'vids-export-watch-'));const ext=join(root,'extension'),profile=join(root,'profile'),downloads=join(root,'downloads');
  await Promise.all([mkdir(ext),mkdir(join(profile,'Default'),{recursive:true}),mkdir(downloads)]);
  // Only the disposable fixture profile is configured. No CDP download-behavior
  // override is issued; the production recipe requires its own attestation.
  await writeFile(join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:downloads,prompt_for_download:false,directory_upgrade:true}}));
  await writeFile(join(ext,'export-watch.js'),await readFile(new URL('../extension/export-watch.js',import.meta.url)));
  await writeFile(join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated export watch',version:'1.0',permissions:['debugger','downloads','tabs'],host_permissions:['https://docs.google.com/*'],background:{service_worker:'background.js',type:'module'}}));
  await writeFile(join(ext,'background.js'),`import {createExportWatcher} from './export-watch.js';globalThis.watch=createExportWatcher(chrome);chrome.debugger.onEvent.addListener((...args)=>{if(!globalThis.suppressPageDownloads)watch.onDebuggerEvent(...args);});`);
  const child=spawn(chromium.executablePath(),['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'about:blank'],{stdio:['ignore','ignore','pipe']});let browser;
  const childClosed = new Promise(resolve => child.once('close', resolve));
  try {
    const endpoint=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Isolated Chromium did not start')),10000);child.stderr.on('data',b=>{text+=b;const match=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.on('exit',()=>{clearTimeout(timer);reject(Error('Isolated Chromium exited'));});});
    browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});const context=browser.contexts()[0];
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===fixtureOrigin)return route.continue();
      if(url.hostname!=='docs.google.com')return route.abort();
      if(url.pathname==='/fixture-redirect')return route.fulfill({status:302,headers:{location:'https://docs.google.com/fixture.mp4'}});
      if(url.pathname==='/fixture.mp4')return route.fulfill({headers:{'content-type':'video/mp4','content-disposition':'attachment; filename="fixture.mp4"'},body:'fixture bytes'});
      if(url.pathname==='/videos/d/export_fixture/edit')return route.fulfill({contentType:'text/html',body:`<meta name="referrer" content="unsafe-url"><a id="direct" href="${fixtureOrigin}/fixture.mp4">Direct</a><a id="redirect" href="${fixtureOrigin}/redirect">Redirect</a><button id="blob" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['blob bytes'],{type:'video/mp4'}));a.download='blob.mp4';a.click()">Blob</button>`});
      return route.abort();
    });
    const worker=context.serviceWorkers().find(w=>w.url().endsWith('/background.js'))??await context.waitForEvent('serviceworker',{predicate:w=>w.url().endsWith('/background.js'),timeout:10000});
    const page=await context.newPage();await page.goto('https://docs.google.com/videos/d/export_fixture/edit');
    const binding=await worker.evaluate(async url=>{const [tab]=await chrome.tabs.query({url});await chrome.debugger.attach({tabId:tab.id},'1.3');await chrome.debugger.sendCommand({tabId:tab.id},'Page.enable');const {frameTree}=await chrome.debugger.sendCommand({tabId:tab.id},'Page.getFrameTree');return {tabId:tab.id,frameId:frameTree.frame.id,documentId:'export_fixture',sessionId:'fixture-session'};},page.url());
    const ids=[];
    for(const label of ['direct','redirect','blob','no-page']) {
      await worker.evaluate(value=>{globalThis.suppressPageDownloads=value;},label==='no-page');
      const jobId=`job-${label}`;await worker.evaluate(binding=>watch.arm(binding),{...binding,jobId});
      await page.locator(`#${label==='no-page'?'direct':label}`).click({noWaitAfter:true});let result;
      for(let attempt=0;attempt<30;attempt++){result=await worker.evaluate(({jobId,sessionId})=>watch.status(jobId,sessionId),{jobId,sessionId:binding.sessionId});if(result.state==='completed')break;await page.waitForTimeout(100);}
      assert.equal(result.state,'completed',JSON.stringify(result));assert.ok(result.filename.startsWith(downloads+'/'));assert.equal(JSON.stringify(result).includes('https://'),false);ids.push(result.downloadId);
      if(label==='no-page'){assert.equal(result.guid,undefined);assert.equal(result.correlation,'document_referrer');}
      assert.equal(await readFile(result.filename,'utf8'),label==='blob'?'blob bytes':'fixture bytes');
    }
    assert.equal(new Set(ids).size,4);
  } finally {
    try { await browser?.close(); }
    finally {
      // A CDP client close disconnects from an externally spawned browser. Wait
      // for its process to close before removing the profile it is still writing.
      let forceStop;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        forceStop = setTimeout(() => child.kill('SIGKILL'), 5000);
      }
      try { await childClosed; } finally { clearTimeout(forceStop); }
      await new Promise(resolve => fixtureServer.close(resolve));
      await rm(root, {recursive:true, force:true, maxRetries:5, retryDelay:100});
    }
  }
});

test('empty or origin-only referrers cannot misattribute another tab’s same URL',async()=>{
  for(const referrer of ['',undefined,'https://docs.google.com/']){
    const f=fixture();f.watch.arm(f.binding);f.begin();f.created({...f.item,id:99,referrer});f.complete();
    const unresolved=await f.watch.status('job-1','session-1');assert.equal(unresolved.state,'needs_reconciliation');assert.equal(unresolved.code,'EXPORT_REFERRER_UNVERIFIED');assert.equal(unresolved.downloadId,undefined);assert.equal(f.queries.length,0);
    f.created(f.item);assert.equal((await f.watch.status('job-1','session-1')).downloadId,undefined);
  }
});

test('exact document download events complete without Page download events and unblock preflight',async()=>{
  const f=fixture();f.watch.arm(f.binding);f.watch.markTriggerAccepted('job-1');f.created(f.item);
  assert.equal(await f.watch.preflight('session-1'),null);
  const result=await f.watch.status('job-1','session-1');
  assert.equal(result.state,'completed');assert.equal(result.correlation,'document_referrer');assert.equal(result.guid,undefined);
  assert.equal(result.filename,f.item.filename);assert.deepEqual(f.queries,[{id:42}]);
  f.watch.arm({...f.binding,jobId:'job-2'});
  assert.equal((await f.watch.status('job-1','session-1')).state,'completed');
});
test('document event fallback rejects foreign, origin-only, old and non-media candidates',async()=>{
  for(const patch of [{referrer:'https://docs.google.com/videos/d/other/edit'},{referrer:'https://docs.google.com/'},{referrer:''},{startTime:'2000-01-01T00:00:00Z'},{filename:'/tmp/document.pdf',mime:'application/pdf'}]){
    const f=fixture();f.watch.arm(f.binding);f.created({...f.item,...patch});
    assert.equal((await f.watch.status('job-1','session-1')).state,'armed');assert.equal(f.queries.length,0);
  }
});
test('completed receipt is not changed by a later export from the same document',async()=>{
  const f=fixture();f.watch.arm(f.binding);f.begin();f.created(f.item);f.complete();await f.watch.status('job-1','session-1');
  f.watch.onDebuggerEvent({tabId:9},'Page.downloadWillBegin',{frameId:'frame-1',guid:'later',url:f.item.url,suggestedFilename:'project.mp4'});
  assert.equal((await f.watch.status('job-1','session-1')).state,'completed');assert.equal(f.watch.pending('session-1'),null);
});

test('Windows absolute download paths are accepted without treating relative paths as exports',async()=>{
  for(const [filename,expected] of [['C:\\Users\\Example\\Downloads\\clip.mp4','completed'],['C:clip.mp4','needs_reconciliation']]){
    const f=fixture();f.item.filename=filename;f.watch.arm(f.binding);f.created(f.item);
    assert.equal((await f.watch.status('job-1','session-1')).state,expected);
  }
});
