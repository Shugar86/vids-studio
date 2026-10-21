import {chromeStorage} from '../tests/chrome-storage.mjs';
import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {chromium} from "playwright";
import {createDriver} from "./driver.js";

// Isolated headless Chromium only. No Google request, user profile or desktop.
const url = "https://docs.google.com/videos/d/picker_fixture_only/edit";
const foreignUrl = "https://foreign.example/upload-frame";
let browser, page, driver, temporary, file;
let nextId = 0;
let adoptOnRelease = false, ownerAtSelection;
let pressedAckDelay = 0;
let preflightDelayStage = null, preflightHovered = false;
const calls = [], chooserEvents = [];

before(async () => {
  browser = await chromium.launch({headless: true, args: ["--site-per-process"]});
  const context = await browser.newContext();
  await context.route("**/*", route => route.request().url() === url
    ? route.fulfill({contentType: "text/html; charset=utf-8", body: `<!doctype html>
      <button onclick="choose('instant', 0)">Загрузить фото</button>
      <button onclick="choose('coordinate', 0)">Загрузить по координатам</button>
      <button onclick="choose('delayed', 150)">Отложенная загрузка</button>
      <button onclick="choose('detached', 0, false)">Отдельный input</button>
      <button onclick="choose('adopted', 0, false, true)">Сменивший документ input</button>
      <button onclick="results.clickActive = navigator.userActivation.isActive">Обычный клик</button>
      <iframe id="foreign" title="Foreign upload frame" src="${foreignUrl}" style="display:block;width:400px;height:100px;margin-top:20px"></iframe>
      <script>
      window.results = {};
      function choose(id, delay, append = true, adoptAfterClick = false) {
        const input = document.createElement('input');
        input.type = 'file'; input.id = id; input.hidden = true;
        if (append) document.body.append(input);
        else window[id + 'Input'] = input;
        input.addEventListener('change', async () => {
          results[id] = {name: input.files[0]?.name, content: await input.files[0]?.text()};
        });
        input.addEventListener('cancel', () => { results[id] = {canceled: true}; });
        if (delay) setTimeout(() => input.click(), delay); else input.click();
        if (adoptAfterClick) {
          document.implementation.createHTMLDocument('Other document').adoptNode(input);
          // A page-defined getter must not spoof the native ownerDocument check.
          Object.defineProperty(input, 'ownerDocument', {get: () => document});
        }
      }
      </script>`}) : route.request().url() === foreignUrl
      ? route.fulfill({contentType: "text/html; charset=utf-8", body: '<!doctype html><input id="foreign-file" type="file">'})
      : route.abort());
  page = await context.newPage();
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  const tab = async () => ({id: 1, url: page.url(), title: "Picker fixture"});
  driver = createDriver({
      storage: chromeStorage(),
    debugger: {attach: async () => {}, detach: async () => {}, sendCommand: (_target, method, params) => {
      calls.push([method, structuredClone(params)]);
      return (async () => {
        if (adoptOnRelease && method === "DOM.setFileInputFiles") ownerAtSelection = await page.evaluate(() =>
          Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument').get.call(detachedInput) === document);
        if (adoptOnRelease && method === "Runtime.releaseObject") await page.evaluate(() =>
          document.implementation.createHTMLDocument('After release').adoptNode(detachedInput));
        const result = await cdp.send(method, params);
        // Deliver real input immediately but delay its acknowledgement, as can
        // happen in a background tab. The driver must not hold the button down.
        if (pressedAckDelay && method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
          await new Promise(resolve => setTimeout(resolve, pressedAckDelay));
        }
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") preflightHovered = true;
        const slowHover = preflightDelayStage === "hover" && method === "Input.dispatchMouseEvent" && params.type === "mouseMoved";
        const slowVerification = preflightDelayStage === "hit verification" && preflightHovered && method === "DOM.getNodeForLocation";
        if (slowHover || slowVerification) {
          preflightDelayStage = null;
          await new Promise(resolve => setTimeout(resolve, 5200));
        }
        return result;
      })();
    }},
    tabs: {get: tab},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    runtime: {connectNative: () => ({postMessage() {}, disconnect() {}, onMessage: {addListener() {}}, onDisconnect: {addListener() {}}})},
  });
  cdp.on("Page.fileChooserOpened", event => {
    chooserEvents.push(event);
    driver.onDebuggerEvent({tabId: 1}, "Page.fileChooserOpened", event);
  });
  await driver.attach(await tab());
  temporary = await mkdtemp(join(tmpdir(), "vids-picker-fixture-"));
  file = join(temporary, "фото-Саныча.txt");
  await writeFile(file, "Локальный файл: Саныч, сайты и микро-CRM.");
});

after(async () => {
  if (driver) await driver.detach();
  if (browser) await browser.close();
  if (temporary) await rm(temporary, {recursive: true, force: true});
});

function request(method, params = {}, id = `picker-${++nextId}`) {
  return driver.handleRequest({v: 2, type: "request", id, sessionId: driver.status().sessionId, method, params});
}

async function trigger(name) {
  const observation = await request("observe");
  assert.equal(observation.ok, true, JSON.stringify(observation.error));
  const node = observation.result.nodes.find(node => node.role === "button" && node.name === name);
  assert.ok(node);
  return {snapshotId: observation.result.snapshotId, nodeRef: node.ref};
}

test("a dynamically created hidden file input accepts only the supplied file via its observed trigger", async () => {
  const target = await trigger("Загрузить фото");
  assert.equal(await page.locator('input[type="file"]').count(), 0);
  const response = await request("upload_via_picker", {...target, files: [file]});
  assert.equal(response.ok, true, JSON.stringify(response.error));
  await page.waitForFunction(() => window.results.instant?.content);
  assert.deepEqual(await page.evaluate(() => results.instant), {
    name: "фото-Саныча.txt", content: "Локальный файл: Саныч, сайты и микро-CRM.",
  });
  assert.equal(chooserEvents.length, 1);
  assert.equal(Number.isInteger(chooserEvents[0].backendNodeId), true);
  assert.deepEqual(calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
  assert.equal((await request("upload_via_picker", {...target, files: [file]})).error.code, "STALE_SNAPSHOT");
});

test("the same picker flow accepts an observed coordinate trigger", async () => {
  const {snapshotId} = await trigger("Загрузить по координатам");
  const box = await page.getByRole("button", {name: "Загрузить по координатам", exact: true}).boundingBox();
  const response = await request("upload_via_picker", {snapshotId, x: box.x + box.width / 2, y: box.y + box.height / 2, files: [file]});
  assert.equal(response.ok, true, JSON.stringify(response.error));
  await page.waitForFunction(() => window.results.coordinate?.content);
  assert.equal(await page.evaluate(() => results.coordinate.name), "фото-Саныча.txt");
});

test("a Vids-style detached file input uploads without appearing in the document inventory", async () => {
  const target = await trigger("Отдельный input");
  const response = await request("upload_via_picker", {...target, files: [file]});
  assert.equal(response.ok, true, JSON.stringify(response.error));
  await page.waitForFunction(() => window.results.detached?.content);
  assert.equal(await page.locator('#detached').count(), 0);
  assert.deepEqual(await page.evaluate(() => ({connected: detachedInput.isConnected,
    sameDocument: detachedInput.ownerDocument === document, ...results.detached})), {
    connected: false, sameDocument: true, name: "фото-Саныча.txt", content: "Локальный файл: Саныч, сайты и микро-CRM.",
  });
  const tail = calls.slice(-3);
  assert.equal(tail[0][0], "DOM.setFileInputFiles");
  assert.deepEqual(tail[1], ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
  assert.equal(tail[2][0], "Runtime.releaseObject");
});

test("a delayed press acknowledgement does not expire an ordinary click's transient activation", async () => {
  const target = await trigger("Обычный клик");
  pressedAckDelay = 5200;
  let response;
  try { response = await request("click", target); }
  finally { pressedAckDelay = 0; }
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(await page.evaluate(() => results.clickActive), true);
});

test("a detached picker still uploads when the delivered press acknowledgement takes over five seconds", async () => {
  const target = await trigger("Отдельный input");
  const count = chooserEvents.length;
  await page.evaluate(() => { delete results.detached; });
  pressedAckDelay = 5200;
  let response;
  try { response = await request("upload_via_picker", {...target, files: [file]}); }
  finally { pressedAckDelay = 0; }
  assert.equal(response.ok, true, JSON.stringify(response.error));
  await page.waitForFunction(() => results.detached?.content);
  assert.equal(chooserEvents.length, count + 1);
  assert.deepEqual(await page.evaluate(() => results.detached), {
    name: "фото-Саныча.txt", content: "Локальный файл: Саныч, сайты и микро-CRM.",
  });
});

for (const stage of ["hover", "hit verification"]) {
  test(`a real detached chooser uploads after ${stage} takes over five seconds`, async () => {
    const target = await trigger("Отдельный input");
    const count = chooserEvents.length;
    await page.evaluate(() => { delete results.detached; });
    preflightHovered = false;
    preflightDelayStage = stage;
    let response;
    try { response = await request("upload_via_picker", {...target, files: [file]}); }
    finally { preflightDelayStage = null; preflightHovered = false; }
    assert.equal(response.ok, true, JSON.stringify(response.error));
    await page.waitForFunction(() => results.detached?.content);
    assert.equal(chooserEvents.length, count + 1);
    assert.equal(await page.evaluate(() => results.detached.content), "Локальный файл: Саныч, сайты и микро-CRM.");
    assert.deepEqual(calls.at(-2), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
    assert.equal(calls.at(-1)[0], "Runtime.releaseObject");
  });
}

test("detached-input cleanup adds no CDP round trip between identity verification and file selection", async () => {
  const target = await trigger("Отдельный input");
  ownerAtSelection = null;
  adoptOnRelease = true;
  let response;
  try { response = await request("upload_via_picker", {...target, files: [file]}); }
  finally { adoptOnRelease = false; }
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(ownerAtSelection, true, 'input still belongs to the approved document when the file is granted');
  assert.equal(await page.evaluate(() => Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument').get.call(detachedInput) === document), false,
    'the fixture moves the input during cleanup, after selection');
});

test("a detached input adopted into another document is rejected despite a spoofed ownerDocument property", async () => {
  const target = await trigger("Сменивший документ input");
  const writes = calls.filter(([method]) => method === "DOM.setFileInputFiles").length;
  const response = await request("upload_via_picker", {...target, files: [file]});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "FILE_CHOOSER_MISMATCH");
  // Chromium may refuse the cross-document wrapper at resolveNode, before
  // the identity predicate can return false. Both must deny the file transfer.
  assert.match(response.error.message, /owner_document_(mismatch|unverified)/);
  assert.equal(await page.evaluate(() => adoptedInput.ownerDocument === document), true, 'page spoof is active');
  assert.equal(await page.evaluate(() => Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument').get.call(adoptedInput) === document), false);
  assert.equal(await page.evaluate(() => adoptedInput.files.length), 0);
  assert.equal(calls.filter(([method]) => method === "DOM.setFileInputFiles").length, writes);
  assert.deepEqual(calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
});

test("a cross-origin OOPIF file input is rejected before any input or picker arming", async () => {
  const {snapshotId} = await trigger("Загрузить фото");
  const box = await page.frameLocator("#foreign").locator("#foreign-file").boundingBox();
  assert.ok(box);
  const start = calls.length;
  const events = chooserEvents.length;
  const response = await request("upload_via_picker", {
    snapshotId, x: box.x + 20, y: box.y + box.height / 2, files: [file],
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "FILE_CHOOSER_MISMATCH");
  const operationCalls = calls.slice(start);
  assert.equal(operationCalls.some(([method]) => method === "Input.dispatchMouseEvent" || method === "DOM.setFileInputFiles"), false);
  assert.equal(operationCalls.some(([method, params]) => method === "Page.setInterceptFileChooserDialog" && params.cancel === false), false);
  assert.equal(chooserEvents.length, events);
});

test("a delayed chooser after the deadline is canceled by Chromium instead of reaching native selection", async context => {
  const target = await trigger("Отложенная загрузка");
  const originalTimeout = globalThis.setTimeout;
  // Shorten only the driver's chooser deadline; the real page's 150 ms
  // delayed click and Chromium event handling still run on real clocks.
  context.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => originalTimeout(callback, ms === 5000 ? 30 : ms, ...args));
  const eventCount = chooserEvents.length;
  const fileWrites = calls.filter(([method]) => method === "DOM.setFileInputFiles").length;
  const response = await request("upload_via_picker", {...target, files: [file]});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "FILE_CHOOSER_TIMEOUT");
  assert.equal(response.error.outcome, "unknown");
  await page.waitForFunction(() => window.results.delayed?.canceled === true);
  assert.equal(await page.locator("#delayed").evaluate(input => input.files.length), 0);
  // Chrome still reports the intercepted request, and also dispatches the
  // input's cancel event. The finished operation must ignore that late event.
  assert.equal(chooserEvents.length, eventCount + 1);
  assert.equal(calls.filter(([method]) => method === "DOM.setFileInputFiles").length, fileWrites);
  assert.equal(calls.some(([method, params]) => method === "Page.setInterceptFileChooserDialog" && params.enabled === false), false);
  assert.deepEqual(calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
});
