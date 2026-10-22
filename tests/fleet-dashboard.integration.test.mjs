import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startDashboard} from '../server/fleet-dashboard.mjs';

test('local monitor renders ten isolated fixture videos, RU/EN states, pause controls and mobile layout', {timeout:30000}, async t=>{
  const titles=['Прогулка по ночному городу','История одной лампы','Кофейня на углу','Объясняем солнечную энергию','Весенний маршрут','Короткий фильм о мастерской','Путешествие по Камчатке','Как рождается мелодия','Портрет художницы','Рассказ о море'];
  const calls=[];let unavailable=false;
  const data={schemaVersion:1,generatedAt:Date.now()/1000,policy:{paused:false,maxConcurrency:10,effectiveConcurrency:5},resources:{cpuPercent:42,memoryAvailableBytes:8.2*1024**3,memoryTotalBytes:24*1024**3,pressure:{memory:{avg10:0}}},summary:{attached:10,pending:3},sessions:titles.map((title,index)=>({id:`e2962a05-7caa-4ba0-a8d2-${String(index).padStart(12,'0')}`,sessionId:`e2962a05-7caa-4ba0-a8d2-${String(index).padStart(12,'0')}`,documentId:`fixture-video-${index+1}`,title,profileId:index%2?'claude':'codex',browserInstanceId:index<5?'group-one':'group-two',ownerLabel:`${index%2?'Claude':'Codex'} ${index+1}`,state:'attached',updatedAt:Date.now()/1000-(index===4?100:1),pending:index<3?1:0,paused:index===6,runtime:{version:'0.3.0'},lastAction:index<3?'observe':null,recovery:index===8?{phase:'cdp_timeout',method:'Page.startScreencast'}:null}))};
  data.jobs={status:'available',records:[{jobId:'fixture-export-wait',profileId:'codex',documentId:'fixture-video-1',state:'waiting',stage:'waiting_for_correlated_download',updatedAt:new Date().toISOString(),runnerFresh:true},{jobId:'fixture-export-verified',profileId:'claude',documentId:'fixture-video-2',state:'succeeded',stage:'verified_file',updatedAt:new Date().toISOString(),hasVerifiedFile:true}]};
  data.localMedia={status:'available',maxSlots:2,reservedSlots:1};
  const monitor=await startDashboard({fleet:async(op,policy)=>{calls.push([op,policy]);if(unavailable)throw new Error('fixture offline');if(op==='policy'){if(policy.sessionId)data.sessions.find(s=>s.sessionId===policy.sessionId).paused=policy.paused;else Object.assign(data.policy,policy);}return data;}});t.after(()=>monitor.close());
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:1440,height:1080}});const outbound=[];
  await context.route('**/*',route=>{if(route.request().url().startsWith(monitor.origin+'/'))return route.continue();outbound.push(route.request().url());return route.abort();});
  const page=await context.newPage();await page.goto(monitor.url);await page.getByText(titles[9],{exact:true}).waitFor();
  assert.equal(await page.locator('#rows tr').count(),10);assert.equal(await page.locator('#export-rows tr').count(),2);assert.equal(new URL(page.url()).hash,'');assert.equal(await page.evaluate(()=>Object.values(localStorage).some(value=>value.length>35)),false);
  assert.match(await page.locator('#totals').textContent(),/3работают/);assert.equal(await page.locator('.status-pill.attention').count(),2);
  if(process.env.VIDS_STUDIO_VISUAL_DIR){await mkdir(process.env.VIDS_STUDIO_VISUAL_DIR,{recursive:true});await page.screenshot({path:join(process.env.VIDS_STUDIO_VISUAL_DIR,'monitor-desktop-ru.png'),fullPage:true});}
  await page.getByRole('button',{name:'Приостановить новые команды',exact:true}).click();await page.getByRole('button',{name:'Продолжить новые команды',exact:true}).waitFor();assert.equal(data.policy.paused,true);
  await page.getByRole('button',{name:'Switch language'}).click();await page.getByRole('heading',{name:'Every video has its own place.'}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'en');
  await page.getByRole('button',{name:'Needs attention',exact:true}).click();assert.equal(await page.locator('#rows tr').count(),2);
  await page.getByRole('button',{name:'All',exact:true}).click();await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await page.locator('#rows tr').count(),10);
  if(process.env.VIDS_STUDIO_VISUAL_DIR)await page.screenshot({path:join(process.env.VIDS_STUDIO_VISUAL_DIR,'monitor-mobile-en.png'),fullPage:true});
  assert.deepEqual(outbound,[]);assert.ok(calls.every(([op])=>['snapshot','policy'].includes(op)));
  unavailable=true;await page.waitForTimeout(4700);assert.match(await page.locator('#notice').textContent(),/could not be read/);assert.equal(await page.locator('#rows tr').count(),10);assert.equal(await page.locator('#pause-all').isDisabled(),true);
});

test('empty monitor and missing capability explain the next step without inventing activity', {timeout:20000}, async t=>{
  const monitor=await startDashboard({fleet:async()=>({schemaVersion:1,generatedAt:Date.now()/1000,sessions:[],policy:{paused:false,maxConcurrency:10},resources:{},summary:{attached:0}})});t.after(()=>monitor.close());
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(monitor.origin);await page.getByText(/Откройте приватную ссылку/).waitFor();assert.equal(await page.locator('#pause-all').isDisabled(),true);await page.goto(monitor.url);await page.getByText('Подключённые ролики появятся здесь',{exact:true}).waitFor();assert.equal(await page.locator('tbody tr').count(),0);
});
