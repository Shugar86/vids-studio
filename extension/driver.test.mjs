import {chromeStorage} from '../tests/chrome-storage.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import {createDriver, HOST_NAME} from "./driver.js";
import {PROFILE} from "./profile.js";

function fixture({exportMenu = false} = {}) {
  const tab = {id: 7, url: "https://docs.google.com/videos/d/fixture/edit", title: "Fixture video"};
  const calls = [];
  const nativeMessages = [];
  const callbacks = {};
  let value = "";
  let focusedId = 2;
  const dom = {
    1: {backendNodeId: 1, nodeName: "#document"},
    2: {backendNodeId: 2, nodeName: "TEXTAREA", attributes: []},
    3: {backendNodeId: 3, nodeName: "INPUT", attributes: ["type", "password"]},
    4: {backendNodeId: 4, nodeName: "INPUT", attributes: ["type", "file"]},
    5: {backendNodeId: 5, nodeName: "BUTTON", attributes: []},
  };
  dom[1].children = [dom[2], dom[3], dom[4], dom[5]];
  function axNodes() {
    return [
      {nodeId: "1", backendDOMNodeId: 1, role: {value: "RootWebArea"}, name: {value: "Fixture"}},
      {nodeId: "2", backendDOMNodeId: 2, parentId: "1", role: {value: "textbox"}, name: {value: "Caption"}, value: {value},
        properties: [{name: "focused", value: {value: focusedId === 2}}, {name: "editable", value: {value: "plaintext"}}]},
      {nodeId: "3", backendDOMNodeId: 3, parentId: "1", role: {value: "textbox"}, name: {value: "Password"}, value: {value: "private-secret"},
        properties: [{name: "focused", value: {value: focusedId === 3}}, {name: "editable", value: {value: "plaintext"}}]},
      {nodeId: "5", backendDOMNodeId: 5, parentId: "1", role: {value: exportMenu ? "menuitem" : "button"}, name: {value: exportMenu ? "MP4 video (.mp4) d" : "Add scene"}},
    ];
  }
  const api = {
    storage: chromeStorage(),
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    tabs: {get: async () => tab},
    runtime: {connectNative: name => {
      assert.equal(name, HOST_NAME);
      return {
        onMessage: {addListener: callback => { callbacks.message = callback; }},
        onDisconnect: {addListener: callback => { callbacks.disconnect = callback; }},
        postMessage: message => nativeMessages.push(message),
        disconnect: () => {},
      };
    }},
    debugger: {
      attach: async (...args) => { calls.push(["attach", ...args]); },
      detach: async (...args) => { calls.push(["detach", ...args]); },
      sendCommand: async (_target, method, params) => {
        calls.push([method, params]);
        if (method === "Page.getFrameTree") return {frameTree: {frame: {id: "main", url: tab.url}}};
        if (method === "Page.getLayoutMetrics") return {cssVisualViewport: {clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0}};
        if (method === "Accessibility.getFullAXTree") return {nodes: axNodes()};
        if (method === "Accessibility.getPartialAXTree") return {nodes: axNodes().filter(node => node.backendDOMNodeId === params.backendNodeId)};
        if (method === "DOM.getDocument") return {root: dom[1]};
        if (method === "DOM.describeNode") return {node: dom[params.backendNodeId]};
        if (method === "DOM.getContentQuads") return {quads: [[10, 10, 100, 10, 100, 40, 10, 40]]};
        if (method === "DOM.getNodeForLocation") return {backendNodeId: 5, frameId: "main"};
        if (method === "DOM.focus") focusedId = params.backendNodeId;
        if (method === "Input.insertText") value += params.text;
        return {};
      },
    },
  };
  const driver = createDriver(api);
  let nextId = 0;
  const request = (method, params = {}, overrides = {}) => driver.handleRequest({
    v: 2, type: "request", id: String(++nextId), sessionId: driver.status().sessionId,
    method, params, ...overrides,
  });
  return {driver, tab, calls, api, callbacks, nativeMessages, request, get value() { return value; }};
}

function holdNextCommand(f, command, matches = () => true) {
  const original = f.api.debugger.sendCommand;
  let acknowledge, reject, notifySent, held = false;
  const reply = new Promise((resolve, fail) => { acknowledge = resolve; reject = fail; });
  const sent = new Promise(resolve => { notifySent = resolve; });
  f.api.debugger.sendCommand = async (target, method, params) => {
    const result = await original(target, method, params);
    if (!held && method === command && matches(params)) {
      held = true;
      notifySent();
      return reply;
    }
    return result;
  };
  return {sent, acknowledge, reject};
}

function screencastFrame(f, {sessionId = 1, timestamp = Date.now() / 1000, data = "ZnJlc2g=", source} = {}) {
  f.driver.onDebuggerEvent(source ?? {tabId: f.tab.id}, "Page.screencastFrame", {
    sessionId, data, metadata: {timestamp, deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1},
  });
}

function screenshotBitmap(context) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const decode = context.mock.fn(async () => ({width: 1600, height: 1200, close() {}}));
  Object.defineProperty(globalThis, "createImageBitmap", {configurable: true, writable: true, value: decode});
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, "createImageBitmap", previous);
    else delete globalThis.createImageBitmap;
  });
  return decode;
}

function persistentStorage(f) {
  const data = {};
  f.api.storage = {local: {
    get: async key => ({[key]: structuredClone(data[key])}),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async key => { delete data[key]; },
  }};
  return data;
}

test("runtime identifies the loaded build and legacy requests cannot dispatch", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  assert.deepEqual(f.driver.status().runtime.extension, {
    version: PROFILE.version, buildId: PROFILE.buildId, profileId: PROFILE.id, protocol: 2,
  });
  const before = f.calls.length;
  assert.equal((await f.request("observe", {}, {v: 1})).error.code, "INVALID_REQUEST");
  assert.equal(f.calls.length, before);
});

test("export cannot trigger without fresh automatic-save evidence or an observed MP4 target", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const observed = (await f.request('observe')).result;
  const params = {jobId: 'job-export-guard', nodeRef: observed.nodes.find(node => node.name === 'Add scene').ref,
    snapshotId: observed.snapshotId, automaticDownloadConfirmed: true, downloadModeCheckedAt: new Date().toISOString()};
  assert.equal((await f.request('export_trigger', {...params, automaticDownloadConfirmed: false})).error.code, 'AUTOMATIC_DOWNLOAD_REQUIRED');
  assert.equal((await f.request('export_trigger', {...params, downloadModeCheckedAt: new Date(Date.now() - 901000).toISOString()})).error.code, 'AUTOMATIC_DOWNLOAD_REQUIRED');
  assert.equal((await f.request('export_trigger', params)).error.code, 'EXPORT_TARGET_MISMATCH');
  assert.equal(f.calls.some(call => call[0].startsWith('Input.')), false);
});

test("guarded export binds a fresh MP4 click to its frame and exact download record", async () => {
  const f = fixture({exportMenu: true});
  let created, changed;
  const searches = [];
  const url = 'https://example.invalid/only-this-export.mp4';
  f.api.downloads = {
    onCreated: {addListener: callback => { created = callback; }},
    onChanged: {addListener: callback => { changed = callback; }},
    search: async query => { searches.push(query); return [{id: 51, url, state: 'complete', exists: true, filename: '/tmp/verified-export.mp4'}]; },
  };
  // The real extension installs the download listeners when its driver starts.
  const driver = createDriver(f.api);
  await driver.attach(f.tab);
  const sessionId = driver.status().sessionId;
  let requestId = 0;
  const request = (method, params = {}, session = sessionId) => driver.handleRequest({v: 2, type: 'request', id: `export-${++requestId}`, sessionId: session, method, params});
  const observed = (await request('observe')).result;
  const params = {jobId: 'job-export-real-guard', nodeRef: observed.nodes.find(node => node.name.startsWith('MP4')).ref,
    snapshotId: observed.snapshotId, automaticDownloadConfirmed: true, downloadModeCheckedAt: new Date().toISOString()};
  const beforeCommands = f.calls.length;
  assert.deepEqual((await request('export_preflight')).result, {sessionId, documentId: 'fixture', exportWatch: null});
  assert.equal(f.calls.length, beforeCommands, 'Preflight must not dispatch CDP');
  assert.equal((await request('export_trigger', params)).ok, true);
  const pending = (await request('export_preflight')).result;
  assert.equal(pending.exportWatch.state, 'armed');
  assert.equal(pending.exportWatch.triggerOutcome, 'performed');
  assert.equal(pending.sessionId, sessionId);
  assert.equal((await request('export_preflight', {}, 'foreign-session')).error.code, 'SESSION_MISMATCH');
  created({id: 999, url: 'https://unrelated.invalid/export.mp4', startTime: new Date().toISOString()});
  driver.onDebuggerEvent({tabId: f.tab.id}, 'Page.downloadWillBegin', {frameId: 'main', guid: 'export-guid', url, suggestedFilename: 'export.mp4'});
  created({id: 51, url, referrer: f.tab.url, startTime: new Date().toISOString()});
  changed({id: 51, state: {current: 'complete'}});
  driver.onDebuggerEvent({tabId: f.tab.id}, 'Page.downloadProgress', {guid: 'export-guid', state: 'completed'});
  const finished = await request('export_download_status', {jobId: params.jobId});
  assert.equal(finished.result.filename, '/tmp/verified-export.mp4');
  assert.equal(finished.result.downloadId, 51);
  assert.equal(finished.result.triggerOutcome, 'performed');
  assert.deepEqual(searches, [{id: 51}]);
  await driver.detach();
  assert.equal((await request('export_download_status', {jobId: params.jobId})).error.code, 'NOT_ATTACHED');
});

