import {chromeStorage} from './chrome-storage.mjs';
import assert from 'node:assert/strict'
import test from 'node:test'
import {chromium} from 'playwright'
import {createDriver} from '../extension/driver.js'

test('a screenshot start ACK held beyond the old deadline preserves the session and fresh editing', async context => {
  // Disposable headless browser, local HTML, no Google network or user profile.
  const browser = await chromium.launch({headless: true})
  let driver
  try {
    const isolated = await browser.newContext({viewport: {width: 800, height: 600}})
    const url = 'https://docs.google.com/videos/d/recovery_fixture/edit'
    await isolated.route('**/*', route => route.request().url() === url
      ? route.fulfill({contentType: 'text/html', body: '<button onclick="this.textContent=this.textContent===\'Apply\'?\'Done\':\'Done again\'">Apply</button>'})
      : route.abort())
    const page = await isolated.newPage()
    await page.goto(url)
    const cdp = await isolated.newCDPSession(page)
    let release, notify, held = false
    const ack = new Promise(resolve => { release = resolve })
    const sent = new Promise(resolve => { notify = resolve })
    let inputCount = 0, captureCount = 0, detachCount = 0
    const methods = []
    const tab = {id: 1, url, title: 'Isolated fixture'}
    driver = createDriver({
      storage: chromeStorage(),
      tabs: {get: async () => tab},
      action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
      runtime: {connectNative: () => ({postMessage() {}, disconnect() {},
        onMessage: {addListener() {}}, onDisconnect: {addListener() {}}})},
      debugger: {attach: async () => {}, detach: async () => { detachCount++ },
        sendCommand: async (_target, method, params) => {
          methods.push(method)
          if (method.startsWith('Input.')) inputCount++
          if (method === 'Page.startScreencast') captureCount++
          const result = await cdp.send(method, params)
          if (method === 'Page.startScreencast' && !held) {
            held = true
            notify()
            await ack
          }
          return result
        }},
    })
    cdp.on('Page.screencastFrame', params => driver.onDebuggerEvent({tabId: tab.id}, 'Page.screencastFrame', params))
    await driver.attach(tab)
    const sessionId = driver.status().sessionId
    let id = 0
    const request = (method, params = {}) => driver.handleRequest({v: 2, type: 'request',
      id: String(++id), sessionId: driver.status().sessionId, method, params})
    const before = (await request('observe')).result
    const button = before.nodes.find(node => node.name === 'Apply')
    assert.ok(button)
    context.mock.timers.enable({apis: ['setTimeout']})
    const capture = request('screenshot')
    await sent
    const queued = request('click', {snapshotId: before.snapshotId, nodeRef: button.ref})
    context.mock.timers.tick(10000)
    assert.equal((await capture).error.code, 'BROWSER_TIMEOUT')
    const queuedResponse = await queued
    assert.equal(inputCount, 0)
    // The old implementation revoked the attachment after 20 seconds.
    // Keep the original reply withheld well beyond that boundary.
    context.mock.timers.tick(20001)
    await new Promise(setImmediate)
    context.mock.timers.reset()
    assert.equal(driver.status().attached, true)
    assert.equal(driver.status().sessionId, sessionId)
    assert.equal(detachCount, 0)
    assert.equal(queuedResponse.error.code, 'STALE_SNAPSHOT')
    assert.equal(driver.status().recovery.state, 'screenshot_read_pending')
    assert.deepEqual(driver.status().recovery.blocks, ['screenshot'])
    const countBeforeRetries = methods.length
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await request('screenshot')).error.code, 'BROWSER_RECOVERING')
    }
    assert.equal(methods.length, countBeforeRetries, 'retries must not enqueue more CDP reads')
    assert.equal(captureCount, 1)
    assert.equal((await request('click', {snapshotId: before.snapshotId, nodeRef: button.ref})).error.code, 'STALE_SNAPSHOT')
    const after = (await request('observe')).result
    const freshButton = after.nodes.find(node => node.name === 'Apply')
    assert.ok(freshButton)
    assert.equal(driver.status().recovery.requiresFreshObservation, false)
    assert.equal((await request('click', {snapshotId: after.snapshotId, nodeRef: freshButton.ref})).ok, true)
    assert.equal(await page.getByRole('button').innerText(), 'Done')
    assert.equal(driver.status().recovery.state, 'screenshot_read_pending')
    const edited = (await request('observe')).result
    const editedButton = edited.nodes.find(node => node.name === 'Done')
    assert.ok(editedButton)
    // A late screenshot response must not invalidate the newer AX snapshot.
    release()
    for (let attempt = 0; attempt < 100 && driver.status().recovery; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(driver.status().recovery, null)
    assert.equal(driver.status().sessionId, sessionId)
    assert.equal((await request('click', {snapshotId: edited.snapshotId, nodeRef: editedButton.ref})).ok, true)
    assert.equal(await page.getByRole('button').innerText(), 'Done again')
    assert.equal(detachCount, 0)
    assert.equal(captureCount, 1)
  } finally {
    context.mock.timers.reset()
    await driver?.detach()
    await browser.close()
  }
})

