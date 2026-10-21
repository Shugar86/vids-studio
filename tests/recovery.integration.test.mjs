import {chromeStorage} from './chrome-storage.mjs';
import assert from 'node:assert/strict'
import test from 'node:test'
import {chromium} from 'playwright'
import {createDriver} from '../extension/driver.js'

test('real screenshot ACK quarantine blocks input, then fresh observation restores editing', async context => {
  // Disposable headless browser, local HTML, no Google network or user profile.
  const browser = await chromium.launch({headless: true})
  let driver
  try {
    const isolated = await browser.newContext({viewport: {width: 800, height: 600}})
    const url = 'https://docs.google.com/videos/d/recovery_fixture/edit'
    await isolated.route('**/*', route => route.request().url() === url
      ? route.fulfill({contentType: 'text/html', body: '<button onclick="this.textContent=\'Done\'">Apply</button>'})
      : route.abort())
    const page = await isolated.newPage()
    await page.goto(url)
    const cdp = await isolated.newCDPSession(page)
    let release, notify, held = false
    const ack = new Promise(resolve => { release = resolve })
    const sent = new Promise(resolve => { notify = resolve })
    let inputCount = 0
    const tab = {id: 1, url, title: 'Isolated fixture'}
    driver = createDriver({
      storage: chromeStorage(),
      tabs: {get: async () => tab},
      action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
      runtime: {connectNative: () => ({postMessage() {}, disconnect() {},
        onMessage: {addListener() {}}, onDisconnect: {addListener() {}}})},
      debugger: {attach: async () => {}, detach: async () => {},
        sendCommand: async (_target, method, params) => {
          if (method.startsWith('Input.')) inputCount++
          const result = await cdp.send(method, params)
          if (method === 'Page.captureScreenshot' && !held) {
            held = true
            notify()
            await ack
          }
          return result
        }},
    })
    await driver.attach(tab)
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
    assert.equal((await queued).error.code, 'BROWSER_RECOVERING')
    assert.equal(inputCount, 0)
    release()
    await new Promise(setImmediate)
    context.mock.timers.reset()
    assert.equal(driver.status().attached, true)
    assert.equal(driver.status().recovery, null)
    assert.equal((await request('click', {snapshotId: before.snapshotId, nodeRef: button.ref})).error.code, 'STALE_SNAPSHOT')
    const after = (await request('observe')).result
    const freshButton = after.nodes.find(node => node.name === 'Apply')
    assert.equal((await request('click', {snapshotId: after.snapshotId, nodeRef: freshButton.ref})).ok, true)
    assert.equal(await page.getByRole('button').innerText(), 'Done')
  } finally {
    context.mock.timers.reset()
    await driver?.detach()
    await browser.close()
  }
})
