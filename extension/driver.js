import {
  attributes, fail, finiteNumber, integer, isFileInput, isPassword,
  keyEvent, parseVidsUrl, plainObject, point, safeError, string,
} from "./helpers.js";
import {PROFILE} from "./profile.js";
import {readFences, recordFence, rememberBinding, clearBinding, recoverBinding, requireStorage} from "./fences.js";
import {createExportWatcher} from "./export-watch.js";

export const HOST_NAME = PROFILE.nativeHostName;
export const CAPABILITIES = [
  "observe", "screenshot", "click", "drag", "scroll", "type_text", "press_key", "upload", "upload_via_picker",
  "export_trigger", "export_download_status", "export_preflight",
];
const SNAPSHOT_MAX_AGE_MS = 120000;
const CDP_TIMEOUT_MS = 10000;
const SCREENSHOT_READS = new Set(["Page.getLayoutMetrics"]);
const READ_OPERATIONS = new Set(["observe", "screenshot", "export_download_status", "export_preflight"]);
const FILE_CHOOSER_TIMEOUT_MS = 5000;
const DRAG_STEP_INTERVAL_MS = 20;

// No arbitrary page evaluation, browser-wide target discovery or public CDP endpoint.
// Injected Chrome APIs permit testing the exact same driver through a CDP fixture.
export function createDriver(chromeApi, options = {}) {
  const fleet = options.fleet;
  let pairingTicket = fleet?.pairingTicket;
  let session = null;
  let lastError = null;
  let attaching = false;
  let attachGeneration = 0;
  let requestQueue = Promise.resolve();
  const completed = new Map();
  const exports = createExportWatcher(chromeApi);
  let fencing = Promise.resolve();

  function status() {
    return {
      attached: Boolean(session), sessionId: session?.id ?? null,
      tabId: session?.tabId ?? null, documentId: session?.documentId ?? null,
      url: session?.url ?? null, title: session?.title ?? null,
      ...(fleet ? {browserInstanceId: fleet.browserInstanceId} : {}),
      capabilities: [...CAPABILITIES], lastError,
      runtime: {extension: {version: PROFILE.version, buildId: PROFILE.buildId,
        profileId: PROFILE.id, protocol: PROFILE.extensionProtocol}},
      recovery: session?.pendingInput ? {
        state: "input_ack_pending", method: session.pendingInput.method,
        elapsedMs: Math.max(0, Date.now() - session.pendingInput.started),
        timeoutMs: CDP_TIMEOUT_MS, blocks: session.pendingRead ? ["mutations", "screenshot"] : ["mutations"],
        requiresReconciliation: true, requiresFreshObservation: true,
      } : session?.pendingRead ? {
        state: session.pendingRead.cleanupFailed ? "screenshot_cleanup_failed" : "screenshot_read_pending", method: session.pendingRead.method,
        elapsedMs: Math.max(0, Date.now() - session.pendingRead.started),
        timeoutMs: CDP_TIMEOUT_MS, blocks: ["screenshot"],
        requiresFreshObservation: !session.snapshot,
      } : null,
    };
  }

  async function badge(text, tabId = session?.tabId) {
    const scope = fleet && Number.isInteger(tabId) ? {tabId} : {};
    await chromeApi.action.setBadgeText({text, ...scope}).catch(() => {});
    if (text) await chromeApi.action.setBadgeBackgroundColor({color: PROFILE.badgeColor, ...scope}).catch(() => {});
  }

  function invalidate(target) {
    target.epoch += 1;
    target.snapshot = null;
  }

  function ensureCurrent(target) {
    if (!target || session !== target) fail("NOT_ATTACHED", "The attached Google Vids session has ended.");
  }

  function diagnostic(target, phase, method, started) {
    // Constant phase/method names and timing only. Never send params, paths,
    // document identifiers, image data or raw Chrome error text to the log.
    try {
      target.port?.postMessage({v: 2, type: "diagnostic", phase, method,
        elapsedMs: Math.max(0, Date.now() - started)});
    } catch { /* Diagnostic failure must not change browser authority. */ }
  }

  function requireScreenshotReady(target) {
    if (target.pendingRead?.cleanupFailed) fail("BROWSER_RECOVERING",
      "Chrome did not confirm screenshot stream cleanup. The tab remains attached and observe is available, but new screenshots are blocked. Reconnect this extension during a pause before another screenshot.");
    if (target.pendingRead) fail("BROWSER_RECOVERING",
      "The previous screenshot read is still pending in Chrome. Use observe for a fresh snapshot; check status/control for any unresolved mutation before editing. The tab remains attached. No new screenshot was sent.");
  }

  async function cdp(target, method, params = {}, screenshotRead = false) {
    ensureCurrent(target);
    const recoverable = screenshotRead && SCREENSHOT_READS.has(method);
    if (recoverable) requireScreenshotReady(target);
    const started = Date.now();
    const command = chromeApi.debugger.sendCommand({tabId: target.tabId}, method, params);
    return commandWithDeadline(target, method, command, recoverable, started);
  }

  async function commandWithDeadline(target, method, command, recoverable, started, cancelRead) {
    const read = {method, started};
    const settled = phase => {
      if (session !== target || target.pendingRead !== read) return;
      target.pendingRead = null;
      // Discard the timed-out result; only a new observation can create a
      // snapshot. A late callback can never continue the old operation.
      diagnostic(target, phase, method, read.started);
    };
    if (recoverable) void command.then(() => settled("read_resolved"), () => settled("read_rejected"));
    let timer;
    try {
      return await Promise.race([
        command,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(recoverable
              ? `Chrome did not answer ${method} within 10 seconds. The screenshot is unavailable; the background or occluded window may not be rendering. The tab remains attached. Use observe for a fresh snapshot and continue; further screenshots wait for this read to settle.`
              : `Chrome did not answer ${method}. Reattach and inspect the document before retrying.`);
            error.code = "BROWSER_TIMEOUT";
            if (session === target && recoverable) {
              invalidate(target);
              target.pendingRead = read;
              diagnostic(target, "read_quarantined", method, read.started);
              cancelRead?.(error);
              // This read cannot dispatch input or publish a late snapshot.
              // Keep its slot until it actually settles so repeated screenshots
              // cannot pile up, but do not revoke the session or block AX/input.
            } else if (session === target) {
              diagnostic(target, "cdp_timeout", method, read.started);
              // Mutations and other reads still fail closed. No cancellation
              // or replay of a Chrome command with unknown outcome is assumed.
              void detach("Chrome не ответил. Подключите вкладку заново и проверьте результат действия.");
            }
            reject(error);
          }, CDP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function clickPair(target, params) {
    // A background renderer can deliver pressed immediately but acknowledge it
    // seconds later. Waiting for that ACK before release turns a click into a
    // long hold and can expire the activation needed by a file chooser.
    // Queue both in order, without an await between them; retain release cleanup
    // after a failed ACK, but never send new input after session revocation.
    const pressed = cdp(target, "Input.dispatchMouseEvent", {type: "mousePressed", ...params});
    const released = session === target
      ? cdp(target, "Input.dispatchMouseEvent", {type: "mouseReleased", ...params})
      : Promise.resolve();
    const results = await Promise.allSettled([pressed, released]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async function scrollWheel(target, params, requestId) {
    ensureCurrent(target);
    const input = {method: "Input.dispatchMouseEvent", started: Date.now(), requestId};
    const command = chromeApi.debugger.sendCommand({tabId: target.tabId}, input.method, params);
    // Chrome may wait for a visual frame BEFORE dispatching the wheel. A
    // timeout is neither cancellation nor proof that scrolling already ran.
    const settled = () => {
      if (session !== target || target.pendingInput !== input) return;
      target.pendingInput = null;
      invalidate(target);
      try {
        target.port?.postMessage({v: 2, type: "response", id: requestId,
          sessionId: target.id, ok: false, settled: true,
          error: {code: "BROWSER_TIMEOUT", outcome: "unknown",
            message: "The earlier scroll has now settled in Chrome, but its effect remains unknown. Observe afresh and reconcile control before another mutation. Do not replay the scroll."}});
      } catch { /* Missing settlement keeps the native coordinator blocked. */ }
    };
    void command.then(settled, settled);
    let timer;
    try {
      await Promise.race([
        command,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Chrome has not acknowledged the scroll within 10 seconds. The tab remains attached, but the scroll may still execute. Observe/status remain available; new mutations and transfer of control must wait for settlement and reconciliation. Do not repeat the scroll.");
            error.code = "BROWSER_TIMEOUT";
            if (session === target) {
              invalidate(target);
              target.pendingInput = input;
              error.inputUnsettled = true;
              diagnostic(target, "cdp_timeout", input.method, input.started);
            }
            reject(error);
          }, CDP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function detach(reason = null, skipDebugger = false) {
    attachGeneration += 1;
    const old = session;
    session = null;
    lastError = reason;
    if (!old) return status();
    old.pendingRead = null;
    old.pendingInput = null;
    old.capture?.cancel(Object.assign(new Error("The screenshot session ended."), {code: "NOT_ATTACHED"}));
    exports.revoke(old.id);
    old.fileChooser?.cancel("NOT_ATTACHED", "The attached session ended while waiting for a file chooser.");
    invalidate(old);
    // Revoke the generation synchronously above. Only a confirmed debugger
    // detach (or a Chrome detach/tab-closed event) may certify input fencing.
    fencing = (async () => {
      let fenced = skipDebugger;
      if (!skipDebugger) {
        try { await chromeApi.debugger.detach({tabId: old.tabId}); fenced = true; }
        catch { /* Unknown detach outcome never grants another writer. */ }
      }
      let fenceReceipts = [];
      if (fenced) {
        try { fenceReceipts = await recordFence(chromeApi, {
          profileId: PROFILE.id, sessionId: old.id, documentId: old.documentId,
        }); await clearBinding(chromeApi, old.id); } catch { /* A missing durable receipt remains a reconciliation block. */ }
      }
      try {
        old.port?.postMessage({v: 2, type: "event", event: "detached", status: status(), fenceReceipts});
      } catch { /* A disconnected host receives durable receipts at the next explicit attach. */ }
      try { old.port?.disconnect(); } catch { /* Already disconnected. */ }
      await badge("", old.tabId);
      try { options.onDetached?.(status()); } catch { /* UI bookkeeping cannot alter fencing. */ }
      return status();
    })();
    return fencing;
  }

  async function attach(tab) {
    if (attaching) fail("BUSY", "A tab attachment is already in progress.");
    if (!Number.isInteger(tab?.id)) fail("INVALID_ARGUMENT", "No active tab.");
    const location = parseVidsUrl(tab.url);
    if (!location) fail("WRONG_PAGE", "Откройте документ Google Vids: docs.google.com/videos/d/…");
    attaching = true;
    const previous = session ? detach(null) : fencing;
    const generation = ++attachGeneration;
    const target = {
      id: crypto.randomUUID(), tabId: tab.id, documentId: location.documentId,
      url: location.url, title: tab.title || "Google Vids", epoch: 0,
      snapshot: null, port: null, frameId: null,
    };
    try {
      await previous;
      if (generation !== attachGeneration) fail("NOT_ATTACHED", "Attachment was canceled.");
      requireStorage(chromeApi);
      await recoverBinding(chromeApi, PROFILE.id, fleet ? tab.id : undefined);
      if (generation !== attachGeneration) fail("NOT_ATTACHED", "Attachment was canceled.");
      await chromeApi.debugger.attach({tabId: tab.id}, "1.3");
      if (generation !== attachGeneration) {
        await chromeApi.debugger.detach({tabId: tab.id}).catch(() => {});
        fail("NOT_ATTACHED", "Attachment was canceled.");
      }
      session = target;
      lastError = null;
      await cdp(target, "Page.enable");
      // Keep this target's renderer producing frames while its tab/window is
      // hidden. Chromium's focus emulation retains a visible capturer without
      // activating a tab or OS window; debugger detach releases that override.
      // Screenshot and wheel dispatch both depend on compositor progress.
      await cdp(target, "Emulation.setFocusEmulationEnabled", {enabled: true});
      // Cancel file inputs in this attached CDP target, including late handlers.
      // OOPIF targets are not covered; picker uploads reject those before input.
      await cdp(target, "Page.setInterceptFileChooserDialog", {enabled: true, cancel: true});
      await cdp(target, "DOM.enable");
      await cdp(target, "Accessibility.enable");
      const {frameTree} = await cdp(target, "Page.getFrameTree");
      target.frameId = frameTree.frame.id;
      const actual = parseVidsUrl(frameTree.frame.url);
      if (!actual || actual.documentId !== target.documentId) {
        fail("DOCUMENT_CHANGED", "Вкладка изменилась во время подключения. Подключите её снова.");
      }
      await rememberBinding(chromeApi, {profileId: PROFILE.id, sessionId: target.id,
        documentId: target.documentId, tabId: target.tabId,
        ...(fleet ? {browserInstanceId: fleet.browserInstanceId} : {})});
      const port = chromeApi.runtime.connectNative(HOST_NAME);
      target.port = port;
      port.onMessage.addListener(message => {
        if (message?.type === "event") {
          if (message.v === 2 && message.event === "pairing_claimed" && message.sessionId === target.id && session === target) {
            pairingTicket = null;
            try { options.onPairingClaimed?.(target.id); } catch { /* Capability is already consumed. */ }
          }
          return;
        }
        void handleRequest(message).then(response => {
          try { port.postMessage(response); } catch { /* Host disappearance revokes this session below. */ }
        });
      });
      port.onDisconnect.addListener(() => {
        const detail = chromeApi.runtime.lastError?.message;
        if (session === target) {
          void detach(detail ? `Локальный мост недоступен: ${detail}` : "Локальный мост отключён.");
        }
      });
      const fenceReceipts = await readFences(chromeApi);
      ensureCurrent(target);
      port.postMessage({v: 2, type: "hello", status: status(), fenceReceipts,
        ...(fleet ? {fleet: {browserInstanceId: fleet.browserInstanceId, pairingTicket}} : {})});
      await badge(PROFILE.badgeText);
      ensureCurrent(target);
      return status();
    } catch (error) {
      if (session === target) await detach(safeError(error).message);
      throw error;
    } finally {
      attaching = false;
    }
  }

  async function requireSession(id) {
    const target = session;
    if (!target) fail("NOT_ATTACHED", "Подключите вкладку Google Vids через кнопку расширения.");
    if (id !== target.id) fail("SESSION_MISMATCH", "Session ID does not match the user-attached tab.");
    let tab;
    try { tab = await chromeApi.tabs.get(target.tabId); }
    catch { await detach("Вкладка закрыта."); fail("NOT_ATTACHED", "The attached tab no longer exists."); }
    ensureCurrent(target);
    const location = parseVidsUrl(tab.url);
    if (!location || location.documentId !== target.documentId) {
      await detach("Открыт другой документ. Подключите нужную вкладку заново.");
      fail("DOCUMENT_CHANGED", "Navigation revoked the attached session.");
    }
    target.url = location.url;
    target.title = tab.title || target.title;
    return target;
  }

  async function viewport(target, screenshotRead = false) {
    const metrics = await cdp(target, "Page.getLayoutMetrics", {}, screenshotRead);
    const view = metrics.cssVisualViewport;
    if (!view || !(view.clientWidth > 0 && view.clientHeight > 0)) {
      fail("VIEWPORT_UNAVAILABLE", "The tab does not have a measurable CSS viewport.");
    }
    return {width: view.clientWidth, height: view.clientHeight};
  }

  function saveSnapshot(target, refs, bounds, epoch) {
    ensureCurrent(target);
    if (epoch !== target.epoch) fail("STALE_CAPTURE", "The document changed while observing. Observe again.");
    const snapshot = {id: crypto.randomUUID(), refs, viewport: bounds, createdAt: Date.now()};
    target.snapshot = snapshot;
    return snapshot.id;
  }

  function requireSnapshot(target, id) {
    const snapshot = target.snapshot;
    if (!snapshot || snapshot.id !== id || Date.now() - snapshot.createdAt > SNAPSHOT_MAX_AGE_MS) {
      fail("STALE_SNAPSHOT", "Observe or capture a fresh screenshot before this action.");
    }
    return snapshot;
  }

  function nodeFrom(snapshot, ref) {
    string(ref, "nodeRef", 100);
    const node = snapshot.refs.get(ref);
    if (!node) fail("UNKNOWN_NODE", "nodeRef is not present in this observation.");
    if (node.disabled) fail("DISABLED_NODE", "The observed control is disabled.");
    return node;
  }

  async function describe(target, backendNodeId) {
    const {node} = await cdp(target, "DOM.describeNode", {backendNodeId, depth: 0});
    return node;
  }

  function axProperty(node, name) {
    return node.properties?.find(property => property.name === name)?.value?.value;
  }

  function editableAX(node) {
    return Boolean(axProperty(node, "editable")) || ["textbox", "searchbox"].includes(node.role?.value);
  }

  async function accessibleFrames(target, diagnosticsEnabled = false) {
    const [{frameTree}, {root}, {nodes: rootAX}] = await Promise.all([
      cdp(target, "Page.getFrameTree"),
      cdp(target, "DOM.getDocument", {depth: -1, pierce: true}),
      cdp(target, "Accessibility.getFullAXTree"),
    ]);
    const domNodes = new Map();
    const domFrames = new Map();
    const owners = new Map();
    const remaining = [{dom: root, frameId: frameTree.frame.id}];
    while (remaining.length) {
      const {dom, frameId} = remaining.pop();
      domNodes.set(dom.backendNodeId, dom);
      domFrames.set(dom.backendNodeId, frameId);
      if (dom.frameId && ["IFRAME", "FRAME"].includes(dom.nodeName)) owners.set(dom.frameId, dom);
      remaining.push(...[...(dom.children || []), ...(dom.shadowRoots || [])].map(child => ({dom: child, frameId})));
      if (dom.contentDocument) remaining.push({dom: dom.contentDocument, frameId: dom.frameId});
    }
    const frames = new Map();
    const origin = new URL(target.url).origin;
    const originOf = value => { try { return new URL(value).origin; } catch { return null; } };
    const diagnostics = [];
    const diagnosticById = new Map();
    function inventory(tree, depth = 0) {
      if (diagnostics.length >= 48) return;
      const owner = owners.get(tree.frame.id);
      const attr = attributes(owner);
      const item = {
        frameId: tree.frame.id, parentFrameId: tree.frame.parentId ?? null, depth,
        urlOrigin: originOf(tree.frame.url),
        urlKind: tree.frame.url === "about:blank" || tree.frame.url === "about:srcdoc" ? tree.frame.url : "url",
        securityOrigin: originOf(tree.frame.securityOrigin) ?? (["", "://", "null"].includes(tree.frame.securityOrigin) ? tree.frame.securityOrigin : null),
        ownerFound: Boolean(owner), contentDocument: Boolean(owner?.contentDocument),
        ownerAriaHidden: attr["aria-hidden"] ?? null, ownerClass: attr.class?.slice(0, 160) ?? null,
        contentDocumentOrigin: originOf(owner?.contentDocument?.documentURL),
        contentDocumentNodeId: owner?.contentDocument?.nodeId ?? null,
        inspected: false, skippedReason: "ancestor_skipped", focusedRoles: [],
      };
      diagnostics.push(item);
      diagnosticById.set(tree.frame.id, item);
      for (const child of tree.childFrames || []) inventory(child, depth + 1);
    }
    if (diagnosticsEnabled) inventory(frameTree);
    let limited = false;
    async function visit(tree, parent = null, depth = 0) {
      const diagnostic = diagnosticById.get(tree.frame.id);
      if (depth > 8 || frames.size >= 24) {
        limited = true;
        if (diagnostic) diagnostic.skippedReason = "traversal_limit";
        return;
      }
      const id = tree.frame.id;
      const owner = owners.get(id);
      const ownerAttributes = attributes(owner);
      const inheritsOrigin = parent && ["about:blank", "about:srcdoc"].includes(tree.frame.url) &&
        tree.frame.securityOrigin === "://" && owner?.contentDocument?.documentURL === tree.frame.url &&
        (!Object.hasOwn(ownerAttributes, "sandbox") || ownerAttributes.sandbox.split(/\s+/).includes("allow-same-origin")) &&
        !Object.hasOwn(ownerAttributes, "csp") &&
        (tree.frame.url === "about:srcdoc" ? Object.hasOwn(ownerAttributes, "srcdoc") :
          !Object.hasOwn(ownerAttributes, "srcdoc") && ["", "about:blank"].includes((ownerAttributes.src || "").trim()));
      // Limit child inspection to same-origin, same-target documents with an
      // observed iframe owner. Initial blank/srcdoc documents inherit their
      // allowed parent's origin; sandbox/CSP opaque origins are not accepted.
      // No auto-attachment to cross-origin/OOPIF targets.
      const skippedReason = parent && (tree.frame.securityOrigin !== origin && !inheritsOrigin ? "security_origin_mismatch" :
        !owner ? "missing_iframe_owner" : !owner.contentDocument ? "missing_content_document" :
          tree.frame.parentId !== parent.id ? "parent_mismatch" : null);
      if (skippedReason) { if (diagnostic) diagnostic.skippedReason = skippedReason; return; }
      const nodes = parent ? (await cdp(target, "Accessibility.getFullAXTree", {frameId: id})).nodes : rootAX;
      if (diagnostic) {
        diagnostic.inspected = true;
        diagnostic.originMode = inheritsOrigin ? "inherited_blank_document" : "explicit_origin";
        diagnostic.skippedReason = null;
        diagnostic.axNodeCount = nodes.length;
        diagnostic.focusedRoles = nodes.filter(node => axProperty(node, "focused") === true).map(node => ({
          role: node.role?.value ?? null, ignored: node.ignored === true, editable: Boolean(axProperty(node, "editable")),
        })).slice(0, 8);
      }
      const frame = {id, parent, owner, nodes, children: []};
      frames.set(id, frame);
      if (parent) parent.children.push(frame);
      for (const child of tree.childFrames || []) await visit(child, frame, depth + 1);
    }
    await visit(frameTree);
    for (const diagnostic of diagnostics) {
      const owner = owners.get(diagnostic.frameId);
      const editable = [...domNodes.values()].filter(node => domFrames.get(node.backendNodeId) === diagnostic.frameId &&
        (node.nodeName === "TEXTAREA" || (Object.hasOwn(attributes(node), "contenteditable") && attributes(node).contenteditable !== "false")));
      diagnostic.editableDOMCount = editable.length;
      diagnostic.editableDOMKinds = [...new Set(editable.map(node => node.nodeName))].slice(0, 8);
      if (owner?.contentDocument?.nodeId && rootAX.some(node => node.backendDOMNodeId === owner.backendNodeId && axProperty(node, "focused") === true)) {
        try {
          const {nodeId} = await cdp(target, "DOM.querySelector", {nodeId: owner.contentDocument.nodeId, selector: ":focus"});
          if (nodeId) {
            const {node} = await cdp(target, "DOM.describeNode", {nodeId, depth: 0});
            const attr = attributes(node);
            diagnostic.focusedDOM = {nodeName: node.nodeName, role: attr.role ?? null,
              contenteditable: attr.contenteditable ?? null, inputType: attr.type ?? null};
          } else diagnostic.focusedDOM = null;
        } catch (error) { diagnostic.focusQueryError = safeError(error).code; }
      }
    }
    for (const [backendId, frameId] of domFrames) if (!frames.has(frameId)) domNodes.delete(backendId);
    return {frames, rootFrame: frames.get(frameTree.frame.id), domNodes, domFrames, limited,
      diagnostics: {inspectedFrames: frames.size, listedFrames: diagnostics.length, frames: diagnostics}};
  }

  async function focusedEditor(target, rootFrame) {
    const hasFocusedRoot = frame => frame.nodes.some(node => node.role?.value === "RootWebArea" && axProperty(node, "focused") === true) ||
      frame.children.some(hasFocusedRoot);
    let frame = rootFrame;
    let ownerExplicitlyFocused = false;
    for (let depth = 0; frame && depth <= 8; depth += 1) {
      const focused = frame.nodes.filter(node => node.role?.value !== "RootWebArea" && axProperty(node, "focused") === true);
      if (focused.length > 1) return null;
      if (focused.length === 1) {
        const node = focused[0];
        if (["Iframe", "IframePresentational"].includes(node.role?.value)) {
          frame = frame.children.find(child => child.owner?.backendNodeId === node.backendDOMNodeId);
          ownerExplicitlyFocused = true;
          continue;
        }
        return editableAX(node) ? node : null;
      }
      if (ownerExplicitlyFocused && frame.owner?.contentDocument?.nodeId) {
        // Google Vids directs canvas editing into an aria-hidden blank iframe.
        // AX omits that editor. The focused owner plus the child's actual :focus
        // element proves the input target without executing page JavaScript.
        const {nodeId} = await cdp(target, "DOM.querySelector", {nodeId: frame.owner.contentDocument.nodeId, selector: ":focus"});
        if (nodeId) {
          const {node} = await cdp(target, "DOM.describeNode", {nodeId, depth: 0});
          if (["IFRAME", "FRAME"].includes(node.nodeName)) {
            frame = frame.children.find(child => child.owner?.backendNodeId === node.backendNodeId);
            continue;
          }
          const attr = attributes(node);
          const editable = node.nodeName === "TEXTAREA" ||
            (node.nodeName === "INPUT" && ["", "text", "search", "email", "url", "tel", "number", "password"].includes((attr.type || "").toLowerCase())) ||
            (Object.hasOwn(attr, "contenteditable") && attr.contenteditable !== "false");
          if (editable) return {backendDOMNodeId: node.backendNodeId, role: {value: attr.role || "textbox"},
            _frameId: frame.id, _domFocused: true,
            properties: [{name: "focused", value: {value: true}}, {name: "editable", value: {value: true}}]};
          return null;
        }
      }
      // Chromium may omit `focused` on iframe owners. In that case descend
      // only the unique branch containing a focused RootWebArea, never an
      // arbitrary child textbox that merely remembers its local selection.
      const activeBranches = frame.children.filter(hasFocusedRoot);
      if (activeBranches.length !== 1) return null;
      frame = activeBranches[0];
      ownerExplicitlyFocused = false;
    }
    return null;
  }

  async function observe(target, params) {
    const maxNodes = integer(params.maxNodes ?? 500, "maxNodes", 1, 1500);
    if (params.diagnostics !== undefined && typeof params.diagnostics !== "boolean") fail("INVALID_ARGUMENT", "diagnostics must be boolean.");
    const epoch = target.epoch;
    const [{frames, rootFrame, domNodes, limited, diagnostics}, bounds] = await Promise.all([accessibleFrames(target, params.diagnostics === true), viewport(target)]);
    const axNodes = [];
    for (const frame of frames.values()) {
      for (const node of frame.nodes) {
        axNodes.push({...node, _frameId: frame.id,
          _ownerBackendId: node.role?.value === "RootWebArea" ? frame.owner?.backendNodeId : undefined});
      }
    }
    const activeEditor = await focusedEditor(target, rootFrame);
    if (activeEditor?._domFocused && !axNodes.some(node => !node.ignored && node.backendDOMNodeId === activeEditor.backendDOMNodeId)) {
      axNodes.unshift({...activeEditor, nodeId: `dom-focus-${activeEditor.backendDOMNodeId}`,
        name: {value: "Focused Vids text editor"}});
    }
    const refs = new Map();
    const axToRef = new Map();
    const backendToRef = new Map();
    const nodes = [];
    const candidates = axNodes.filter(node => {
      const role = node.role?.value;
      if (node.ignored || !role || role === "InlineTextBox") return false;
      if (role === "generic" || role === "StaticText") {
        return Boolean(String(node.name?.value ?? "").trim() || node.value?.value !== undefined ||
          axProperty(node, "focused") || axProperty(node, "editable"));
      }
      return true;
    });
    for (const ax of candidates.slice(0, maxNodes)) {
      const states = Object.fromEntries((ax.properties || []).map(item => [item.name, item.value?.value]));
      const ref = `n${nodes.length + 1}`;
      let password = false;
      let fileInput = false;
      if (ax.backendDOMNodeId && ["textbox", "searchbox", "combobox", "button"].includes(ax.role.value)) {
        try {
          const dom = domNodes.get(ax.backendDOMNodeId) || await describe(target, ax.backendDOMNodeId);
          password = isPassword(dom);
          fileInput = isFileInput(dom);
        } catch (error) {
          ensureCurrent(target);
          // A detached DOM node has no valid action reference.
          if (error?.code === "NOT_ATTACHED") throw error;
          continue;
        }
      }
      const item = {
        ref, role: fileInput ? "file-input" : String(ax.role.value),
        name: String(ax.name?.value ?? "").slice(0, 2000),
      };
      axToRef.set(`${ax._frameId}:${ax.nodeId}`, ref);
      if (ax.backendDOMNodeId) backendToRef.set(ax.backendDOMNodeId, ref);
      if (password) item.value = "[redacted]";
      else if (ax.value?.value !== undefined) item.value = String(ax.value.value).slice(0, 4000);
      if (ax.description?.value && !password) item.description = String(ax.description.value).slice(0, 2000);
      const publicStates = ["disabled", "focused", "editable", "selected", "checked", "expanded", "pressed", "multiline"];
      item.states = Object.fromEntries(publicStates.filter(key => states[key] !== undefined).map(key => [key, states[key]]));
      if (password) item.states.protected = true;
      item._parentId = ax.parentId ? `${ax._frameId}:${ax.parentId}` : null;
      item._ownerBackendId = ax._ownerBackendId;
      nodes.push(item);
      if (ax.backendDOMNodeId) refs.set(ref, {
        backendNodeId: ax.backendDOMNodeId, disabled: states.disabled === true,
        editable: Boolean(states.editable), password, role: item.role, name: item.name,
        frameId: ax._frameId,
      });
    }
    // Hidden file inputs often have no AX node. Expose only those DOM controls,
    // never page HTML, hidden text, input values or arbitrary attributes.
    if (nodes.length < maxNodes) {
      const seen = new Set([...refs.values()].map(node => node.backendNodeId));
      for (const dom of domNodes.values()) {
        if (nodes.length >= maxNodes) break;
        if (isFileInput(dom) && !seen.has(dom.backendNodeId)) {
          const ref = `n${nodes.length + 1}`;
          const attr = attributes(dom);
          nodes.push({ref, role: "file-input", name: attr["aria-label"] || attr.title || "File upload", states: {}});
          refs.set(ref, {backendNodeId: dom.backendNodeId, role: "file-input", disabled: Object.hasOwn(attr, "disabled")});
          seen.add(dom.backendNodeId);
        }
      }
    }
    for (const node of nodes) {
      if (axToRef.has(node._parentId)) node.parentRef = axToRef.get(node._parentId);
      else if (backendToRef.has(node._ownerBackendId)) node.parentRef = backendToRef.get(node._ownerBackendId);
      delete node._parentId;
      delete node._ownerBackendId;
    }
    return {
      snapshotId: saveSnapshot(target, refs, bounds, epoch),
      documentId: target.documentId, url: target.url, title: target.title,
      viewport: bounds, coordinateSpace: "css-viewport", nodes,
      truncated: candidates.length > maxNodes || limited,
      ...(params.diagnostics === true ? {frameDiagnostics: diagnostics} : {}),
    };
  }

  async function captureFrame(target, params) {
    ensureCurrent(target);
    requireScreenshotReady(target);
    const started = Date.now();
    const send = (method, params = {}) => Promise.resolve().then(() => {
      ensureCurrent(target);
      return chromeApi.debugger.sendCommand({tabId: target.tabId}, method, params);
    });
    let resolveFrame, rejectFrame;
    const frame = new Promise((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject; });
    // The start ACK can be delayed past a cancellation. Observe the rejection
    // immediately, even while the command still waits for that ACK.
    frame.catch(() => {});
    const capture = {
      started, done: false, frameId: null, acknowledgements: [],
      cancel(error) { if (!capture.done) { capture.done = true; rejectFrame(error); } },
      accept(event) {
        if (session !== target || target.capture !== capture || capture.done) return;
        if (!Number.isInteger(event.sessionId)) return;
        const timestamp = event.metadata?.timestamp;
        // Chromium can finish encoding an older stream's frame using the new
        // stream id. Require capture time as well as our session/epoch guards.
        if (!Number.isFinite(timestamp) || timestamp * 1000 < started) {
          const ack = send("Page.screencastFrameAck", {sessionId: event.sessionId});
          ack.catch(error => capture.cancel(error));
          capture.acknowledgements.push(ack);
          return;
        }
        capture.done = true;
        capture.frameId = event.sessionId;
        resolveFrame({data: event.data});
      },
    };
    target.capture = capture;
    const command = (async () => {
      try {
        await send("Page.startScreencast", {
          ...params, everyNthFrame: 1, maxFramesInFlight: 1, sendLastFrame: false,
        });
        ensureCurrent(target);
        return await frame;
      } finally {
        capture.done = true;
        if (session === target && target.capture === capture) {
          try {
            // Queue stop immediately after ACK, without waiting for the ACK.
            // A stalled response must not leave a recording stream running.
            if (capture.frameId !== null) {
              capture.acknowledgements.push(send("Page.screencastFrameAck", {sessionId: capture.frameId}));
            }
            const stop = send("Page.stopScreencast");
            const results = await Promise.allSettled([...capture.acknowledgements, stop]);
            if (results.at(-1).status === "rejected" && session === target) {
              invalidate(target);
              target.pendingRead = {method: "Page.stopScreencast", started, cleanupFailed: true};
              diagnostic(target, "read_cleanup_failed", "Page.stopScreencast", started);
            }
            const failure = results.find(result => result.status === "rejected");
            if (failure) throw failure.reason;
          } finally {
            if (target.capture === capture) target.capture = null;
          }
        }
      }
    })();
    return commandWithDeadline(target, "Page.startScreencast", command, true, started, error => capture.cancel(error));
  }

  async function screenshot(target, params) {
    const format = params.format ?? "png";
    if (!["png", "jpeg"].includes(format)) fail("INVALID_ARGUMENT", "format must be png or jpeg.");
    const quality = params.quality === undefined ? undefined : integer(params.quality, "quality", 1, 100);
    const epoch = target.epoch;
    const bounds = await viewport(target, true);
    const {data} = await captureFrame(target, {
      format, ...(format === "jpeg" && quality !== undefined ? {quality} : {}),
    });
    const binary = Uint8Array.from(atob(data), value => value.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([binary], {type: `image/${format}`}));
    const image = {
      width: bitmap.width, height: bitmap.height,
      scaleX: bitmap.width / bounds.width, scaleY: bitmap.height / bounds.height,
    };
    bitmap.close();
    return {
      snapshotId: saveSnapshot(target, new Map(), bounds, epoch),
      mimeType: `image/${format}`, data, viewport: bounds, image,
      coordinateSpace: "css-viewport",
    };
  }

  async function nodePoint(target, node, bounds) {
    if (node.password) fail("PROTECTED_FIELD", "Password controls cannot be automated by this bridge.");
    await cdp(target, "DOM.scrollIntoViewIfNeeded", {backendNodeId: node.backendNodeId});
    const {quads} = await cdp(target, "DOM.getContentQuads", {backendNodeId: node.backendNodeId});
    const quad = quads?.find(points => points.length === 8);
    if (!quad) fail("NODE_NOT_VISIBLE", "The observed control has no visible layout box.");
    return point({
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    }, bounds, "node center");
  }

  async function nodeAtPoint(target, position) {
    const {cssVisualViewport: view} = await cdp(target, "Page.getLayoutMetrics");
    // DOM hit testing takes document CSS coordinates, unlike viewport-relative
    // Input events and content quads. Read offsets after any automatic scroll.
    const pageX = finiteNumber(view?.pageX, "viewport pageX");
    const pageY = finiteNumber(view?.pageY, "viewport pageY");
    return cdp(target, "DOM.getNodeForLocation", {
      x: Math.round(position.x + pageX), y: Math.round(position.y + pageY),
      includeUserAgentShadowDOM: false, ignorePointerEventsNone: false,
    });
  }

  async function requireNodeHit(target, node, position) {
    const {nodes} = await cdp(target, "Accessibility.getPartialAXTree", {
      backendNodeId: node.backendNodeId, fetchRelatives: false,
    });
    const current = nodes.find(item => item.backendDOMNodeId === node.backendNodeId);
    if (!current || current.ignored || current.role?.value !== node.role ||
        String(current.name?.value ?? "").slice(0, 2000) !== node.name) {
      fail("TARGET_CHANGED", "The observed control changed. Observe again before clicking.");
    }
    if (axProperty(current, "disabled") === true) fail("DISABLED_NODE", "The control is now disabled.");
    const {node: dom} = await cdp(target, "DOM.describeNode", {
      backendNodeId: node.backendNodeId, depth: -1, pierce: true,
    });
    const descendants = new Set();
    const remaining = [dom];
    while (remaining.length) {
      const child = remaining.pop();
      descendants.add(child.backendNodeId);
      // A label/span/SVG or shadow child may receive the pointer on its
      // control's behalf. Never treat an embedded document as that control.
      remaining.push(...(child.children || []), ...(child.shadowRoots || []));
    }
    const hit = await nodeAtPoint(target, position);
    if (hit.frameId !== node.frameId || !descendants.has(hit.backendNodeId)) {
      fail("TARGET_OBSCURED", "The observed control is covered or clipped at the click point. Further input was stopped; observe again.");
    }
  }

  async function press(target, key, modifiers) {
    const event = keyEvent(key, modifiers);
    const {text: unused, ...keyUp} = event;
    try {
      await cdp(target, "Input.dispatchKeyEvent", {type: "keyDown", ...event});
    } finally {
      if (session === target) await cdp(target, "Input.dispatchKeyEvent", {type: "keyUp", ...keyUp});
    }
  }

  async function focusEditable(target, node, setFocus = true) {
    if (node && setFocus) {
      const dom = await describe(target, node.backendNodeId);
      if (node.password || isPassword(dom)) fail("PROTECTED_FIELD", "Password fields are excluded.");
      const attr = attributes(dom);
      const name = dom.nodeName?.toLowerCase();
      const inputTypes = ["text", "search", "email", "url", "tel", "number", ""];
      const editable = node.editable || name === "textarea" ||
        (name === "input" && inputTypes.includes((attr.type || "").toLowerCase())) ||
        (Object.hasOwn(attr, "contenteditable") && attr.contenteditable !== "false");
      if (!editable) fail("FOCUS_NOT_EDITABLE", "The observed node is not a text editor.");
      await cdp(target, "DOM.focus", {backendNodeId: node.backendNodeId});
    }
    const {rootFrame} = await accessibleFrames(target);
    const focused = await focusedEditor(target, rootFrame);
    if (!focused?.backendDOMNodeId) {
      fail("FOCUS_NOT_EDITABLE", "Activate a Vids text box and observe again before inserting text.");
    }
    if (isPassword(await describe(target, focused.backendDOMNodeId))) {
      fail("PROTECTED_FIELD", "Password fields are excluded.");
    }
    if (node && node.backendNodeId !== focused.backendDOMNodeId) {
      fail("FOCUS_NOT_EDITABLE", "Focus moved away from the observed text editor. Observe again.");
    }
    return focused;
  }

  function uploadFiles(files) {
    if (!Array.isArray(files) || !files.length || files.length > 20 ||
        files.some(file => typeof file !== "string" || !file.startsWith("/") || file.includes("\0") || file.length > 4096)) {
      fail("INVALID_ARGUMENT", "files must contain 1–20 absolute local paths validated by the native host.");
    }
    return files;
  }

  async function requireSafePickerHit(target, position) {
    const {frames, domNodes, domFrames} = await accessibleFrames(target);
    const hit = await nodeAtPoint(target, position);
    const node = domNodes.get(hit.backendNodeId);
    // Root-target interception does not cover a cross-origin OOPIF. Prove the
    // actual hit is in an inspected same-target frame BEFORE mousePressed.
    // An iframe owner is not proof of its embedded document's input target.
    if (!frames.has(hit.frameId) || domFrames.get(hit.backendNodeId) !== hit.frameId ||
        !node || ["IFRAME", "FRAME"].includes(node.nodeName)) {
      fail("FILE_CHOOSER_MISMATCH", "The upload trigger is not a verified element in an allowed same-origin frame. No trigger click was sent.");
    }
  }

  function pickerMismatch(reason) {
    fail("FILE_CHOOSER_MISMATCH", `The picker does not match one file input in the attached document (${reason}).`);
  }

  async function requirePickerOwnerDocument(target, chooser) {
    let objectId;
    try {
      // A detached input is absent from getDocument. Resolve only the input
      // reported by Chrome, inside the already allowed chooser frame. This
      // fixed, read-only predicate is not exposed as an evaluation tool.
      const {executionContextId} = await cdp(target, "Page.createIsolatedWorld", {
        frameId: chooser.frameId, worldName: "vids-studio-picker-owner", grantUniveralAccess: false,
      });
      const {object} = await cdp(target, "DOM.resolveNode", {backendNodeId: chooser.backendNodeId, executionContextId});
      objectId = object?.objectId;
      if (!objectId) pickerMismatch("owner_document_unverified");
      const response = await cdp(target, "Runtime.callFunctionOn", {
        objectId, returnByValue: true,
        functionDeclaration: 'function() { return Object.getOwnPropertyDescriptor(Node.prototype, "ownerDocument").get.call(this) === document; }',
      });
      if (response.exceptionDetails || response.result?.value !== true) pickerMismatch("owner_document_mismatch");
      return objectId;
    } catch (error) {
      if (objectId && session === target) await cdp(target, "Runtime.releaseObject", {objectId}).catch(() => {});
      ensureCurrent(target);
      if (error?.code === "FILE_CHOOSER_MISMATCH") throw error;
      pickerMismatch("owner_document_unverified");
    }
  }

  async function uploadViaPicker(target, params, snapshot, bounds) {
    const files = uploadFiles(params.files);
    if (params.nodeRef !== undefined && (params.x !== undefined || params.y !== undefined)) {
      fail("INVALID_ARGUMENT", "Choose nodeRef or x/y coordinates, not both.");
    }
    const observedPosition = params.nodeRef !== undefined
      ? await nodePoint(target, nodeFrom(snapshot, params.nodeRef), bounds)
      : point(params, bounds);
    // Hit testing accepts integer CSS coordinates. Use those same coordinates
    // for the input, avoiding a different target at a fractional boundary.
    const position = point({x: Math.round(observedPosition.x), y: Math.round(observedPosition.y)}, bounds);
    await requireSafePickerHit(target, position);
    let resolveChooser, rejectChooser, timer, ownerObjectId;
    let settled = false;
    const pending = new Promise((resolve, reject) => { resolveChooser = resolve; rejectChooser = reject; });
    // An event or detach can reject while the click command is still in flight.
    // The real error is consumed below, without an unhandled promise rejection.
    pending.catch(() => {});
    const waiter = {
      clicked: false, duplicate: false,
      cancel(code, message) {
        if (settled) return;
        settled = true;
        const error = new Error(message);
        error.code = code;
        rejectChooser(error);
      },
      receive(event) {
        if (settled) { waiter.duplicate = true; return; }
        if (!waiter.clicked) {
          waiter.cancel("FILE_CHOOSER_MISMATCH", "A chooser opened before the observed trigger was clicked.");
          return;
        }
        settled = true;
        resolveChooser(event);
      },
    };
    target.fileChooser = waiter;
    try {
      await cdp(target, "Page.setInterceptFileChooserDialog", {enabled: true, cancel: false});
      await cdp(target, "Input.dispatchMouseEvent", {type: "mouseMoved", ...position});
      // Hover can expose an overlay or move an iframe over a previously safe
      // reference. Recheck the actual hit after hover and before the click.
      await requireSafePickerHit(target, position);
      // A premature chooser or revocation can cancel while preflight awaits
      // CDP. Propagate that rejection without sending a new trigger click.
      if (settled) return await pending;
      waiter.clicked = true;
      // Hover and hit verification have their own CDP deadlines. Start the
      // chooser budget only when its trigger is ready, not before preflight.
      timer = setTimeout(() => waiter.cancel("FILE_CHOOSER_TIMEOUT",
        "No intercepted file input appeared. Inspect the tab before another action; do not repeat this upload automatically."), FILE_CHOOSER_TIMEOUT_MS);
      await clickPair(target, {...position, button: "left", clickCount: 1});
      const chooser = await pending;
      clearTimeout(timer);
      if (!Number.isInteger(chooser.backendNodeId) || !["selectSingle", "selectMultiple"].includes(chooser.mode)) {
        fail("UNSUPPORTED_FILE_CHOOSER", "The intercepted picker is not backed by a supported file input.");
      }
      if (chooser.mode === "selectSingle" && files.length !== 1) {
        fail("FILE_CHOOSER_MISMATCH", "The observed picker accepts one file.");
      }
      // Recheck authority after the click, then map the input to the same
      // bounded, same-origin frame inventory used by observation.
      await requireSession(target.id);
      const {frames, domNodes, domFrames} = await accessibleFrames(target);
      if (waiter.duplicate) pickerMismatch("duplicate_chooser");
      if (!frames.has(chooser.frameId)) pickerMismatch("frame_not_allowed");
      const inventoried = domNodes.has(chooser.backendNodeId);
      if ((inventoried || domFrames.has(chooser.backendNodeId)) && domFrames.get(chooser.backendNodeId) !== chooser.frameId) pickerMismatch("inventory_frame_mismatch");
      let input = domNodes.get(chooser.backendNodeId);
      if (!inventoried) {
        try { input = await describe(target, chooser.backendNodeId); }
        catch { ensureCurrent(target); pickerMismatch("input_unavailable"); }
      }
      if (!isFileInput(input)) pickerMismatch("not_file_input");
      if (Object.hasOwn(attributes(input), "disabled") || Object.hasOwn(attributes(input), "webkitdirectory")) {
        fail("UNSUPPORTED_FILE_CHOOSER", "Disabled file inputs and directory selection are not supported.");
      }
      if (!inventoried) ownerObjectId = await requirePickerOwnerDocument(target, chooser);
      if (waiter.duplicate) pickerMismatch("duplicate_chooser");
      await cdp(target, "DOM.setFileInputFiles", {backendNodeId: chooser.backendNodeId, files});
    } finally {
      clearTimeout(timer);
      // Do not disable interception: a page can schedule its chooser after
      // our deadline. Return to cancellation while this tab is attached.
      try {
        if (session === target) await cdp(target, "Page.setInterceptFileChooserDialog", {enabled: true, cancel: true});
      } finally {
        if (target.fileChooser === waiter) target.fileChooser = null;
        // Release after selection/cancellation, not in the gap between the
        // ownerDocument predicate and setFileInputFiles.
        if (ownerObjectId && session === target) await cdp(target, "Runtime.releaseObject", {objectId: ownerObjectId}).catch(() => {});
      }
    }
  }

  async function mutate(target, method, params, snapshot, requestId) {
    const bounds = await viewport(target);
    if (target.snapshot !== snapshot) fail("STALE_SNAPSHOT", "The document changed before the action. Observe again.");
    if (bounds.width !== snapshot.viewport.width || bounds.height !== snapshot.viewport.height) {
      fail("STALE_SNAPSHOT", "The viewport resized. Observe again.");
    }
    // Invalidate before any input or scrolling: even a failed multi-step action
    // may have moved focus or changed the document.
    invalidate(target);
    if (method === "click") {
      const button = params.button ?? "left";
      if (!["left", "right", "middle"].includes(button)) fail("INVALID_ARGUMENT", "Invalid mouse button.");
      const clickCount = integer(params.clickCount ?? 1, "clickCount", 1, 2);
      if (params.nodeRef !== undefined && (params.x !== undefined || params.y !== undefined)) {
        fail("INVALID_ARGUMENT", "Choose nodeRef or x/y coordinates, not both.");
      }
      const node = params.nodeRef !== undefined ? nodeFrom(snapshot, params.nodeRef) : null;
      const observedPosition = node ? await nodePoint(target, node, bounds) : point(params, bounds);
      // Use the same integer CSS point for hit testing and pointer input.
      // Coordinate-only canvas actions retain their existing behavior.
      const position = node
        ? point({x: Math.round(observedPosition.x), y: Math.round(observedPosition.y)}, bounds)
        : observedPosition;
      if (node) await requireNodeHit(target, node, position);
      await cdp(target, "Input.dispatchMouseEvent", {type: "mouseMoved", ...position});
      for (let count = 1; count <= clickCount; count += 1) {
        // Hover or the first click can move a toolbar or expose an overlay.
        // Recheck the actual recipient instead of following stale geometry.
        if (node) await requireNodeHit(target, node, position);
        await clickPair(target, {...position, button, clickCount: count});
      }
    } else if (method === "drag") {
      const from = point(params.from, bounds, "from");
      const to = point(params.to, bounds, "to");
      const steps = integer(params.steps ?? 12, "steps", 2, 60);
      await cdp(target, "Input.dispatchMouseEvent", {type: "mouseMoved", ...from});
      const pending = [];
      const dispatch = event => {
        const acknowledgement = cdp(target, "Input.dispatchMouseEvent", event);
        // A rejected ACK can arrive during a pacing wait, before allSettled.
        acknowledgement.catch(() => {});
        pending.push(acknowledgement);
      };
      const pace = () => new Promise(resolve => setTimeout(resolve, DRAG_STEP_INTERVAL_MS));
      try {
        // Keep dispatch independent of delayed ACKs, but allow frame-driven UI
        // state to progress instead of coalescing the entire gesture into a burst.
        // Timers are best effort, not a guarantee of a rendered browser frame.
        dispatch({type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1});
        await pace();
        for (let i = 1; i <= steps && session === target; i += 1) {
          dispatch({
            type: "mouseMoved", x: from.x + (to.x - from.x) * i / steps,
            y: from.y + (to.y - from.y) * i / steps, button: "left", buttons: 1,
          });
          // Includes a final interval before release so its handler can commit
          // the last rendered value rather than the preceding frame's state.
          await pace();
        }
      } finally {
        if (session === target) dispatch({type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1});
        // Drain every ACK, including release, on failure or revocation too.
        const results = await Promise.allSettled(pending);
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
      }
    } else if (method === "scroll") {
      const position = point(params, bounds);
      const deltaX = finiteNumber(params.deltaX ?? 0, "deltaX", -100000, 100000);
      const deltaY = finiteNumber(params.deltaY, "deltaY", -100000, 100000);
      await scrollWheel(target, {type: "mouseWheel", ...position, deltaX, deltaY}, requestId);
    } else if (method === "type_text") {
      string(params.text, "text", 100000, true);
      if (params.replace !== undefined && typeof params.replace !== "boolean") fail("INVALID_ARGUMENT", "replace must be boolean.");
      const node = params.nodeRef === undefined ? undefined : nodeFrom(snapshot, params.nodeRef);
      const focused = await focusEditable(target, node);
      if (params.replace) {
        await press(target, "a", ["Control"]);
        await focusEditable(target, {backendNodeId: focused.backendDOMNodeId}, false);
        // Vids mirrors selection in its offscreen editor. insertText alone can
        // prepend to that virtual selection; an edit key removes it reliably.
        await press(target, "Backspace", []);
        // Controlled inputs can replace themselves or move focus on deletion.
        // Do not refocus a stale field or insert the new text elsewhere.
        await focusEditable(target, {backendNodeId: focused.backendDOMNodeId}, false);
      }
      await cdp(target, "Input.insertText", {text: params.text});
    } else if (method === "press_key") {
      await press(target, params.key, params.modifiers);
    } else if (method === "upload") {
      const node = nodeFrom(snapshot, params.nodeRef);
      const files = uploadFiles(params.files);
      if (!isFileInput(await describe(target, node.backendNodeId))) fail("NOT_FILE_INPUT", "The observed node is not a file input.");
      await cdp(target, "DOM.setFileInputFiles", {backendNodeId: node.backendNodeId, files});
    } else if (method === "upload_via_picker") {
      await uploadViaPicker(target, params, snapshot, bounds);
    }
    ensureCurrent(target);
    return {performed: true, needsObservation: true};
  }

  async function execute(request) {
    const id = typeof request?.id === "string" ? request.id.slice(0, 128) : "invalid";
    let mutationStarted = false;
    try {
      plainObject(request, "request");
      if (request.v !== 2 || request.type !== "request") fail("INVALID_REQUEST", "Unsupported bridge protocol envelope.");
      string(request.id, "id", 128);
      const params = plainObject(request.params ?? {});
      let result;
      if (request.method === "status") {
        if (session) await requireSession(session.id);
        result = status();
      } else {
        if (!CAPABILITIES.includes(request.method)) fail("UNKNOWN_METHOD", "This browser operation is not exposed.");
        const target = await requireSession(request.sessionId);
        if (target.pendingInput && !READ_OPERATIONS.has(request.method)) fail("BROWSER_RECOVERING",
          "A timed-out scroll is still pending in Chrome. Observe/status remain available, but no new mutation is allowed until it settles and control is reconciled. Do not replay it.");
        if (request.method === "export_preflight") {
          // Fresh in-memory state for this attachment only. No CDP, broad download
          // history search, menu interaction or cached native status is involved.
          result = {sessionId: target.id, documentId: target.documentId, exportWatch: await exports.preflight(target.id)};
        }
        else if (request.method === "observe") result = await observe(target, params);
        else if (request.method === "screenshot") result = await screenshot(target, params);
        else if (request.method === "export_download_status") result = await exports.status(params.jobId, target.id);
        else if (request.method === "export_trigger") {
          const checkedAt = Date.parse(params.downloadModeCheckedAt);
          if (params.automaticDownloadConfirmed !== true || !Number.isFinite(checkedAt) ||
              Date.now() - checkedAt > 900000 || checkedAt > Date.now() + 5000) {
            fail("AUTOMATIC_DOWNLOAD_REQUIRED", "Confirm that this browser profile saves downloads automatically, with evidence checked in the last 15 minutes, before starting an export.");
          }
          const snapshot = requireSnapshot(target, params.snapshotId);
          const node = nodeFrom(snapshot, params.nodeRef);
          if (node.role !== "menuitem" || !/^MP4 video \(\.mp4\)(?: d)?$/.test(node.name)) {
            fail("EXPORT_TARGET_MISMATCH", "The fresh observed target must be the verified MP4 video menu item.");
          }
          exports.arm({jobId: params.jobId, sessionId: target.id, frameId: target.frameId,
            documentId: target.documentId, tabId: target.tabId});
          try {
            mutationStarted = true;
            await mutate(target, "click", {nodeRef: params.nodeRef}, snapshot);
            exports.markTriggerAccepted(params.jobId);
            result = {performed: true, jobId: params.jobId, state: "waiting", needsObservation: true};
          } catch (error) {
            exports.markTriggerUnknown(params.jobId);
            throw error;
          }
        }
        else {
          const snapshot = requireSnapshot(target, params.snapshotId);
          mutationStarted = true;
          result = await mutate(target, request.method, params, snapshot, id);
        }
      }
      return {v: 2, type: "response", id, ok: true, result};
    } catch (error) {
      const detail = safeError(error);
      if (mutationStarted) detail.outcome = "unknown";
      return {v: 2, type: "response", id, ok: false, error: detail,
        ...(error?.inputUnsettled === true ? {settled: false, sessionId: request.sessionId} : {})};
    }
  }

  function handleRequest(request) {
    // Serialize active requests. A timed-out screenshot read is discard-only:
    // it cannot publish a snapshot, and only another screenshot must wait for it.
    // Repeated ids return their prior promise, never repeat an input operation.
    const key = typeof request?.id === "string" ? `${request.sessionId || "status"}:${request.id}` : null;
    if (key && completed.has(key)) return completed.get(key);
    // This metadata read must not wait behind a stalled screenshot or input.
    // execute still validates the envelope and the exact live tab binding.
    const metadataRead = request?.method === "export_preflight";
    const promise = metadataRead ? execute(request) : requestQueue.then(() => execute(request));
    if (!metadataRead) requestQueue = promise.then(() => {}, () => {});
    if (key) {
      completed.set(key, promise);
      if (completed.size > 256) completed.delete(completed.keys().next().value);
    }
    return promise;
  }

  function onDebuggerEvent(source, method, params = {}) {
    const target = session;
    if (!target || source.tabId !== target.tabId || source.sessionId) return;
    exports.onDebuggerEvent(source, method, params);
    if (method === "Page.screencastFrame") target.capture?.accept(params);
    if (method === "Page.fileChooserOpened") target.fileChooser?.receive(params);
    if (method === "DOM.documentUpdated" || method === "Page.frameResized") invalidate(target);
    if (method === "Page.frameNavigated" && !params.frame?.parentId) {
      const location = parseVidsUrl(params.frame?.url);
      if (!location || location.documentId !== target.documentId) {
        void detach("Переход на другой документ отключил управление.");
      } else {
        target.frameId = params.frame.id;
        target.url = location.url;
        invalidate(target);
      }
    }
    if (method === "Page.navigatedWithinDocument" && params.frameId === target.frameId) {
      const location = parseVidsUrl(params.url);
      if (!location || location.documentId !== target.documentId) void detach("Документ изменился.");
      else { target.url = location.url; invalidate(target); }
    }
  }

  function onDebuggerDetach(source, reason) {
    if (session?.tabId === source.tabId) void detach(`Chrome отключил управление: ${reason}`, true);
  }

  function onTabUpdated(tabId, changeInfo) {
    if (session?.tabId !== tabId || !changeInfo.url) return;
    const location = parseVidsUrl(changeInfo.url);
    if (!location || location.documentId !== session.documentId) void detach("Вкладка открыла другой документ.");
    else if (location.url !== session.url) { session.url = location.url; invalidate(session); }
  }

  function onTabRemoved(tabId) {
    if (session?.tabId === tabId) void detach("Вкладка закрыта.", true);
  }

  return {attach, detach, status, handleRequest, onDebuggerEvent, onDebuggerDetach, onTabUpdated, onTabRemoved,
    dispose: () => exports.dispose()};
}
