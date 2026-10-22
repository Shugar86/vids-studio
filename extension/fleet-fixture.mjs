// Test-only native messaging adapter. Browser/extension/driver/CDP are real;
// the adapter exposes independent ports for native/MCP end-to-end fixtures.
import {spawn} from 'node:child_process';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function launchFleetFixture({count = 10} = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'vids-fleet-'));
  const extension = join(temporary, 'extension'), profile = join(temporary, 'profile');
  let browser, child, exit;
  async function close() {
    await browser?.close();
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exit, delay(3000, undefined, {ref:false})]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    }
    await rm(temporary, {recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
  try {
    await cp(join(root,'extension'),extension,{recursive:true});
    const manifest = JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
    manifest.permissions.push('tabs'); // Fixture substitute for popup activeTab grant.
    await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
    await writeFile(join(extension,'background.js'), `
      import {createFleetDriver} from './fleet.js';
      globalThis.fixturePorts = [];
      globalThis.fixtureHold = null;
      globalThis.fixtureDeliver = (id, message) => { const port=fixturePorts[id]; if(!port||port.closed)throw new Error('Port closed'); for(const fn of port.receivers)fn(message); };
      globalThis.fixtureDrain = () => fixturePorts.map((port,id)=>({id,closed:port.closed,messages:port.outbox.splice(0)}));
      globalThis.fixtureDisconnect = id => { const port=fixturePorts[id]; if(port&&!port.closed){port.closed=true;for(const fn of port.disconnectors)fn();} };
      const native = {connectNative() {
        const port = {outbox:[],receivers:[],disconnectors:[],closed:false,
          postMessage(message){if(this.closed)throw new Error('Port closed');this.outbox.push(message)},
          disconnect(){this.closed=true},
          onMessage:{addListener(fn){port.receivers.push(fn)}},
          onDisconnect:{addListener(fn){port.disconnectors.push(fn)}}};
        fixturePorts.push(port); return port;
      }};
      const debuggerApi = {
        attach:(...args)=>chrome.debugger.attach(...args),detach:(...args)=>chrome.debugger.detach(...args),
        async sendCommand(target,method,params){
          if(fixtureHold?.tabId===target.tabId&&method==='Page.startScreencast'){
            const hold=fixtureHold;fixtureHold=null;hold.sent();await hold.gate;
          }
          return chrome.debugger.sendCommand(target,method,params);
        }
      };
      globalThis.fixtureFleet=createFleetDriver({debugger:debuggerApi,tabs:chrome.tabs,storage:chrome.storage,
        action:chrome.action,downloads:chrome.downloads,runtime:native});
      chrome.debugger.onEvent.addListener(fixtureFleet.onDebuggerEvent);
      chrome.debugger.onDetach.addListener(fixtureFleet.onDebuggerDetach);
      chrome.tabs.onUpdated.addListener(fixtureFleet.onTabUpdated);
      chrome.tabs.onRemoved.addListener(fixtureFleet.onTabRemoved);
    `);
    child=spawn(chromium.executablePath(),[
      '--no-sandbox','--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
      '--no-first-run','--no-default-browser-check','--window-size=900,700','--disable-background-networking',
      `--user-data-dir=${profile}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'about:blank',
    ],{stdio:['ignore','ignore','pipe']});
    exit=new Promise(resolve=>child.once('exit',resolve));let stderr='';
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4000)});
    let port;
    for(let attempt=0;attempt<100;attempt++){
      try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]}catch{}
      if(port)break;if(child.exitCode!==null)throw new Error(`Fixture browser exited: ${stderr}`);await delay(50);
    }
    if(!port)throw new Error(`Fixture browser did not start: ${stderr}`);
    // Critical: ordinary Playwright silently enables focus emulation itself.
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});
    const context=browser.contexts()[0];
    const urls=Array.from({length:count},(_,i)=>`https://docs.google.com/videos/d/fleet_fixture_${i}/edit`);
    const coverUrl='https://example.invalid/human-active-fixture';
    await context.route('**/*',route=>{
      const url=route.request().url(),index=urls.indexOf(url);
      if(url===coverUrl)return route.fulfill({contentType:'text/html',body:'<title>Human active fixture</title><input aria-label="Human input" value="untouched">'});
      if(index<0)return route.abort();
      return route.fulfill({contentType:'text/html',body:`<!doctype html><title>Video ${index}</title>
        <style>body{margin:0;height:2000px;background:hsl(${index*30} 50% 90%)}button{position:fixed;top:20px;left:20px}</style>
        <button onclick="this.textContent='Done ${index}';document.querySelector('output').textContent='edited ${index}'">Apply ${index}</button>
        <output style="position:fixed;top:65px;left:20px">untouched ${index}</output>`});
    });
    const predicate=worker=>worker.url().endsWith('/background.js');
    const worker=context.serviceWorkers().find(predicate)??await context.waitForEvent('serviceworker',{predicate,timeout:10000});
    const pages=[];
    for(const url of urls){const page=await context.newPage();await page.goto(url);pages.push(page);}
    const cover=await context.newPage();await cover.goto(coverUrl);
    const activeTabs=()=>worker.evaluate(async()=> (await chrome.tabs.query({active:true})).map(tab=>tab.id));
    const activeBefore=await activeTabs();
    const attached=await worker.evaluate(async urls=>{
      const tabs=await chrome.tabs.query({});
      return Promise.all(urls.map(url=>{const tab=tabs.find(tab=>tab.url===url);if(!tab)throw new Error('Missing fixture tab');return fixtureFleet.attach(tab)}));
    },urls);
    const sessions=attached.map(item=>item.status.sessions.find(session=>session.sessionId===item.pairing.sessionId));
    let id=0;
    const request=(index,method,params={})=>worker.evaluate(envelope=>fixtureFleet.handleRequest(envelope),
      {v:2,type:'request',id:`fixture-${++id}`,sessionId:sessions[index].sessionId,method,params});
    return {browser,context,worker,pages,cover,sessions,attached,activeBefore,activeTabs,request,close,
      drain:()=>worker.evaluate(()=>fixtureDrain()),
      deliver:(portId,message)=>worker.evaluate(({portId,message})=>fixtureDeliver(portId,message),{portId,message}),
      disconnectPort:portId=>worker.evaluate(portId=>fixtureDisconnect(portId),portId),
      holdCapture:index=>worker.evaluate(tabId=>{
        let release,sent;const gate=new Promise(resolve=>{release=resolve});globalThis.fixtureCaptureSent=new Promise(resolve=>{sent=resolve});
        globalThis.fixtureReleaseCapture=release;globalThis.fixtureHold={tabId,gate,sent};
      },sessions[index].tabId),
      waitCaptureHeld:()=>worker.evaluate(()=>fixtureCaptureSent),
      releaseCapture:()=>worker.evaluate(()=>fixtureReleaseCapture()),
    };
  }catch(error){await close();throw error;}
}