test("fresh export preflight bypasses a held CDP read without invalidating its snapshot", async () => {
  const f = fixture(); await f.driver.attach(f.tab);
  const held = holdNextCommand(f, "Accessibility.getFullAXTree");
  const observe = f.request("observe"); await held.sent;
  const commands = f.calls.length;
  const response = await Promise.race([f.request("export_preflight"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Preflight queued behind CDP")), 500))]);
  assert.equal(response.ok, true); assert.equal(response.result.exportWatch, null);
  assert.equal(f.calls.length, commands);
  held.acknowledge({nodes: []}); assert.equal((await observe).ok, true);
  await f.driver.detach();
});

test("missing durable storage rejects attachment before any debugger command", async () => {
  const f = fixture();
  delete f.api.storage;
  await assert.rejects(f.driver.attach(f.tab), {code: 'STORAGE_REQUIRED'});
  assert.equal(f.calls.length, 0);
  assert.equal(f.nativeMessages.length, 0);
});

test("attachment waits for background rendering before advertising the session", async () => {
  const f = fixture();
  const pending = holdNextCommand(f, 'Emulation.setFocusEmulationEnabled');
  const attaching = f.driver.attach(f.tab);
  await pending.sent;
  assert.deepEqual(f.calls.find(([method]) => method === 'Emulation.setFocusEmulationEnabled'),
    ['Emulation.setFocusEmulationEnabled', {enabled: true}]);
  assert.equal(f.nativeMessages.length, 0, 'the bridge must not advertise an unprepared renderer');
  pending.acknowledge({});
  await attaching;
  assert.equal(f.nativeMessages[0].type, 'hello');
  assert.equal(f.driver.status().attached, true);
  await f.driver.detach();
});

test("unsupported background rendering fails attachment and detaches before native connection", async () => {
  const f = fixture();
  const stored = persistentStorage(f);
  const original = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, params) => {
    if (method === 'Emulation.setFocusEmulationEnabled') throw new Error('Focus emulation unavailable');
    return original(target, method, params);
  };
  await assert.rejects(f.driver.attach(f.tab), /Focus emulation unavailable/);
  assert.equal(f.driver.status().attached, false);
  assert.equal(f.calls.filter(([method]) => method === 'detach').length, 1);
  assert.equal(f.nativeMessages.length, 0);
  assert.equal(stored.vidsStudioActiveBindingsV2, undefined);
  assert.equal(f.calls.some(([method]) => method.startsWith('Input.')), false);
});

test("concurrent attachment cannot pass an awaited detach; explicit disconnect cancels the waiting generation", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  let finishDetach;
  f.api.debugger.detach = () => new Promise(resolve => { finishDetach = resolve; });
  const first = f.driver.attach(f.tab);
  await assert.rejects(f.driver.attach({...f.tab, id: 8}), {code: 'BUSY'});
  await f.driver.detach();
  finishDetach();
  await assert.rejects(first, {code: 'NOT_ATTACHED'});
  assert.equal(f.calls.filter(call => call[0] === 'attach').length, 1);
  assert.equal(f.driver.status().attached, false);
});

test("revocation precedes detach, but durable fence is published only after detach succeeds", async () => {
  const f = fixture();
  const stored = persistentStorage(f);
  await f.driver.attach(f.tab);
  const sessionId = f.driver.status().sessionId;
  assert.equal(stored.vidsStudioActiveBindingsV2[0].sessionId, sessionId);
  let finishDetach;
  f.api.debugger.detach = () => new Promise(resolve => { finishDetach = resolve; });
  const pending = f.driver.detach();
  assert.equal(f.driver.status().attached, false);
  assert.equal(stored.vidsStudioFencesV1, undefined);
  assert.equal(f.nativeMessages.some(item => item.event === "detached"), false);
  assert.equal((await f.request("observe", {}, {sessionId})).error.code, "NOT_ATTACHED");
  finishDetach();
  await pending;
  assert.equal(stored.vidsStudioActiveBindingsV2, undefined);
  assert.equal(stored.vidsStudioFencesV1[0].sessionId, sessionId);
  assert.equal(stored.vidsStudioFencesV1[0].fenced, true);
  assert.equal(f.nativeMessages.at(-1).fenceReceipts[0].sessionId, sessionId);
});

test("failed detach retains the binding and blocks explicit reattachment on unrelated errors", async () => {
  const f = fixture();
  const stored = persistentStorage(f);
  await f.driver.attach(f.tab);
  const sessionId = f.driver.status().sessionId;
  f.api.debugger.detach = async () => { throw new Error("Permission denied"); };
  await f.driver.detach();
  assert.equal(stored.vidsStudioFencesV1, undefined);
  assert.equal(stored.vidsStudioActiveBindingsV2[0].sessionId, sessionId);
  const attaches = f.calls.filter(call => call[0] === "attach").length;
  await assert.rejects(f.driver.attach(f.tab), /Could not fence/);
  assert.equal(f.calls.filter(call => call[0] === "attach").length, attaches);
  f.api.debugger.detach = async () => { throw new Error(`Debugger is not attached to the tab with id: ${f.tab.id}.`); };
  await f.driver.attach(f.tab);
  assert.notEqual(f.driver.status().sessionId, sessionId);
  const hello = f.nativeMessages.filter(item => item.type === "hello").at(-1);
  assert.equal(hello.fenceReceipts[0].sessionId, sessionId);
  assert.equal(f.calls.some(call => call[0].startsWith("Input.")), false);
});

test("driver cannot attach other Google products or act without a session", async () => {
  const f = fixture();
  await assert.rejects(() => f.driver.attach({...f.tab, url: "https://docs.google.com/presentation/d/abc/edit"}), {code: "WRONG_PAGE"});
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request("observe")).error.code, "NOT_ATTACHED");
  assert.equal((await f.request("status")).result.attached, false);
});

test("observe redacts passwords and exposes hidden file controls without hidden values", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const response = await f.request("observe");
  assert.equal(response.ok, true);
  const password = response.result.nodes.find(node => node.name === "Password");
  assert.equal(password.value, "[redacted]");
  assert.equal(password.states.protected, true);
  assert.ok(response.result.nodes.some(node => node.role === "file-input"));
  assert.equal(JSON.stringify(response).includes("private-secret"), false);
  assert.equal(f.nativeMessages[0].type, "hello");
});

test("Unicode uses CDP insertion, action invalidates snapshot, repeated request does not retype", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const observed = (await f.request("observe")).result;
  const editor = observed.nodes.find(node => node.name === "Caption");
  const envelope = {
    v: 2, type: "request", id: "unique-input", sessionId: f.driver.status().sessionId,
    method: "type_text", params: {snapshotId: observed.snapshotId, nodeRef: editor.ref, text: "Русский текст — ёж 🦔"},
  };
  const response = await f.driver.handleRequest(envelope);
  assert.deepEqual(response.result, {performed: true, needsObservation: true});
  assert.equal(f.value, "Русский текст — ёж 🦔");
  assert.equal((await f.driver.handleRequest(envelope)).ok, true);
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
  assert.equal((await f.request("click", {snapshotId: observed.snapshotId, x: 20, y: 20})).error.code, "STALE_SNAPSHOT");
});

test("changed document revokes session before any input; wrong session rejected", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  assert.equal((await f.request("observe", {}, {sessionId: "other"})).error.code, "SESSION_MISMATCH");
  const snapshotId = (await f.request("observe")).result.snapshotId;
  f.tab.url = "https://docs.google.com/videos/d/different/edit";
  const response = await f.request("click", {snapshotId, x: 20, y: 20});
  assert.equal(response.error.code, "DOCUMENT_CHANGED");
  assert.equal(f.driver.status().attached, false);
  assert.equal(f.calls.some(([method]) => method === "Input.dispatchMouseEvent"), false);
});

