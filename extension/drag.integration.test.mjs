import {chromeStorage} from '../tests/chrome-storage.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import {chromium} from "playwright";
import {createDriver} from "./driver.js";

test("a scene edge commits its RAF-rendered size before delayed drag acknowledgements arrive", async () => {
  // Isolated Chromium, locally fulfilled HTML, no Google or user profile.
  const browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 800, height: 600}});
  const url = "https://docs.google.com/videos/d/drag_ack_fixture/edit";
  await context.route("**/*", route => route.request().url() === url
    ? route.fulfill({contentType: "text/html", body: `<!doctype html><style>
      body{margin:0}#clip{position:absolute;left:40px;top:80px;width:120px;height:60px;background:#123}
      #edge{position:absolute;right:0;width:10px;height:60px;background:#cdf;touch-action:none}
      </style><div id="clip"><div id="edge" role="slider" aria-label="Scene edge"></div></div>
      <script>
      window.events=[];window.finished=false;window.committedWidth=null;
      let latestWidth=120,renderedWidth=120,scheduled=false;
      edge.addEventListener('pointerdown',event=>{
        events.push({type:event.type,x:event.clientX,buttons:event.buttons});
        edge.setPointerCapture(event.pointerId);
      });
      edge.addEventListener('pointermove',event=>{
        if(event.buttons!==1)return;
        events.push({type:event.type,x:event.clientX,buttons:event.buttons});
        latestWidth=event.clientX-40;
        if(!scheduled){
          scheduled=true;
          requestAnimationFrame(()=>{
            renderedWidth=latestWidth;
            clip.style.width=renderedWidth+'px';
            scheduled=false;
          });
        }
      });
      edge.addEventListener('pointerup',event=>{
        events.push({type:event.type,x:event.clientX,buttons:event.buttons});
        window.committedWidth=renderedWidth;
        window.finished=true;
      });
      </script>`}) : route.abort());
  const page = await context.newPage();
  let driver, acknowledge, reportPress, ackTimer;
  let pending;
  const delayedAck = new Promise(resolve => { acknowledge = resolve; });
  const pressed = new Promise(resolve => { reportPress = resolve; });
  try {
    await page.goto(url);
    const cdp = await context.newCDPSession(page);
    const tab = async () => ({id: 1, url: page.url(), title: "Drag ACK fixture"});
    let holdAcks = false;
    driver = createDriver({
      storage: chromeStorage(),
      debugger: {attach: async () => {}, detach: async () => {}, sendCommand: async (_target, method, params) => {
        if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") holdAcks = true;
        const held = method === "Input.dispatchMouseEvent" && holdAcks;
        const result = await cdp.send(method, params);
        if (held) {
          if (params.type === "mousePressed") {
            reportPress();
            ackTimer = setTimeout(acknowledge, 5200);
          }
          // Real input has been delivered. Hold the ACKs for 5.2 seconds while
          // the test checks final page size and pointerup, not the call sequence.
          await delayedAck;
        }
        return result;
      }},
      tabs: {get: tab}, action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
      runtime: {connectNative: () => ({postMessage() {}, disconnect() {}, onMessage: {addListener() {}}, onDisconnect: {addListener() {}}})},
    });
    await driver.attach(await tab());
    const sessionId = driver.status().sessionId;
    const observed = await driver.handleRequest({v: 2, type: "request", id: "observe", sessionId, method: "observe", params: {}});
    assert.equal(observed.ok, true);
    let settled = false;
    pending = driver.handleRequest({v: 2, type: "request", id: "drag", sessionId, method: "drag", params: {
      snapshotId: observed.result.snapshotId, from: {x: 155, y: 110}, to: {x: 355, y: 110}, steps: 15,
    }}).then(result => { settled = true; return result; });
    await pressed;
    await page.waitForFunction(() => window.finished, null, {timeout: 1200});
    assert.equal(settled, false, "the action must still wait for all acknowledgements");
    const state = await page.evaluate(() => ({width: clip.getBoundingClientRect().width, committedWidth, events}));
    assert.equal(state.width, 315);
    assert.equal(state.committedWidth, 315, "pointerup must commit the final rendered size, not a pending RAF update");
    assert.deepEqual(state.events[0], {type: "pointerdown", x: 155, buttons: 1});
    assert.deepEqual(state.events.at(-1), {type: "pointerup", x: 355, buttons: 0});
    const moves = state.events.filter(event => event.type === "pointermove");
    assert.ok(moves.length > 0);
    assert.equal(moves.at(-1).x, 355);
    assert.ok(moves.every(event => event.buttons === 1));
    const result = await pending;
    assert.equal(result.ok, true, JSON.stringify(result.error));
  } finally {
    clearTimeout(ackTimer);
    acknowledge();
    await pending;
    await driver?.detach();
    await browser.close();
  }
});
