import {chromeStorage} from '../tests/chrome-storage.mjs';
import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {chromium} from "playwright";
import {createDriver} from "./driver.js";

// Disposable headless browser; every URL is served from the test, with no user
// profile or Google traffic. Assertions inspect real DOM click results.
const url = "https://docs.google.com/videos/d/click_fixture_only/edit";
let browser;
before(async () => { browser = await chromium.launch({headless: true}); });
after(async () => { await browser?.close(); });

async function fixture(t, body, pages = {}) {
  const context = await browser.newContext({viewport: {width: 800, height: 600}});
  let driver;
  t.after(async () => { await driver?.detach(); await context.close(); });
  const main = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;font:20px sans-serif}button{font:inherit}
    </style>${body}<script>window.clicked=[];
    document.addEventListener('click',event=>window.clicked.push(event.target.closest('button')?.id || event.target.id || event.target.nodeName));
    </script>`;
  await context.route("**/*", route => {
    const requested = route.request().url();
    const document = requested === url ? main : pages[requested];
    return document === undefined ? route.abort() : route.fulfill({contentType: "text/html; charset=utf-8", body: document});
  });
  const page = await context.newPage();
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  const calls = [];
  const tab = async () => ({id: 1, url: page.url(), title: "Click fixture"});
  driver = createDriver({
      storage: chromeStorage(),
    debugger: {attach: async () => {}, detach: async () => {}, sendCommand: (_target, method, params = {}) => {
      calls.push([method, structuredClone(params)]);
      return cdp.send(method, params);
    }},
    tabs: {get: tab},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    runtime: {connectNative: () => ({postMessage() {}, disconnect() {}, onMessage: {addListener() {}}, onDisconnect: {addListener() {}}})},
  });
  await driver.attach(await tab());
  let id = 0;
  const request = (method, params = {}) => driver.handleRequest({v: 2, type: "request", id: `click-${++id}`, sessionId: driver.status().sessionId, method, params});
  async function observed(name) {
    const response = await request("observe");
    assert.equal(response.ok, true, JSON.stringify(response.error));
    const node = response.result.nodes.find(node => node.role === "button" && node.name === name);
    assert.ok(node, `Missing observed button: ${name}`);
    return {snapshotId: response.result.snapshotId, nodeRef: node.ref};
  }
  return {page, calls, request, observed};
}

function assertDenied(response, calls) {
  assert.equal(response.ok, false);
  assert.ok(["TARGET_OBSCURED", "TARGET_CHANGED", "NODE_NOT_VISIBLE"].includes(response.error.code), JSON.stringify(response.error));
  assert.equal(calls.some(([method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed"), false);
}

test("nodeRef click rejects an overlay introduced above the observed button", async t => {
  const f = await fixture(t, '<button id="intended" style="position:absolute;left:40px;top:40px;width:160px;height:60px">Intended</button>');
  const target = await f.observed("Intended");
  await f.page.evaluate(() => {
    const overlay = document.createElement("button");
    overlay.id = "wrong"; overlay.textContent = "Overlay";
    overlay.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:10";
    document.body.append(overlay);
  });
  const response = await f.request("click", target);
  assertDenied(response, f.calls);
  assert.deepEqual(await f.page.evaluate(() => window.clicked), []);
});

test("hover relayout never clicks the different button left under the old position", async t => {
  const f = await fixture(t, `
    <button id="wrong" style="position:absolute;left:60px;top:60px;width:160px;height:60px">Wrong</button>
    <button id="intended" style="position:absolute;left:60px;top:60px;width:160px;height:60px"
      onmouseenter="this.style.left='350px'">Moves on hover</button>`);
  const response = await f.request("click", await f.observed("Moves on hover"));
  const clicked = await f.page.evaluate(() => window.clicked);
  assert.equal(clicked.includes("wrong"), false);
  if (response.ok) assert.deepEqual(clicked, ["intended"]);
  else { assertDenied(response, f.calls); assert.deepEqual(clicked, []); }
  assert.equal(await f.page.locator("#intended").evaluate(element => element.style.left), "350px");
});

test("an overflow-clipped target is clicked correctly or rejected without clicking its neighbor", async t => {
  const f = await fixture(t, `
    <button id="wrong" style="position:absolute;left:50px;top:100px;width:180px;height:120px">Wrong under clip</button>
    <div style="position:absolute;left:50px;top:50px;width:180px;height:40px;overflow:clip">
      <button id="intended" style="width:180px;height:200px">Clipped target</button>
    </div>`);
  const response = await f.request("click", await f.observed("Clipped target"));
  const clicked = await f.page.evaluate(() => window.clicked);
  assert.equal(clicked.includes("wrong"), false);
  if (response.ok) assert.deepEqual(clicked, ["intended"]);
  else { assertDenied(response, f.calls); assert.deepEqual(clicked, []); }
});

test("a descendant span hit still activates its observed parent button", async t => {
  const f = await fixture(t, '<button id="intended" style="margin:60px;padding:0;width:220px;height:80px"><span id="label" style="display:flex;width:100%;height:100%;align-items:center;justify-content:center">Nested label</span></button>');
  const response = await f.request("click", await f.observed("Nested label"));
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.deepEqual(await f.page.evaluate(() => window.clicked), ["intended"]);
});

test("an offscreen observed button is scrolled into view and receives the click", async t => {
  const f = await fixture(t, '<button id="wrong" style="position:fixed;left:450px;top:100px">Other button</button><div style="height:1400px"></div><button id="intended" style="margin:30px;width:240px;height:80px">Offscreen target</button><div style="height:400px"></div>');
  assert.equal(await f.page.evaluate(() => scrollY), 0);
  const response = await f.request("click", await f.observed("Offscreen target"));
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.ok(await f.page.evaluate(() => scrollY > 0));
  assert.deepEqual(await f.page.evaluate(() => window.clicked), ["intended"]);
});

test("a fixed overlay still blocks the intended target after automatic scrolling", async t => {
  const f = await fixture(t, `
    <div style="height:1400px"></div><button id="intended" style="margin:30px;width:240px;height:80px">Offscreen obscured</button><div style="height:400px"></div>
    <button id="wrong" style="position:fixed;left:0;top:220px;width:800px;height:180px;z-index:10">Fixed overlay</button>`);
  const response = await f.request("click", await f.observed("Offscreen obscured"));
  assert.ok(await f.page.evaluate(() => scrollY > 0));
  assertDenied(response, f.calls);
  assert.deepEqual(await f.page.evaluate(() => window.clicked), []);
});

test("coordinate clicks on a canvas retain their original behavior", async t => {
  const f = await fixture(t, '<canvas id="canvas" width="300" height="200" style="margin:40px;background:#345"></canvas>');
  const observation = await f.request("observe");
  assert.equal(observation.ok, true);
  const response = await f.request("click", {snapshotId: observation.result.snapshotId, x: 100, y: 100});
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.deepEqual(await f.page.evaluate(() => window.clicked), ["canvas"]);
});

test("an observed button inside a same-origin child frame receives its own click", async t => {
  const frameUrl = "https://docs.google.com/click-child";
  const f = await fixture(t, '<button id="wrong" style="position:absolute;left:20px;top:20px">Root neighbor</button><iframe id="child" title="Child frame" src="/click-child" style="position:absolute;left:150px;top:140px;width:350px;height:200px"></iframe>', {
    [frameUrl]: '<!doctype html><button id="intended" style="margin:30px;width:220px;height:80px" onclick="parent.window.clicked.push(this.id)"><span>Child target</span></button>',
  });
  const response = await f.request("click", await f.observed("Child target"));
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.deepEqual(await f.page.evaluate(() => window.clicked), ["intended"]);
});

test("hex replacement stops if clearing the input moves focus to a different editable field", async t => {
  const f = await fixture(t, `
    <label>Hex<input id="hex" type="text" value="#ff0000ff" oninput="if(!this.value)document.getElementById('other').focus()"></label>
    <label>Other<input id="other" type="text" value="Keep this unchanged"></label>`);
  const observation = await f.request("observe");
  assert.equal(observation.ok, true);
  const hex = observation.result.nodes.find(node => node.role === "textbox" && node.name === "Hex");
  assert.ok(hex);
  const response = await f.request("type_text", {
    snapshotId: observation.result.snapshotId, nodeRef: hex.ref, text: "#16283bff", replace: true,
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "FOCUS_NOT_EDITABLE");
  assert.equal(await f.page.locator("#other").inputValue(), "Keep this unchanged");
  assert.equal(await f.page.locator("#hex").inputValue(), "");
  assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false);
});