test("password typing denied and upload requires a real observed file input", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  let observed = (await f.request("observe")).result;
  let password = observed.nodes.find(node => node.name === "Password");
  assert.equal((await f.request("type_text", {snapshotId: observed.snapshotId, nodeRef: password.ref, text: "secret"})).error.code, "PROTECTED_FIELD");
  assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false);
  observed = (await f.request("observe")).result;
  const input = observed.nodes.find(node => node.role === "file-input");
  assert.equal((await f.request("upload", {snapshotId: observed.snapshotId, nodeRef: input.ref, files: ["relative.mp4"]})).error.code, "INVALID_ARGUMENT");
  observed = (await f.request("observe")).result;
  assert.equal((await f.request("upload", {snapshotId: observed.snapshotId, nodeRef: input.ref, files: ["/tmp/approved.mp4"]})).ok, true);
  assert.equal(f.calls.filter(([method]) => method === "DOM.setFileInputFiles").length, 1);
});

test("navigation invalidates observations; native host disconnect revokes attachment", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const snapshotId = (await f.request("observe")).result.snapshotId;
  f.driver.onDebuggerEvent({tabId: f.tab.id}, "DOM.documentUpdated");
  assert.equal((await f.request("press_key", {snapshotId, key: "Enter"})).error.code, "STALE_SNAPSHOT");
  f.callbacks.disconnect();
  assert.equal(f.driver.status().attached, false);
});

test("uncertain key and pointer failures still release the input", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const original = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, params) => {
    const result = await original(target, method, params);
    if ((method === "Input.dispatchKeyEvent" && params.type === "keyDown") ||
        (method === "Input.dispatchMouseEvent" && params.type === "mousePressed")) {
      throw new Error("Simulated response failure after input dispatch");
    }
    return result;
  };
  let snapshotId = (await f.request("observe")).result.snapshotId;
  let response = await f.request("press_key", {snapshotId, key: "ArrowRight", modifiers: ["Control"]});
  assert.equal(response.ok, false);
  assert.equal(response.error.outcome, "unknown");
  assert.ok(f.calls.some(([method, params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp"));
  snapshotId = (await f.request("observe")).result.snapshotId;
  response = await f.request("click", {snapshotId, x: 20, y: 20});
  assert.equal(response.ok, false);
  assert.ok(f.calls.some(([method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"));
});

test("click waits for release acknowledgement even when the press acknowledgement rejects", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const snapshotId = (await f.request("observe")).result.snapshotId;
  const original = f.api.debugger.sendCommand;
  let acknowledgeRelease;
  const releaseAck = new Promise(resolve => { acknowledgeRelease = resolve; });
  f.api.debugger.sendCommand = async (target, method, params) => {
    const result = await original(target, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") throw new Error("Press ACK lost");
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") await releaseAck;
    return result;
  };
  let settled = false;
  const pending = f.request("click", {snapshotId, x: 20, y: 20}).then(response => { settled = true; return response; });
  await new Promise(setImmediate);
  assert.equal(f.calls.some(([method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"), true);
  assert.equal(settled, false, "do not free the action queue while release is unsettled");
  acknowledgeRelease();
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.outcome, "unknown");
  assert.match(response.error.message, /Press ACK lost/);
});

test("a rejected release acknowledgement remains an unknown click outcome", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const snapshotId = (await f.request("observe")).result.snapshotId;
  const original = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, params) => {
    const result = await original(target, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") throw new Error("Release ACK lost");
    return result;
  };
  const response = await f.request("click", {snapshotId, x: 20, y: 20});
  assert.equal(response.ok, false);
  assert.equal(response.error.outcome, "unknown");
  assert.match(response.error.message, /Release ACK lost/);
});

test("revocation during press dispatch prevents release and the second click", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const snapshotId = (await f.request("observe")).result.snapshotId;
  const original = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = (target, method, params) => {
    const result = original(target, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
      // Revocation is synchronous before detach's first await.
      void f.driver.detach();
      return Promise.reject(new Error("Press ACK lost after revoke"));
    }
    return result;
  };
  const response = await f.request("click", {snapshotId, x: 20, y: 20, clickCount: 2});
  assert.equal(response.ok, false);
  assert.equal(response.error.outcome, "unknown");
  assert.equal(f.driver.status().attached, false);
  const input = f.calls.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, params]) => params.type);
  assert.deepEqual(input, ["mouseMoved", "mousePressed"]);
});

test("drag releases after a move failure and waits for the release acknowledgement", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const snapshotId = (await f.request("observe")).result.snapshotId;
  const original = f.api.debugger.sendCommand;
  let acknowledgeRelease, reportRelease;
  const releaseAck = new Promise(resolve => { acknowledgeRelease = resolve; });
  const releaseSent = new Promise(resolve => { reportRelease = resolve; });
  f.api.debugger.sendCommand = async (target, method, params) => {
    const result = await original(target, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.buttons === 1) throw new Error("Move ACK lost");
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      reportRelease();
      await releaseAck;
    }
    return result;
  };
  let settled = false;
  const pending = f.request("drag", {snapshotId, from: {x: 20, y: 20}, to: {x: 120, y: 20}, steps: 15})
    .then(response => { settled = true; return response; });
  await releaseSent;
  assert.equal(f.calls.some(([method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"), true);
  assert.equal(settled, false);
  acknowledgeRelease();
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.outcome, "unknown");
  assert.match(response.error.message, /Move ACK lost/);
});

test("a rejected drag release acknowledgement remains unknown", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const snapshotId = (await f.request("observe")).result.snapshotId;
  const original = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, params) => {
    const result = await original(target, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") throw new Error("Drag release ACK lost");
    return result;
  };
  const response = await f.request("drag", {snapshotId, from: {x: 20, y: 20}, to: {x: 120, y: 20}, steps: 15});
  assert.equal(response.ok, false);
  assert.equal(response.error.outcome, "unknown");
  assert.match(response.error.message, /Drag release ACK lost/);
});

test("drag revocation during dispatch stops later input and drains pending acknowledgements", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const snapshotId = (await f.request("observe")).result.snapshotId;
  const original = f.api.debugger.sendCommand;
  let acknowledgePress, reportRevocation;
  const pressedAck = new Promise(resolve => { acknowledgePress = resolve; });
  const revoked = new Promise(resolve => { reportRevocation = resolve; });
  f.api.debugger.sendCommand = (target, method, params) => {
    const result = original(target, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") return result.then(async value => { await pressedAck; return value; });
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.buttons === 1) {
      void f.driver.detach();
      reportRevocation();
    }
    return result;
  };
  let settled = false;
  const pending = f.request("drag", {snapshotId, from: {x: 20, y: 20}, to: {x: 120, y: 20}, steps: 15})
    .then(response => { settled = true; return response; });
  await revoked;
  assert.equal(f.driver.status().attached, false);
  assert.equal(settled, false);
  const input = f.calls.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, params]) => params.type);
  assert.deepEqual(input, ["mouseMoved", "mousePressed", "mouseMoved"]);
  acknowledgePress();
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.outcome, "unknown");
});

test("a stalled CDP command expires, revokes attachment and frees the request queue", async context => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const original = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree") return new Promise(() => {});
    return original(target, method, params);
  };
  context.mock.timers.enable({apis: ["setTimeout"]});
  const pending = f.request("observe");
  await new Promise(setImmediate);
  context.mock.timers.tick(10001);
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "BROWSER_TIMEOUT");
  assert.equal(f.driver.status().attached, false);
  assert.equal((await f.request("status")).result.attached, false);
});

test("one-shot screenshot ignores old or foreign frames and returns only fresh pixels with CSS scale", async context => {
  const f = fixture();
  const decode = screenshotBitmap(context);
  await f.driver.attach(f.tab);
  const pending = f.request("screenshot", {format: "jpeg", quality: 45});
  await new Promise(setImmediate);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  const start = f.calls.find(([method]) => method === "Page.startScreencast")[1];
  assert.equal(start.format, "jpeg");
  assert.equal(start.quality, 45);
  screencastFrame(f, {sessionId: 20, source: {tabId: f.tab.id + 1}});
  screencastFrame(f, {sessionId: 21, source: {tabId: f.tab.id, sessionId: "foreign-frame"}});
  screencastFrame(f, {sessionId: 22, timestamp: Date.now() / 1000 - 60, data: "b2xk"});
  screencastFrame(f, {sessionId: 23, timestamp: null, data: "b2xk"});
  await new Promise(setImmediate);
  assert.equal(decode.mock.calls.length, 0, "old and undated pixels must not become evidence");
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.screencastFrameAck").map(([, params]) => params.sessionId), [22, 23],
    "stale frames from this stream must be acknowledged so fresh frames can arrive");
  assert.equal(f.calls.some(([method]) => method === "Page.stopScreencast"), false);
  screencastFrame(f, {sessionId: 24});
  const response = await pending;
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.result.data, "ZnJlc2g=");
  assert.equal(response.result.mimeType, "image/jpeg");
  assert.deepEqual(response.result.image, {width: 1600, height: 1200, scaleX: 2, scaleY: 2});
  assert.equal(response.result.coordinateSpace, "css-viewport");
  assert.ok(response.result.snapshotId);
  assert.equal(decode.mock.calls.length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.stopScreencast").length, 1);
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.screencastFrameAck").map(([, params]) => params.sessionId), [22, 23, 24]);
  const calls = f.calls.length;
  screencastFrame(f, {sessionId: 25});
  await new Promise(setImmediate);
  assert.equal(f.calls.length, calls, "a frame after stream cleanup must not dispatch an ACK");
  assert.equal(f.calls.some(([method]) => method === "Page.captureScreenshot"), false);
});

