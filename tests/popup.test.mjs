import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'))
  .replace(/^import \{PROFILE\} from '\.\/profile\.js';\n/, '');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function popup(initial) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent:'', hidden:false, disabled:false, listeners:{},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute() {},
    });
    return elements.get(selector);
  };
  let respond = initial;
  let refresh;
  vm.runInNewContext(source, {
    PROFILE: {displayName:'Vids Studio', clientName:'Codex'},
    document: {querySelector:element, documentElement:{}},
    localStorage: {getItem:()=>null, setItem(){}},
    navigator: {language:'en-US'},
    chrome: {runtime: {sendMessage:async request => respond(request)}},
    setInterval:fn => { refresh = fn; },
  });
  await flush();
  return {
    element,
    async poll(handler) { respond = handler; refresh(); await flush(); },
    async click(selector, handler) { respond = handler; element(selector).listeners.click(); await flush(); },
  };
}
const status = result => () => ({ok:true, result});
const attached = {attached:true, sessionId:'session-a', title:'Synthetic document A'};
const wrongPage = () => ({ok:false, error:{code:'WRONG_PAGE', message:'wrong page'}});

test('failed tab switch remains visible across identical attached status refreshes', async () => {
  const ui = await popup(status(attached));
  await ui.click('#attach', wrongPage);
  await ui.poll(status(attached));
  assert.equal(ui.element('#error').hidden, false);
  assert.match(ui.element('#error').textContent, /Open a Google Vids document/);
  assert.equal(ui.element('#document').textContent, attached.title);
  await ui.poll(status({...attached, sessionId:'session-b'}));
  assert.equal(ui.element('#error').hidden, true);
});

test('a recovered disconnected status clears a transient communication failure', async () => {
  const ui = await popup(() => undefined);
  assert.match(ui.element('#error').textContent, /did not respond/);
  await ui.poll(status({attached:false}));
  assert.equal(ui.element('#error').hidden, true);
  assert.equal(ui.element('#state').textContent, 'No tab connected');
});

test('a successful action or observed detach clears a stale action failure', async () => {
  const ui = await popup(status(attached));
  await ui.click('#attach', wrongPage);
  await ui.click('#disconnect', status({attached:false}));
  assert.equal(ui.element('#error').hidden, true);
  await ui.click('#attach', status(attached));
  await ui.click('#attach', wrongPage);
  await ui.poll(status({attached:false}));
  assert.equal(ui.element('#error').hidden, true);
});
