import {chromeStorage} from '../tests/chrome-storage.mjs';
import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {chromium} from "playwright";
import {createDriver} from "./driver.js";

// Every request is fulfilled locally; no Google service, profile or document.
const url = "https://docs.google.com/videos/d/iframe_fixture_only/edit";
const origin = "https://docs.google.com";
let browser, page, driver, nested, sibling;
let nextId = 0;

before(async () => {
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext();
  await context.route("**/*", route => {
    const requestUrl = route.request().url();
    const pages = {
      [url]: `<!doctype html><button id="outside">Outside editor</button>
        <iframe id="outer" title="Outer frame" src="/frame-outer"></iframe>
        <iframe id="sibling" title="Other frame" src="/frame-sibling"></iframe>
        <iframe title="Foreign frame" src="https://example.org/frame"></iframe>
        <iframe id="blank" class="docs-texteventtarget-iframe" style="position:absolute;top:-100px;width:1px;height:1px"></iframe>
        <iframe id="opaque" sandbox="" srcdoc="<div contenteditable=true role=textbox aria-label='Opaque editor'>Opaque content</div>"></iframe>
        <script>document.getElementById('blank').contentDocument.body.innerHTML = '<div id="blank-editor" contenteditable="true" role="textbox" aria-label="Blank document editor">Title</div><input id="blank-password" type="password" value="blank-private-value">';</script>`,
      [`${origin}/frame-outer`]: '<!doctype html><iframe id="inner" title="Inner frame" src="/frame-inner"></iframe>',
      [`${origin}/frame-inner`]: '<!doctype html><textarea id="editor" aria-label="Nested editor"></textarea><div id="rich" contenteditable="true" role="textbox" aria-label="Nested rich text"></div><input id="password" aria-label="Nested password" type="password" value="never-expose-this">',
      [`${origin}/frame-sibling`]: '<!doctype html><textarea id="sibling-editor" aria-label="Sibling editor">Keep me</textarea>',
      "https://example.org/frame": '<!doctype html><textarea aria-label="Foreign editor">Foreign data</textarea><input type="file" aria-label="Foreign upload">',
    };
    if (!Object.hasOwn(pages, requestUrl)) return route.abort();
    return route.fulfill({contentType: "text/html; charset=utf-8", body: pages[requestUrl]});
  });
  page = await context.newPage();
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  const tab = async () => ({id: 1, url: page.url(), title: "Iframe fixture"});
  driver = createDriver({
      storage: chromeStorage(),
    debugger: {attach: async () => {}, detach: async () => {}, sendCommand: (_target, method, params) => cdp.send(method, params)},
    tabs: {get: tab},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    runtime: {connectNative: () => ({postMessage() {}, disconnect() {}, onMessage: {addListener() {}}, onDisconnect: {addListener() {}}})},
  });
  await driver.attach(await tab());
  nested = page.frameLocator("#outer").frameLocator("#inner");
  sibling = page.frameLocator("#sibling");
});

after(async () => {
  if (driver) await driver.detach();
  if (browser) await browser.close();
});

async function request(method, params = {}) {
  return driver.handleRequest({v: 2, type: "request", id: `iframe-${++nextId}`, sessionId: driver.status().sessionId, method, params});
}

async function observe(params = {}) {
  const response = await request("observe", params);
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result;
}

test("observe includes bounded same-origin child AX trees and redacts nested passwords", async () => {
  const snapshot = await observe();
  assert.ok(snapshot.nodes.some(node => node.name === "Nested editor"));
  const password = snapshot.nodes.find(node => node.name === "Nested password");
  assert.equal(password.value, "[redacted]");
  assert.equal(password.states.protected, true);
  assert.equal(JSON.stringify(snapshot).includes("never-expose-this"), false);
  assert.equal(snapshot.nodes.some(node => node.name === "Foreign editor" || node.name === "Foreign upload"), false);
});

test("Unicode insertion follows actual nested focus and leaves sibling selection untouched", async () => {
  await sibling.locator("#sibling-editor").focus();
  await nested.locator("#editor").focus();
  const snapshot = await observe();
  const text = "Русский текст во вложенной сцене — ёж 🦔";
  const response = await request("type_text", {snapshotId: snapshot.snapshotId, text});
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(await nested.locator("#editor").inputValue(), text);
  assert.equal(await sibling.locator("#sibling-editor").inputValue(), "Keep me");
});

test("observed nested rich-text reference can explicitly focus the editor", async () => {
  await page.locator("#outside").focus();
  const snapshot = await observe();
  const editor = snapshot.nodes.find(node => node.name === "Nested rich text");
  const response = await request("type_text", {snapshotId: snapshot.snapshotId, nodeRef: editor.ref, text: "Заголовок сцены"});
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(await nested.locator("#rich").innerText(), "Заголовок сцены");
});

test("a remembered child edit selection does not authorize typing when parent button is focused", async () => {
  await nested.locator("#editor").focus();
  await page.locator("#outside").focus();
  const before = await nested.locator("#editor").inputValue();
  const snapshot = await observe();
  const response = await request("type_text", {snapshotId: snapshot.snapshotId, text: "must not be typed"});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "FOCUS_NOT_EDITABLE");
  assert.equal(await nested.locator("#editor").inputValue(), before);
});

test("a focused nested password remains excluded without a node reference", async () => {
  await nested.locator("#password").focus();
  const snapshot = await observe();
  const response = await request("type_text", {snapshotId: snapshot.snapshotId, text: "must not be typed"});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "PROTECTED_FIELD");
  assert.equal(await nested.locator("#password").inputValue(), "never-expose-this");
});

test("offscreen inherited about:blank editor accepts Russian replacement like the live Vids transport", async () => {
  const blank = page.frameLocator("#blank");
  await blank.locator("#blank-editor").focus();
  const snapshot = await observe({diagnostics: true});
  const frame = snapshot.frameDiagnostics.frames.find(frame => frame.ownerClass === "docs-texteventtarget-iframe");
  assert.equal(frame.urlKind, "about:blank");
  assert.equal(frame.securityOrigin, "://");
  assert.equal(frame.inspected, true);
  assert.equal(frame.originMode, "inherited_blank_document");
  const response = await request("type_text", {snapshotId: snapshot.snapshotId, text: "Русский заголовок — проверено", replace: true});
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(await blank.locator("#blank-editor").innerText(), "Русский заголовок — проверено");
  assert.equal(await sibling.locator("#sibling-editor").inputValue(), "Keep me");
});

test("sandboxed blank-origin editor stays excluded and frame diagnostics are optional", async () => {
  const snapshot = await observe({diagnostics: true});
  const opaque = snapshot.frameDiagnostics.frames.find(frame => frame.urlKind === "about:srcdoc");
  assert.equal(opaque.inspected, false);
  assert.equal(opaque.skippedReason, "security_origin_mismatch");
  assert.equal(snapshot.nodes.some(node => node.name === "Opaque editor"), false);
  assert.equal(Object.hasOwn(await observe(), "frameDiagnostics"), false);
});

test("password in the inherited blank transport remains protected", async () => {
  const blank = page.frameLocator("#blank");
  await blank.locator("#blank-password").focus();
  const snapshot = await observe();
  assert.equal(JSON.stringify(snapshot).includes("blank-private-value"), false);
  const response = await request("type_text", {snapshotId: snapshot.snapshotId, text: "should not type"});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "PROTECTED_FIELD");
  assert.equal(await blank.locator("#blank-password").inputValue(), "blank-private-value");
});