test("screenshot ACK and stop are queued together; a held cleanup blocks only new screenshots", async context => {
  const f = fixture();
  const decode = screenshotBitmap(context);
  await f.driver.attach(f.tab);
  const sessionId = f.driver.status().sessionId;
  const ack = holdNextCommand(f, "Page.screencastFrameAck");
  const stop = holdNextCommand(f, "Page.stopScreencast");
  context.mock.timers.enable({apis: ["setTimeout"]});
  const pending = f.request("screenshot");
  await new Promise(setImmediate);
  screencastFrame(f);
  await ack.sent;
  await new Promise(setImmediate);
  assert.equal(f.calls.filter(([method]) => method === "Page.stopScreencast").length, 1,
    "stop must not wait for a possibly stalled frame ACK");
  context.mock.timers.tick(10000);
  assert.equal((await pending).error.code, "BROWSER_TIMEOUT");
  context.mock.timers.tick(30000);
  assert.equal(f.driver.status().attached, true);
  assert.equal(f.driver.status().sessionId, sessionId);
  assert.equal(f.driver.status().recovery.method, "Page.startScreencast");
  const calls = f.calls.length;
  assert.equal((await f.request("screenshot")).error.code, "BROWSER_RECOVERING");
  assert.equal(f.calls.length, calls);
  ack.acknowledge({});
  await new Promise(setImmediate);
  assert.equal(f.driver.status().recovery.state, "screenshot_read_pending", "the stop command still owns the capture slot");
  const observed = (await f.request("observe")).result.snapshotId;
  stop.acknowledge({});
  await new Promise(setImmediate);
  assert.equal(f.driver.status().recovery, null);
  assert.equal(decode.mock.calls.length, 0, "a timed-out capture must never decode or publish its late pixels");
  assert.equal((await f.request("click", {snapshotId: observed, x: 20, y: 20})).ok, true);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
});

test("a missing screencast frame times out, stops its stream and permits a later fresh capture", async context => {
  const f = fixture();
  const decode = screenshotBitmap(context);
  await f.driver.attach(f.tab);
  const stop = holdNextCommand(f, "Page.stopScreencast");
  context.mock.timers.enable({apis: ["setTimeout"]});
  const pending = f.request("screenshot");
  await new Promise(setImmediate);
  context.mock.timers.tick(10000);
  assert.equal((await pending).error.code, "BROWSER_TIMEOUT");
  await stop.sent;
  assert.equal((await f.request("screenshot")).error.code, "BROWSER_RECOVERING");
  assert.equal(f.calls.some(([method]) => method === "Page.screencastFrameAck"), false, "never invent a frame ACK");
  screencastFrame(f, {sessionId: 51});
  await new Promise(setImmediate);
  assert.equal(decode.mock.calls.length, 0);
  stop.acknowledge({});
  await new Promise(setImmediate);
  assert.equal(f.driver.status().recovery, null);
  const next = f.request("screenshot");
  await new Promise(setImmediate);
  screencastFrame(f, {sessionId: 52});
  assert.equal((await next).ok, true);
  assert.equal(decode.mock.calls.length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 2);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
});

for (const method of ["Page.screencastFrameAck", "Page.stopScreencast"]) {
  test(`late ${method} rejection never publishes timed-out pixels or detaches the session`, async context => {
    const f = fixture();
    const decode = screenshotBitmap(context);
    await f.driver.attach(f.tab);
    const command = holdNextCommand(f, method);
    const sessionId = f.driver.status().sessionId;
    context.mock.timers.enable({apis: ["setTimeout"]});
    const pending = f.request("screenshot");
    await new Promise(setImmediate);
    screencastFrame(f);
    await command.sent;
    context.mock.timers.tick(10000);
    assert.equal((await pending).error.code, "BROWSER_TIMEOUT");
    command.reject(new Error("private cleanup failure must not enter diagnostics"));
    await new Promise(setImmediate);
    assert.equal(f.driver.status().attached, true);
    assert.equal(f.driver.status().sessionId, sessionId);
    assert.equal(decode.mock.calls.length, 0);
    assert.equal(JSON.stringify(f.nativeMessages).includes("private cleanup failure"), false);
    if (method === "Page.stopScreencast") {
      assert.equal(f.driver.status().recovery.state, "screenshot_cleanup_failed");
      assert.equal(f.driver.status().recovery.method, "Page.stopScreencast");
      assert.deepEqual(f.driver.status().recovery.blocks, ["screenshot"]);
      const calls = f.calls.length;
      assert.equal((await f.request("screenshot")).error.code, "BROWSER_RECOVERING");
      assert.equal(f.calls.length, calls, "unconfirmed stop cannot permit a second recording stream");
      context.mock.timers.tick(60000);
      assert.equal(f.driver.status().recovery.state, "screenshot_cleanup_failed");
    } else {
      assert.equal(f.driver.status().recovery, null, "successful stop releases the screenshot slot despite a failed ACK");
    }
    const observed = (await f.request("observe")).result.snapshotId;
    assert.equal((await f.request("click", {snapshotId: observed, x: 20, y: 20})).ok, true);
    assert.equal(f.calls.some(([name]) => name === "detach"), false);
  });
}

test("detaching while waiting for a screencast frame cancels the capture without sending more CDP", async context => {
  const f = fixture();
  const decode = screenshotBitmap(context);
  await f.driver.attach(f.tab);
  const pending = f.request("screenshot");
  await new Promise(setImmediate);
  await f.driver.detach();
  assert.equal((await pending).error.code, "NOT_ATTACHED");
  const calls = f.calls.length;
  screencastFrame(f);
  await new Promise(setImmediate);
  assert.equal(f.calls.length, calls);
  assert.equal(decode.mock.calls.length, 0);
  assert.equal(f.calls.some(([method]) => ["Page.stopScreencast", "Page.screencastFrameAck"].includes(method)), false,
    "debugger detach performs cleanup; revoked capture callbacks cannot send new commands");
});

test("document invalidation during a screencast cannot publish a current snapshot", async context => {
  const f = fixture();
  screenshotBitmap(context);
  await f.driver.attach(f.tab);
  const pending = f.request("screenshot");
  await new Promise(setImmediate);
  f.driver.onDebuggerEvent({tabId: f.tab.id}, "DOM.documentUpdated");
  screencastFrame(f);
  const result = await pending;
  assert.equal(result.error.code, "STALE_CAPTURE");
  assert.equal(f.driver.status().attached, true);
  assert.equal(f.calls.filter(([method]) => method === "Page.stopScreencast").length, 1);
});

test("a screenshot held beyond the old hard deadline preserves attachment and fresh actions", async context => {
  const f = fixture();
  const stored = persistentStorage(f);
  await f.driver.attach(f.tab);
  const sessionId = f.driver.status().sessionId;
  const snapshotId = (await f.request("observe")).result.snapshotId;
  const command = holdNextCommand(f, "Page.startScreencast");
  const decode = context.mock.method(globalThis, "atob");
  context.mock.timers.enable({apis: ["setTimeout"]});
  const pending = f.request("screenshot", {format: "jpeg", quality: 45});
  await command.sent;
  context.mock.timers.tick(10000);
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "BROWSER_TIMEOUT");
  assert.equal(response.error.outcome, undefined, "a read timeout is not an uncertain mutation");
  context.mock.timers.tick(30000);
  assert.equal(f.driver.status().attached, true);
  assert.equal(f.driver.status().sessionId, sessionId);
  assert.equal(stored.vidsStudioActiveBindingsV2[0].sessionId, sessionId);
  assert.equal(stored.vidsStudioFencesV1, undefined);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  assert.equal(f.nativeMessages.some(message => message.event === "detached"), false);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeated = await f.request("screenshot", {format: "jpeg", quality: 45});
    assert.equal(repeated.ok, false);
    assert.equal(repeated.error.code, "BROWSER_RECOVERING");
    assert.equal(repeated.error.outcome, undefined);
  }
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1,
    "an unresolved capture must not accumulate more browser captures");
  assert.equal((await f.request("click", {snapshotId, x: 20, y: 20})).error.code, "STALE_SNAPSHOT");
  const usable = (await f.request("observe")).result.snapshotId;
  assert.equal((await f.request("click", {snapshotId: usable, x: 20, y: 20})).ok, true,
    "fresh actions must remain usable while the old capture is unresolved");
  const fresh = (await f.request("observe")).result.snapshotId;
  command.acknowledge({data: "bGF0ZQ=="});
  await new Promise(setImmediate);
  assert.equal(decode.mock.calls.length, 0, "a late timed-out image must be discarded");
  assert.equal(f.driver.status().sessionId, sessionId);
  assert.equal((await f.request("click", {snapshotId: fresh, x: 20, y: 20})).ok, true,
    "a late image must not invalidate a fresh AX snapshot");
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
});

