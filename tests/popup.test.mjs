import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'))
  .replace(/^import \{PROFILE\} from '\.\/profile\.js';\n/, '');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function popup(initial) {
  const elements = new Map();
  const createElement = tagName => ({
    tagName,textContent:'',value:'',hidden:false,disabled:false,listeners:{},children:[],attributes:{},
    addEventListener(name,fn){this.listeners[name]=fn},
    setAttribute(name,value){this.attributes[name]=value},
    append(...children){this.children.push(...children)},
    replaceChildren(...children){this.children=[...children]},
  });
  const element = selector => {
    if(!elements.has(selector))elements.set(selector,createElement(selector));
    return elements.get(selector);
  };
  let respond=initial,refresh;
  vm.runInNewContext(source,{
    PROFILE:{displayName:'Vids Studio',clientName:'Codex'},
    document:{querySelector:element,createElement,documentElement:{}},
    localStorage:{getItem:()=>null,setItem(){}},navigator:{language:'en-US'},
    chrome:{runtime:{sendMessage:async request=>respond(request)}},
    setInterval:fn=>{refresh=fn},
  });
  await flush();
  return {
    element,
    rows:()=>element('#connections').children,
    async poll(handler){respond=handler;refresh();await flush()},
    async click(selector,handler){respond=handler;element(selector).listeners.click();await flush()},
    async clickRow(title,label,handler){
      respond=handler;
      const row=element('#connections').children.find(item=>item.children[0].textContent===title);
      assert.ok(row,`Missing visible connection ${title}`);
      const button=row.children[2].children.find(item=>item.textContent===label);
      assert.ok(button,`Missing visible action ${label}`);button.listeners.click();await flush();
    },
  };
}
const status=result=>()=>({ok:true,result});
const sessionA={attached:true,sessionId:'session-a',documentId:'fixture-a',title:'Synthetic document A',pairingState:'available'};
const sessionB={...sessionA,sessionId:'session-b',documentId:'fixture-b',title:'Synthetic document B'};
const fleet=(sessions,currentSessionId=sessions[0]?.sessionId??null)=>({attached:sessions.length>0,sessions,currentSessionId});
const connected=fleet([sessionA]);
const disconnected=fleet([]);
const attachResult=value=>()=>({ok:true,result:{status:value,pairing:null}});
const wrongPage=()=>({ok:false,error:{code:'WRONG_PAGE',message:'wrong page'}});

test('failed attachment remains visible across identical fleet refreshes; changed current session clears it',async()=>{
  const ui=await popup(status(connected));
  await ui.click('#attach',wrongPage);await ui.poll(status(connected));
  assert.equal(ui.element('#error').hidden,false);
  assert.match(ui.element('#error').textContent,/Open a Google Vids document/);
  assert.equal(ui.rows()[0].children[0].textContent,sessionA.title);
  await ui.poll(status(fleet([sessionB])));
  assert.equal(ui.element('#error').hidden,true);
});

test('a recovered disconnected status clears a transient communication failure',async()=>{
  const ui=await popup(()=>undefined);
  assert.match(ui.element('#error').textContent,/did not respond/);
  await ui.poll(status(disconnected));
  assert.equal(ui.element('#error').hidden,true);
  assert.equal(ui.element('#state').textContent,'No tab connected');assert.equal(ui.rows().length,0);
});

test('a successful targeted disconnect or observed detach clears a stale attachment failure',async()=>{
  const ui=await popup(status(connected));
  await ui.click('#attach',wrongPage);
  await ui.clickRow(sessionA.title,'Disconnect',request=>{
    assert.equal(request.type,'disconnect');assert.equal(request.sessionId,sessionA.sessionId);return {ok:true,result:disconnected};
  });
  assert.equal(ui.element('#error').hidden,true);
  await ui.click('#attach',attachResult(connected));await ui.click('#attach',wrongPage);
  await ui.poll(status(disconnected));assert.equal(ui.element('#error').hidden,true);
});

test('an error for one connection survives changes to other sessions until its own detach is observed',async()=>{
  const ui=await popup(status(fleet([sessionA,sessionB])));
  await ui.clickRow(sessionA.title,'Disconnect',()=>({ok:false,error:{code:'BROWSER_RECOVERING',message:'Waiting for this video'}}));
  await ui.poll(status(fleet([sessionA],sessionA.sessionId)));
  assert.equal(ui.element('#error').hidden,false);assert.equal(ui.element('#error').textContent,'Waiting for this video');
  await ui.poll(status(disconnected));assert.equal(ui.element('#error').hidden,true);
});

test('pairing code belongs to its selected row and disappears when that session is claimed',async()=>{
  const ui=await popup(status(fleet([sessionA,sessionB])));
  const ticket='f'.repeat(64);
  await ui.clickRow(sessionB.title,'Show pairing code',request=>{
    assert.equal(request.type,'pairing');assert.equal(request.sessionId,sessionB.sessionId);
    return {ok:true,result:{sessionId:sessionB.sessionId,ticket}};
  });
  assert.equal(ui.element('#pairing').hidden,false);assert.equal(ui.element('#pairing-code').value,ticket);
  await ui.poll(status(fleet([sessionA,{...sessionB,pairingState:'claimed'}])));
  assert.equal(ui.element('#pairing').hidden,true);assert.equal(ui.element('#pairing-code').value,'');
});