test('a wheel held before dispatch times out attached, blocks input and scrolls only once after settlement', async context => {
  // Model Chrome's pre-dispatch visual-state wait, using only a disposable
  // browser and local fixture. No event reaches the real page until released.
  const browser = await chromium.launch({headless: true})
  let driver, release, heldCommand, pendingScroll
  try {
    const isolated = await browser.newContext({viewport: {width: 800, height: 600}})
    const url = 'https://docs.google.com/videos/d/wheel_recovery_fixture/edit'
    await isolated.route('**/*', route => route.request().url() === url
      ? route.fulfill({contentType: 'text/html', body: `<!doctype html>
        <style>body{margin:0;min-height:3000px}button{position:fixed;top:20px;left:20px}</style>
        <button onclick="this.textContent='Changed'">Apply</button>
        <output id="wheel-count">0</output>
        <script>
          window.addEventListener('wheel', event => {
            if (event.deltaX || event.deltaY) {
              const count = document.getElementById('wheel-count');
              count.textContent = String(Number(count.textContent) + 1);
            }
          }, {passive: true});
        </script>`})
      : route.abort())
    const page = await isolated.newPage()
    await page.goto(url)
    const cdp = await isolated.newCDPSession(page)
    let notify
    const gate = new Promise(resolve => { release = resolve })
    const sent = new Promise(resolve => { notify = resolve })
    let inputAttempts = 0, dispatchedWheels = 0, detachCount = 0
    const nativeMessages = []
    const tab = {id: 1, url, title: 'Isolated wheel recovery fixture'}
    driver = createDriver({
      storage: chromeStorage(),
      tabs: {get: async () => tab},
      action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
      runtime: {connectNative: () => ({
        postMessage(message) { nativeMessages.push(message) }, disconnect() {},
        onMessage: {addListener() {}}, onDisconnect: {addListener() {}},
      })},
      debugger: {attach: async () => {}, detach: async () => { detachCount++ },
        sendCommand: async (_target, method, params) => {
          if (method.startsWith('Input.')) inputAttempts++
          if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') {
            heldCommand = gate.then(() => {
              dispatchedWheels++
              return cdp.send(method, params)
            })
            notify()
            return heldCommand
          }
          return cdp.send(method, params)
        }},
    })
    await driver.attach(tab)
    const sessionId = driver.status().sessionId
    let id = 0
    const request = (method, params = {}) => driver.handleRequest({v: 2, type: 'request',
      id: String(++id), sessionId, method, params})
    const before = (await request('observe')).result
    assert.ok(before.nodes.some(node => node.name === 'Apply'))
    const envelope = {v: 2, type: 'request', id: 'held-wheel', sessionId, method: 'scroll',
      params: {snapshotId: before.snapshotId, x: 400, y: 300, deltaY: 300}}
    context.mock.timers.enable({apis: ['setTimeout']})
    pendingScroll = driver.handleRequest(envelope)
    await sent
    context.mock.timers.tick(10000)
    const response = await pendingScroll
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'BROWSER_TIMEOUT')
    assert.equal(response.error.outcome, 'unknown')
    assert.equal(response.settled, false)
    assert.equal(response.sessionId, sessionId)
    context.mock.timers.tick(20001)
    await new Promise(setImmediate)
    context.mock.timers.reset()
    const status = (await request('status')).result
    assert.equal(status.attached, true)
    assert.equal(status.sessionId, sessionId)
    assert.equal(detachCount, 0)
    assert.equal(status.recovery.state, 'input_ack_pending')
    assert.deepEqual(status.recovery.blocks, ['mutations'])
    assert.equal(status.recovery.requiresReconciliation, true)
    assert.equal(await page.evaluate(() => window.scrollY), 0)
    assert.equal(await page.locator('#wheel-count').textContent(), '0')
    assert.equal(dispatchedWheels, 0, 'the timed-out wheel may still be waiting to dispatch')

    const during = (await request('observe')).result
    const button = during.nodes.find(node => node.name === 'Apply')
    assert.ok(button, 'real AX observation remains available while the wheel is pending')
    for (const [method, params] of [
      ['click', {snapshotId: during.snapshotId, nodeRef: button.ref}],
      ['scroll', {snapshotId: during.snapshotId, x: 400, y: 300, deltaY: 300}],
    ]) {
      const blocked = await request(method, params)
      assert.equal(blocked.error.code, 'BROWSER_RECOVERING')
      assert.equal(blocked.error.outcome, undefined, 'blocked input never started')
    }
    assert.equal(inputAttempts, 1)
    assert.equal(nativeMessages.some(message => message.type === 'response' && message.id === envelope.id), false)

    release()
    await heldCommand
    await new Promise(setImmediate)
    await page.waitForFunction(() => window.scrollY > 0)
    assert.equal(await page.locator('#wheel-count').textContent(), '1')
    assert.equal(await page.getByRole('button').innerText(), 'Apply')
    assert.equal(dispatchedWheels, 1)
    assert.equal(driver.status().sessionId, sessionId)
    assert.equal(driver.status().recovery, null)
    assert.equal(detachCount, 0)
    const settlements = nativeMessages.filter(message => message.type === 'response' && message.id === envelope.id)
    assert.equal(settlements.length, 1)
    assert.equal(settlements[0].sessionId, sessionId)
    assert.equal(settlements[0].settled, true)
    assert.equal(settlements[0].ok, false)
    assert.equal(settlements[0].error.code, 'BROWSER_TIMEOUT')
    assert.equal(settlements[0].error.outcome, 'unknown')
    assert.strictEqual(await driver.handleRequest(envelope), response, 'a late ACK does not rewrite or replay the original result')
    assert.equal((await request('click', {snapshotId: during.snapshotId, nodeRef: button.ref})).error.code, 'STALE_SNAPSHOT')
    const after = (await request('observe')).result
    assert.notEqual(after.snapshotId, during.snapshotId)
    assert.ok(after.nodes.some(node => node.name === 'Apply'))
    assert.equal(inputAttempts, 1, 'settlement and fresh observation must not dispatch more input')
    // Reconciliation/ownership gating after settlement belongs to the native
    // coordinator; this driver fixture does not bypass it with a new mutation.
  } finally {
    context.mock.timers.reset()
    release?.()
    await Promise.allSettled([heldCommand, pendingScroll])
    await driver?.detach()
    await browser.close()
  }
})