for (const method of ["Page.startScreencast", "Page.getLayoutMetrics"]) {
  for (const completion of ["resolve", "reject"]) {
    test(`screenshot recovery: ${method} late ${completion} blocks only screenshots and preserves fresh actions`, async context => {
      const f = fixture();
      await f.driver.attach(f.tab);
      const sessionId = f.driver.status().sessionId;
      const snapshotId = (await f.request("observe")).result.snapshotId;
      const command = holdNextCommand(f, method);
      const decode = context.mock.method(globalThis, "atob");
      context.mock.timers.enable({apis: ["setTimeout"]});
      const pending = f.request("screenshot");
      await command.sent;
      const queued = f.request("click", {snapshotId, x: 20, y: 20});
      context.mock.timers.tick(10000);
      const response = await pending;
      assert.equal(response.error.code, "BROWSER_TIMEOUT");
      assert.equal(response.error.outcome, undefined);
      assert.equal(f.driver.status().attached, true);
      assert.equal((await queued).error.code, "STALE_SNAPSHOT");
      const status = (await f.request("status")).result;
      assert.equal(status.recovery.state, "screenshot_read_pending");
      assert.equal(status.recovery.method, method);
      assert.equal(status.recovery.timeoutMs, 10000);
      assert.deepEqual(status.recovery.blocks, ["screenshot"]);
      assert.equal(status.recovery.requiresFreshObservation, true);
      assert.equal("hardDeadlineMs" in status.recovery, false);
      const calls = f.calls.length;
      const blocked = await f.request("screenshot");
      assert.equal(blocked.error.code, "BROWSER_RECOVERING");
      assert.equal(blocked.error.outcome, undefined);
      assert.equal(f.calls.length, calls, "no new layout or capture while the original read is unresolved");
      assert.equal((await f.request("press_key", {snapshotId, key: "Enter"})).error.code, "STALE_SNAPSHOT");
      const usable = (await f.request("observe")).result.snapshotId;
      assert.equal(f.driver.status().recovery.requiresFreshObservation, false);
      assert.equal((await f.request("click", {snapshotId: usable, x: 20, y: 20})).ok, true);
      const fresh = (await f.request("observe")).result.snapshotId;
      const beforeLateReply = f.calls.length;
      if (completion === "resolve") command.acknowledge({data: "bGF0ZQ=="});
      else command.reject(new Error("private failure text must not enter diagnostics"));
      await new Promise(setImmediate);
      assert.equal(f.driver.status().sessionId, sessionId);
      assert.equal(f.driver.status().recovery, null);
      const cleanup = f.calls.slice(beforeLateReply);
      assert.deepEqual(cleanup.map(([name]) => name), method === "Page.startScreencast"
        ? ["Page.stopScreencast"] : [], "a late start may only clean up its own stream");
      assert.equal(decode.mock.calls.length, 0);
      assert.equal((await f.request("click", {snapshotId, x: 20, y: 20})).error.code, "STALE_SNAPSHOT");
      assert.equal((await f.request("click", {snapshotId: fresh, x: 20, y: 20})).ok, true);
      assert.equal(f.calls.filter(([name]) => name === "detach").length, 0);
      assert.equal(JSON.stringify(f.nativeMessages).includes("private failure text"), false);
      const phases = f.nativeMessages.filter(m => m.type === "diagnostic").map(m => m.phase);
      assert.deepEqual(phases, ["read_quarantined", `read_${method === "Page.getLayoutMetrics" && completion === "resolve" ? "resolved" : "rejected"}`]);
    });
    test(`screenshot recovery: old ${method} late ${completion} cannot clear a new session's pending read`, async context => {
      const f = fixture();
      await f.driver.attach(f.tab);
      const oldSessionId = f.driver.status().sessionId;
      const command = holdNextCommand(f, method);
      const decode = context.mock.method(globalThis, "atob");
      context.mock.timers.enable({apis: ["setTimeout"]});
      const pending = f.request("screenshot");
      await command.sent;
      context.mock.timers.tick(10000);
      assert.equal((await pending).error.code, "BROWSER_TIMEOUT");
      context.mock.timers.tick(30000);
      assert.equal(f.driver.status().sessionId, oldSessionId);
      assert.equal(f.calls.filter(([name]) => name === "detach").length, 0);

      // Reattachment is explicit: a screenshot deadline must never do this.
      await f.driver.attach(f.tab);
      const newSessionId = f.driver.status().sessionId;
      const nextCommand = holdNextCommand(f, method);
      const nextPending = f.request("screenshot");
      await nextCommand.sent;
      context.mock.timers.tick(10000);
      assert.equal((await nextPending).error.code, "BROWSER_TIMEOUT");
      const fresh = (await f.request("observe")).result.snapshotId;
      const calls = f.calls.length;
      if (completion === "resolve") command.acknowledge({data: "bGF0ZQ=="});
      else command.reject(new Error("obsolete private Chrome failure"));
      await new Promise(setImmediate);
      assert.notEqual(newSessionId, oldSessionId);
      assert.equal(f.driver.status().sessionId, newSessionId);
      assert.equal(f.driver.status().recovery.state, "screenshot_read_pending");
      assert.equal(f.driver.status().recovery.method, method);
      assert.equal(f.driver.status().recovery.requiresFreshObservation, false);
      assert.equal(f.calls.length, calls);
      assert.equal(decode.mock.calls.length, 0);
      assert.equal((await f.request("observe", {}, {sessionId: oldSessionId})).error.code, "SESSION_MISMATCH");
      assert.equal((await f.request("click", {snapshotId: fresh, x: 20, y: 20})).ok, true);
      nextCommand.reject(new Error("new read finished without an image"));
      await new Promise(setImmediate);
      assert.equal(f.driver.status().recovery, null);
      assert.equal(f.driver.status().sessionId, newSessionId);
      assert.equal(f.calls.filter(([name]) => name === "detach").length, 1);
      assert.equal(JSON.stringify(f.nativeMessages).includes("obsolete private Chrome failure"), false);
    });
  }
}

for (const change of ["navigation", "native_disconnect"]) {
  test(`screenshot recovery: ${change} revokes authority before a late read callback`, async context => {
    const f = fixture();
    await f.driver.attach(f.tab);
    const command = holdNextCommand(f, "Page.startScreencast");
    context.mock.timers.enable({apis: ["setTimeout"]});
    const pending = f.request("screenshot");
    await command.sent;
    context.mock.timers.tick(10000);
    await pending;
    if (change === "navigation") {
      f.tab.url = "https://docs.google.com/videos/d/different/edit";
      f.driver.onTabUpdated(f.tab.id, {url: f.tab.url});
    } else f.callbacks.disconnect();
    assert.equal(f.driver.status().attached, false);
    command.acknowledge({data: "bGF0ZQ=="});
    await new Promise(setImmediate);
    context.mock.timers.tick(10000);
    assert.equal(f.driver.status().attached, false);
    assert.equal(f.calls.filter(([name]) => name === "detach").length, 1);
  });
}

for (const method of ["observe", "click"]) {
  test(`${method} layout timeout still fails closed outside screenshot recovery`, async context => {
    const f = fixture();
    await f.driver.attach(f.tab);
    const {snapshotId} = (await f.request("observe")).result;
    const command = holdNextCommand(f, "Page.getLayoutMetrics");
    context.mock.timers.enable({apis: ["setTimeout"]});
    const pending = f.request(method, {snapshotId, x: 20, y: 20});
    await command.sent;
    context.mock.timers.tick(10000);
    const response = await pending;
    assert.equal(response.error.code, "BROWSER_TIMEOUT");
    assert.equal(response.error.outcome, method === "click" ? "unknown" : undefined);
    assert.equal(f.driver.status().attached, false);
    command.acknowledge({});
    await new Promise(setImmediate);
    assert.equal(f.calls.some(([name]) => name === "Input.dispatchMouseEvent"), false);
  });
}

test("mixed pending screenshot and wheel report both gates and settle independently", async context => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const sessionId = f.driver.status().sessionId;
  const capture = holdNextCommand(f, "Page.startScreencast");
  const decode = context.mock.method(globalThis, "atob");
  context.mock.timers.enable({apis: ["setTimeout"]});
  const screenshot = f.request("screenshot");
  await capture.sent;
  context.mock.timers.tick(10000);
  assert.equal((await screenshot).error.code, "BROWSER_TIMEOUT");
  const observed = (await f.request("observe")).result;
  const wheel = holdNextCommand(f, "Input.dispatchMouseEvent", params => params.type === "mouseWheel");
  const scroll = f.request("scroll", {snapshotId: observed.snapshotId, x: 20, y: 20, deltaY: 100}, {id: "mixed-wheel"});
  await wheel.sent;
  context.mock.timers.tick(10000);
  assert.equal((await scroll).settled, false);
  const both = (await f.request("status")).result;
  assert.equal(both.sessionId, sessionId);
  assert.equal(both.recovery.state, "input_ack_pending");
  assert.deepEqual(both.recovery.blocks, ["mutations", "screenshot"]);
  const calls = f.calls.length;
  assert.equal((await f.request("screenshot")).error.code, "BROWSER_RECOVERING");
  assert.equal(f.calls.length, calls);

  capture.acknowledge({data: "bGF0ZQ=="});
  await new Promise(setImmediate);
  assert.equal(decode.mock.calls.length, 0);
  assert.equal(f.driver.status().recovery.state, "input_ack_pending");
  assert.deepEqual(f.driver.status().recovery.blocks, ["mutations"]);
  const beforeSettlement = (await f.request("observe")).result.snapshotId;
  assert.equal((await f.request("click", {snapshotId: beforeSettlement, x: 20, y: 20})).error.code, "BROWSER_RECOVERING");
  wheel.acknowledge({});
  await new Promise(setImmediate);
  assert.equal(f.driver.status().recovery, null);
  assert.equal(f.driver.status().sessionId, sessionId);
  const settlement = f.nativeMessages.find(message => message.type === "response" && message.id === "mixed-wheel");
  assert.equal(settlement.sessionId, sessionId);
  assert.equal(settlement.settled, true);
  assert.equal(settlement.error.outcome, "unknown");
  assert.equal((await f.request("click", {snapshotId: beforeSettlement, x: 20, y: 20})).error.code, "STALE_SNAPSHOT");
  const fresh = (await f.request("observe")).result.snapshotId;
  assert.equal((await f.request("click", {snapshotId: fresh, x: 20, y: 20})).ok, true);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  assert.equal(f.calls.filter(([method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseWheel").length, 1);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
});

for (const completion of ["resolve", "reject"]) {
  test(`wheel timeout keeps attachment, blocks mutations and reports late ${completion} without replay`, async context => {
    const f = fixture({exportMenu: true});
    const stored = persistentStorage(f);
    await f.driver.attach(f.tab);
    const sessionId = f.driver.status().sessionId;
    const snapshotId = (await f.request("observe")).result.snapshotId;
    const command = holdNextCommand(f, "Input.dispatchMouseEvent", params => params.type === "mouseWheel");
    context.mock.timers.enable({apis: ["setTimeout"]});
    const envelope = {v: 2, type: "request", id: "held-wheel", sessionId, method: "scroll",
      params: {snapshotId, x: 20, y: 20, deltaX: -8000, deltaY: 0}};
    const pending = f.driver.handleRequest(envelope);
    await command.sent;
    const queued = f.request("click", {snapshotId, x: 20, y: 20});
    context.mock.timers.tick(10000);
    const response = await pending;
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "BROWSER_TIMEOUT");
    assert.match(response.error.message, /scroll/i);
    assert.equal(response.error.outcome, "unknown");
    assert.equal(response.settled, false);
    assert.equal(response.sessionId, sessionId);
    assert.equal((await queued).error.code, "BROWSER_RECOVERING");
    context.mock.timers.tick(30000);
    const status = (await f.request("status")).result;
    assert.equal(status.attached, true);
    assert.equal(status.sessionId, sessionId);
    assert.equal(status.recovery.state, "input_ack_pending");
    assert.equal(status.recovery.method, "Input.dispatchMouseEvent");
    assert.equal(status.recovery.timeoutMs, 10000);
    assert.deepEqual(status.recovery.blocks, ["mutations"]);
    assert.equal(status.recovery.requiresReconciliation, true);
    assert.equal(status.recovery.requiresFreshObservation, true);
    assert.equal(stored.vidsStudioActiveBindingsV2[0].sessionId, sessionId);
    assert.equal(stored.vidsStudioFencesV1, undefined);
    assert.equal(f.calls.some(([method]) => method === "detach"), false);

    const observed = (await f.request("observe")).result;
    const calls = f.calls.length;
    const params = {snapshotId: observed.snapshotId, x: 20, y: 20, deltaY: 100,
      from: {x: 20, y: 20}, to: {x: 40, y: 20}, key: "Enter", text: "must not be typed",
      files: ["/tmp/must-not-be-uploaded.png"], automaticDownloadConfirmed: true,
      downloadModeCheckedAt: new Date().toISOString(), jobId: "must-not-be-exported"};
    for (const method of ["scroll", "click", "drag", "type_text", "press_key", "upload", "upload_via_picker", "export_trigger"]) {
      const blocked = await f.request(method, params);
      assert.equal(blocked.error.code, "BROWSER_RECOVERING", method);
      assert.equal(blocked.error.outcome, undefined, "the blocked mutation has not started");
    }
    assert.strictEqual(await f.driver.handleRequest(envelope), response);
    assert.equal(f.calls.length, calls, "pending input forbids dispatch or preflight of another mutation");
    assert.equal(f.nativeMessages.some(message => message.type === "response" && message.id === envelope.id), false);
    if (completion === "resolve") command.acknowledge({});
    else command.reject(new Error("private late wheel failure"));
    await new Promise(setImmediate);
    assert.equal(f.driver.status().sessionId, sessionId);
    assert.equal(f.driver.status().recovery, null);
    assert.equal(f.calls.length, calls, "late completion must not replay or send cleanup input");
    const settlements = f.nativeMessages.filter(message => message.type === "response" && message.id === envelope.id);
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].sessionId, sessionId);
    assert.equal(settlements[0].settled, true);
    assert.equal(settlements[0].ok, false);
    assert.equal(settlements[0].error.code, "BROWSER_TIMEOUT");
    assert.equal(settlements[0].error.outcome, "unknown");
    assert.equal(JSON.stringify(f.nativeMessages).includes("private late wheel failure"), false);
    assert.equal((await f.request("click", {snapshotId, x: 20, y: 20})).error.code, "STALE_SNAPSHOT");
    assert.equal((await f.request("click", {snapshotId: observed.snapshotId, x: 20, y: 20})).error.code, "STALE_SNAPSHOT",
      "an observation made before input settled cannot authorize a later mutation");
    assert.deepEqual(f.calls.filter(([method]) => method === "Input.dispatchMouseEvent"), [
      ["Input.dispatchMouseEvent", {type: "mouseWheel", x: 20, y: 20, deltaX: -8000, deltaY: 0}],
    ]);
    const fresh = (await f.request("observe")).result.snapshotId;
    assert.equal((await f.request("click", {snapshotId: fresh, x: 20, y: 20})).ok, true);
    assert.equal(f.calls.some(([method]) => method === "detach"), false);
  });

  test(`old wheel late ${completion} cannot settle a different session's input`, async context => {
    const f = fixture();
    await f.driver.attach(f.tab);
    const oldSessionId = f.driver.status().sessionId;
    const snapshotId = (await f.request("observe")).result.snapshotId;
    const oldCommand = holdNextCommand(f, "Input.dispatchMouseEvent", params => params.type === "mouseWheel");
    context.mock.timers.enable({apis: ["setTimeout"]});
    const oldPending = f.request("scroll", {snapshotId, x: 20, y: 20, deltaY: 100}, {id: "old-wheel"});
    await oldCommand.sent;
    context.mock.timers.tick(10000);
    assert.equal((await oldPending).settled, false);
    await f.driver.attach(f.tab);
    const sessionId = f.driver.status().sessionId;
    assert.notEqual(sessionId, oldSessionId);
    const nextSnapshot = (await f.request("observe")).result.snapshotId;
    const nextCommand = holdNextCommand(f, "Input.dispatchMouseEvent", params => params.type === "mouseWheel");
    const nextPending = f.request("scroll", {snapshotId: nextSnapshot, x: 20, y: 20, deltaY: 100}, {id: "new-wheel"});
    await nextCommand.sent;
    context.mock.timers.tick(10000);
    assert.equal((await nextPending).settled, false);
    const calls = f.calls.length;
    if (completion === "resolve") oldCommand.acknowledge({});
    else oldCommand.reject(new Error("obsolete wheel failure"));
    await new Promise(setImmediate);
    assert.equal(f.driver.status().sessionId, sessionId);
    assert.equal(f.driver.status().recovery.state, "input_ack_pending");
    assert.equal(f.calls.length, calls);
    assert.equal(f.nativeMessages.some(message => message.type === "response" && message.id === "old-wheel"), false);
    nextCommand.acknowledge({});
    await new Promise(setImmediate);
    assert.equal(f.driver.status().recovery, null);
    const settlements = f.nativeMessages.filter(message => message.type === "response" && message.id === "new-wheel");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].sessionId, sessionId);
    assert.equal(settlements[0].settled, true);
    assert.equal(f.calls.length, calls);
    assert.equal(f.calls.filter(([method]) => method === "detach").length, 1, "only explicit reattachment detached");
  });
}

for (const mutation of [
  {method: "click", command: "Input.dispatchMouseEvent", matches: params => params.type === "mouseMoved"},
  {method: "type_text", command: "Input.insertText", matches: () => true},
]) {
  test(`${mutation.method} CDP timeout remains fail-closed outside wheel recovery`, async context => {
    const f = fixture();
    await f.driver.attach(f.tab);
    const observed = (await f.request("observe")).result;
    const command = holdNextCommand(f, mutation.command, mutation.matches);
    context.mock.timers.enable({apis: ["setTimeout"]});
    const pending = f.request(mutation.method, {snapshotId: observed.snapshotId, x: 20, y: 20,
      ...(mutation.method === "type_text" ? {nodeRef: observed.nodes.find(node => node.name === "Caption").ref, text: "only once"} : {})});
    await command.sent;
    context.mock.timers.tick(10000);
    const response = await pending;
    assert.equal(response.error.code, "BROWSER_TIMEOUT");
    assert.equal(response.error.outcome, "unknown");
    assert.notEqual(response.settled, false);
    assert.equal(f.driver.status().attached, false);
    const calls = f.calls.length;
    command.acknowledge({});
    await new Promise(setImmediate);
    assert.equal(f.calls.length, calls);
    assert.equal(f.driver.status().recovery, null);
    assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
  });
}

test("forbidden shortcuts are rejected before any CDP keyboard input", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  for (const [key, modifiers] of [["v", ["Control"]], ["l", ["Meta"]], ["Tab", ["Alt"]], ["Delete", ["Shift"]]]) {
    const snapshotId = (await f.request("observe")).result.snapshotId;
    const response = await f.request("press_key", {snapshotId, key, modifiers});
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "FORBIDDEN_SHORTCUT");
  }
  assert.equal(f.calls.some(([method]) => method === "Input.dispatchKeyEvent" || method === "Input.insertText"), false);
});

test("picker upload arms interception before clicking and restores cancellation after selection", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const original = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, params) => {
    const result = await original(target, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      f.driver.onDebuggerEvent({tabId: f.tab.id}, "Page.fileChooserOpened", {frameId: "main", backendNodeId: 4, mode: "selectSingle"});
    }
    return result;
  };
  const snapshot = (await f.request("observe")).result;
  const button = snapshot.nodes.find(node => node.name === "Add scene");
  const response = await f.request("upload_via_picker", {snapshotId: snapshot.snapshotId, nodeRef: button.ref, files: ["/tmp/снимок.png"]}, {id: "picker-once"});
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.deepEqual(response.result, {performed: true, needsObservation: true});
  const arm = f.calls.findIndex(([m, p]) => m === "Page.setInterceptFileChooserDialog" && p.cancel === false);
  const click = f.calls.findIndex(([m, p]) => m === "Input.dispatchMouseEvent" && p.type === "mousePressed");
  const upload = f.calls.findIndex(([m]) => m === "DOM.setFileInputFiles");
  assert.ok(arm < click && click < upload);
  assert.deepEqual(f.calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
  assert.equal(f.calls.some(([m, p]) => m === "Page.setInterceptFileChooserDialog" && p.enabled === false), false);
  assert.equal((await f.request("upload_via_picker", {}, {id: "picker-once"})), response);
  assert.equal(f.calls.filter(([m]) => m === "DOM.setFileInputFiles").length, 1);
});

for (const stage of ["hover", "hit verification"]) {
  test(`picker gives the chooser its full deadline after slow ${stage}`, async context => {
    const f = fixture();
    await f.driver.attach(f.tab);
    const snapshotId = (await f.request("observe")).result.snapshotId;
    const original = f.api.debugger.sendCommand;
    let hovered = false, chooserEvents = 0;
    f.api.debugger.sendCommand = async (target, method, params) => {
      const result = await original(target, method, params);
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") hovered = true;
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        chooserEvents += 1;
        f.driver.onDebuggerEvent({tabId: f.tab.id}, "Page.fileChooserOpened", {frameId: "main", backendNodeId: 4, mode: "selectSingle"});
      }
      return result;
    };
    const delayed = stage === "hover"
      ? holdNextCommand(f, "Input.dispatchMouseEvent", params => params.type === "mouseMoved")
      : holdNextCommand(f, "DOM.getNodeForLocation", () => hovered);
    context.mock.timers.enable({apis: ["setTimeout"]});
    const pending = f.request("upload_via_picker", {snapshotId, x: 20, y: 20, files: ["/tmp/approved.png"]});
    await delayed.sent;
    context.mock.timers.tick(5200);
    assert.equal(f.calls.some(([method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed"), false);
    delayed.acknowledge(stage === "hover" ? {} : {backendNodeId: 5, frameId: "main"});
    const response = await pending;
    assert.equal(response.ok, true, JSON.stringify(response.error));
    assert.equal(chooserEvents, 1);
    assert.equal(f.calls.filter(([method]) => method === "DOM.setFileInputFiles").length, 1);
    assert.deepEqual(f.calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
    assert.equal(f.driver.status().attached, true);
  });
}

for (const reason of ["early chooser", "detached session"]) {
  test(`picker canceled during preflight sends no trigger click: ${reason}`, async () => {
    const f = fixture();
    await f.driver.attach(f.tab);
    const snapshotId = (await f.request("observe")).result.snapshotId;
    const hover = holdNextCommand(f, "Input.dispatchMouseEvent", params => params.type === "mouseMoved");
    const pending = f.request("upload_via_picker", {snapshotId, x: 20, y: 20, files: ["/tmp/approved.png"]});
    await hover.sent;
    if (reason === "early chooser") {
      f.driver.onDebuggerEvent({tabId: f.tab.id}, "Page.fileChooserOpened", {frameId: "main", backendNodeId: 4, mode: "selectSingle"});
    } else await f.driver.detach("Fixture revocation during hover.");
    hover.acknowledge({});
    const response = await pending;
    assert.equal(response.error.code, reason === "early chooser" ? "FILE_CHOOSER_MISMATCH" : "NOT_ATTACHED");
    assert.equal(f.calls.some(([method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed"), false);
    assert.equal(f.calls.some(([method]) => method === "DOM.setFileInputFiles"), false);
    if (reason === "early chooser") {
      assert.deepEqual(f.calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
      assert.equal(f.driver.status().attached, true);
    }
  });
}

test("picker upload rejects foreign or unsupported chooser inputs without sending files", async () => {
  for (const event of [
    {frameId: "foreign", backendNodeId: 4, mode: "selectSingle"},
    {frameId: "main", backendNodeId: 2, mode: "selectSingle"},
    {frameId: "main", mode: "selectSingle"},
  ]) {
    const f = fixture();
    await f.driver.attach(f.tab);
    const original = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, params) => {
      const result = await original(target, method, params);
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        f.driver.onDebuggerEvent({tabId: f.tab.id}, "Page.fileChooserOpened", event);
      }
      return result;
    };
    const snapshotId = (await f.request("observe")).result.snapshotId;
    const response = await f.request("upload_via_picker", {snapshotId, x: 20, y: 20, files: ["/tmp/approved.png"]});
    assert.equal(response.ok, false);
    assert.ok(["FILE_CHOOSER_MISMATCH", "UNSUPPORTED_FILE_CHOOSER"].includes(response.error.code));
    assert.equal(response.error.outcome, "unknown");
    assert.equal(f.calls.some(([m]) => m === "DOM.setFileInputFiles"), false);
    assert.deepEqual(f.calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
  }
});

test("a picker timeout restores cancellation and ignores late events without retrying", async context => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const snapshotId = (await f.request("observe")).result.snapshotId;
  context.mock.timers.enable({apis: ["setTimeout"]});
  const pending = f.request("upload_via_picker", {snapshotId, x: 20, y: 20, files: ["/tmp/approved.png"]});
  await new Promise(setImmediate);
  context.mock.timers.tick(5001);
  const response = await pending;
  assert.equal(response.error.code, "FILE_CHOOSER_TIMEOUT");
  assert.equal(response.error.outcome, "unknown");
  assert.equal(f.driver.status().attached, true);
  assert.deepEqual(f.calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
  f.driver.onDebuggerEvent({tabId: f.tab.id}, "Page.fileChooserOpened", {frameId: "main", backendNodeId: 4, mode: "selectSingle"});
  assert.equal(f.calls.some(([m]) => m === "DOM.setFileInputFiles"), false);
  assert.equal(f.calls.filter(([m, p]) => m === "Input.dispatchMouseEvent" && p.type === "mousePressed").length, 1);
});

test("picker finally cleanup CDP timeout replaces chooser timeout before replying and blocks queued input", async context => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const snapshotId = (await f.request("observe")).result.snapshotId;
  const cleanup = holdNextCommand(f, "Page.setInterceptFileChooserDialog", params => params.cancel === true);
  context.mock.timers.enable({apis: ["setTimeout"]});
  let settled = false, queuedSettled = false;
  const pending = f.request("upload_via_picker", {snapshotId, x: 20, y: 20, files: ["/tmp/approved.png"]})
    .then(response => { settled = true; return response; });
  const queued = f.request("click", {snapshotId, x: 20, y: 20})
    .then(response => { queuedSettled = true; return response; });
  await new Promise(setImmediate);
  context.mock.timers.tick(5000);
  await cleanup.sent;
  assert.equal(settled, false, "FILE_CHOOSER_TIMEOUT does not reply before finally cleanup finishes");
  assert.equal(f.driver.status().attached, true);
  assert.deepEqual(f.calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
  context.mock.timers.tick(9999);
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.equal(queuedSettled, false);
  context.mock.timers.tick(1);
  const response = await pending;
  assert.equal(response.error.code, "BROWSER_TIMEOUT");
  assert.ok(response.error.message.includes("Page.setInterceptFileChooserDialog"));
  assert.equal(response.error.outcome, "unknown");
  assert.equal((await queued).error.code, "NOT_ATTACHED");
  assert.equal((await f.request("status")).result.attached, false);
  const callsBeforeReply = f.calls.length;
  cleanup.acknowledge({});
  f.driver.onDebuggerEvent({tabId: f.tab.id}, "Page.fileChooserOpened", {frameId: "main", backendNodeId: 4, mode: "selectSingle"});
  await new Promise(setImmediate);
  assert.equal(f.calls.length, callsBeforeReply);
  assert.equal(f.driver.status().sessionId, null);
  assert.equal(f.calls.some(([method]) => method === "DOM.setFileInputFiles"), false);
  assert.deepEqual(f.calls.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, params]) => params.type),
    ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
});

test("picker rejects duplicate events and inventory frame mismatches before detached-input fallback", async () => {
  for (const reason of ["duplicate_chooser", "inventory_frame_mismatch"]) {
    const f = fixture();
    await f.driver.attach(f.tab);
    const original = f.api.debugger.sendCommand;
    const childUrl = "https://docs.google.com/allowed-picker-frame";
    f.api.debugger.sendCommand = async (target, method, params) => {
      const result = await original(target, method, params);
      if (method === "Page.getFrameTree") return {frameTree: {frame: {id: "main", url: f.tab.url}, childFrames: [
        {frame: {id: "allowed-child", parentId: "main", url: childUrl, securityOrigin: "https://docs.google.com"}},
      ]}};
      if (method === "DOM.getDocument") {
        const root = structuredClone(result.root);
        root.children.push({backendNodeId: 9, nodeName: "IFRAME", frameId: "allowed-child", attributes: ["src", childUrl],
          contentDocument: {backendNodeId: 10, nodeName: "#document", documentURL: childUrl, children: []}});
        return {root};
      }
      if (method === "Accessibility.getFullAXTree" && params?.frameId === "allowed-child") return {nodes: [
        {nodeId: "child-root", backendDOMNodeId: 10, role: {value: "RootWebArea"}},
      ]};
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        const event = {frameId: reason === "duplicate_chooser" ? "main" : "allowed-child", backendNodeId: 4, mode: "selectSingle"};
        f.driver.onDebuggerEvent({tabId: f.tab.id}, "Page.fileChooserOpened", event);
        if (reason === "duplicate_chooser") f.driver.onDebuggerEvent({tabId: f.tab.id}, "Page.fileChooserOpened", event);
      }
      return result;
    };
    const {snapshotId} = (await f.request("observe")).result;
    const response = await f.request("upload_via_picker", {snapshotId, x: 20, y: 20, files: ["/tmp/approved.png"]});
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "FILE_CHOOSER_MISMATCH");
    assert.ok(response.error.message.includes(reason), response.error.message);
    assert.equal(f.calls.some(([method]) => method === "DOM.setFileInputFiles" || method === "DOM.resolveNode" || method === "Page.createIsolatedWorld"), false);
    assert.deepEqual(f.calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
  }
});

test("failure to arm picker interception prevents the trigger click", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const original = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, params) => {
    const result = await original(target, method, params);
    if (method === "Page.setInterceptFileChooserDialog" && params.cancel === false) throw new Error("Interception unavailable");
    return result;
  };
  const snapshotId = (await f.request("observe")).result.snapshotId;
  assert.equal((await f.request("upload_via_picker", {snapshotId, x: 20, y: 20, files: ["/tmp/approved.png"]})).ok, false);
  assert.equal(f.calls.some(([m]) => m === "Input.dispatchMouseEvent"), false);
  assert.deepEqual(f.calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
});

test("picker rejects a foreign hit for coordinates and an overlaid observed node before any click", async () => {
  for (const useNode of [false, true]) {
    const f = fixture();
    await f.driver.attach(f.tab);
    const snapshot = (await f.request("observe")).result;
    const button = snapshot.nodes.find(node => node.name === "Add scene");
    const original = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, params) => {
      if (method === "DOM.getNodeForLocation") return {backendNodeId: 999, frameId: "foreign-oopif"};
      return original(target, method, params);
    };
    const target = useNode ? {nodeRef: button.ref} : {x: 20, y: 20};
    const result = await f.request("upload_via_picker", {snapshotId: snapshot.snapshotId, ...target, files: ["/tmp/approved.png"]});
    assert.equal(result.error.code, "FILE_CHOOSER_MISMATCH");
    assert.equal(f.calls.some(([method]) => method === "Input.dispatchMouseEvent"), false);
    assert.equal(f.calls.some(([method, params]) => method === "Page.setInterceptFileChooserDialog" && params.cancel === false), false);
  }
});

test("picker rechecks hover changes before mousePressed and restores cancellation", async () => {
  const f = fixture();
  await f.driver.attach(f.tab);
  const snapshotId = (await f.request("observe")).result.snapshotId;
  const original = f.api.debugger.sendCommand;
  let hovered = false;
  f.api.debugger.sendCommand = async (target, method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") hovered = true;
    if (method === "DOM.getNodeForLocation" && hovered) return {backendNodeId: 999, frameId: "foreign-oopif"};
    return original(target, method, params);
  };
  const response = await f.request("upload_via_picker", {snapshotId, x: 20, y: 20, files: ["/tmp/approved.png"]});
  assert.equal(response.error.code, "FILE_CHOOSER_MISMATCH");
  assert.equal(f.calls.some(([method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed"), false);
  assert.deepEqual(f.calls.at(-1), ["Page.setInterceptFileChooserDialog", {enabled: true, cancel: true}]);
});

test("node reference click rejects a reused control whose name or disabled state changed", async () => {
  for (const change of ["name", "disabled"]) {
    const f = fixture();
    await f.driver.attach(f.tab);
    const snapshot = (await f.request("observe")).result;
    const button = snapshot.nodes.find(node => node.name === "Add scene");
    const original = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, params) => {
      const result = await original(target, method, params);
      if (method === "Accessibility.getPartialAXTree") {
        if (change === "name") result.nodes[0].name.value = "Italic";
        else result.nodes[0].properties = [{name: "disabled", value: {value: true}}];
      }
      return result;
    };
    const response = await f.request("click", {snapshotId: snapshot.snapshotId, nodeRef: button.ref});
    assert.equal(response.error.code, change === "name" ? "TARGET_CHANGED" : "DISABLED_NODE");
    assert.equal(f.calls.some(([method]) => method === "Input.dispatchMouseEvent"), false);
  }
});

test("replacement stops when selection or deletion moves focus to another editor", async () => {
  for (const redirectOn of ["a", "Backspace"]) {
    const f = fixture();
    await f.driver.attach(f.tab);
    const snapshot = (await f.request("observe")).result;
    const editor = snapshot.nodes.find(node => node.name === "Caption");
    const original = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, params) => {
      const result = await original(target, method, params);
      if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && params.key === redirectOn) {
        await original(target, "DOM.focus", {backendNodeId: 3});
      }
      return result;
    };
    const response = await f.request("type_text", {
      snapshotId: snapshot.snapshotId, nodeRef: editor.ref, text: "#16283bff", replace: true,
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "PROTECTED_FIELD");
    assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false);
    assert.equal(f.calls.filter(([method, params]) => method === "DOM.focus" && params.backendNodeId === 2).length, 1);
    if (redirectOn === "a") {
      assert.equal(f.calls.some(([method, params]) => method === "Input.dispatchKeyEvent" && params.key === "Backspace"), false);
    }
  }
});
