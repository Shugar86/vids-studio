import {chromeStorage} from './chrome-storage.mjs';
import assert from 'node:assert/strict'
import {after, before, test} from 'node:test'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {createDriver} from '../extension/driver.js'

// No real Google document, profile, cookies, or service is used by this test.
// The reserved document URL is fulfilled entirely from an in-memory fixture.
const url = 'https://docs.google.com/videos/d/fixture_local_only/edit'
const otherUrl = 'https://docs.google.com/videos/d/other_document/edit'
let browser, page, driver, sessionId, temporary
let sequence = 0

const fixture = `<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Vids Studio isolated driver fixture</title>
<style>body{font:20px sans-serif;padding:24px}textarea{display:block;width:500px;height:120px}#editor{border:1px solid;padding:20px;min-height:60px}button,input{margin:20px}#drag{width:120px;height:60px;background:#7bc}body{min-height:1800px}</style>
<h1>Проверка русского ввода</h1>
<label for="script">Сценарий</label><textarea id="script"></textarea>
<div id="editor" contenteditable="true" role="textbox" aria-label="Текст сцены"></div>
<button id="apply" onclick="this.textContent='Применено'">Применить</button>
<label>Медиа<input id="media" type="file" accept="image/png"></label>
<div id="drag" role="slider" aria-label="Край клипа" tabindex="0"></div>
<output id="dragResult"></output>
<script>document.getElementById('drag').addEventListener('pointerdown',()=>{
 document.addEventListener('pointerup',e=>document.getElementById('dragResult').textContent='drop:'+e.clientX,{once:true})
})</script></html>`

before(async () => {
  // Chromium worker has createImageBitmap; Node's test runner does not.
  globalThis.createImageBitmap = async blob => {
    const bytes = Buffer.from(await blob.arrayBuffer())
    assert.equal(bytes.toString('ascii', 1, 4), 'PNG')
    return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), close() {}}
  }
  browser = await chromium.launch({headless: true})
  const context = await browser.newContext({viewport: {width: 1000, height: 800}, deviceScaleFactor: 1})
  await context.route('**/*', route => [url, otherUrl].includes(route.request().url())
    ? route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: fixture})
    : route.abort())
  page = await context.newPage()
  await page.goto(url)
  const cdp = await context.newCDPSession(page)
  const tab = async () => ({id: 1, url: page.url(), title: await page.title()})
  const api = {
    storage: chromeStorage(),
    debugger: {
      attach: async () => {}, detach: async () => {},
      sendCommand: async (_target, method, params = {}) => cdp.send(method, params),
    },
    tabs: {get: tab, update: tab},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    runtime: {connectNative: () => ({
      postMessage() {}, disconnect() {},
      onMessage: {addListener() {}}, onDisconnect: {addListener() {}},
    })},
  }
  driver = createDriver(api)
  cdp.on('Page.screencastFrame', params => driver.onDebuggerEvent({tabId: 1}, 'Page.screencastFrame', params))
  await driver.attach(await tab())
  sessionId = (await driver.status()).sessionId
  temporary = await mkdtemp(join(tmpdir(), 'vids-driver-fixture-'))
})

after(async () => {
  if (driver) await driver.detach('test_complete')
  if (browser) await browser.close()
  if (temporary) await rm(temporary, {recursive: true, force: true})
})

async function command(method, params = {}) {
  const response = await driver.handleRequest({v: 2, type: 'request', id: `fixture-${++sequence}`, sessionId, method, params})
  // Same request/response envelope as the real Native Messaging transport.
  if (response && response.ok === false) {
    const error = new Error(response.error.message)
    error.code = response.error.code
    throw error
  }
  assert.equal(response.ok, true)
  return response.result
}

async function findNode(name) {
  const snapshot = await command('observe')
  const node = snapshot.nodes.find(node => node.name === name &&
    ['textbox', 'button', 'file-input', 'slider'].includes(node.role))
  assert.ok(node, `Accessible node missing: ${name}`)
  return {snapshot, node}
}

test('Cyrillic, punctuation and newlines survive real CDP input and replacement', async () => {
  let {snapshot, node} = await findNode('Сценарий')
  const text = 'Привет, мир! Ёжик — это не еж.\nВторая строка: 25 октября, 8 секунд.'
  await command('type_text', {snapshotId: snapshot.snapshotId, nodeRef: node.ref, text})
  assert.equal(await page.locator('#script').inputValue(), text)
  await assert.rejects(command('type_text', {snapshotId: snapshot.snapshotId, nodeRef: node.ref, text: 'duplicate'}), error => error.code === 'STALE_SNAPSHOT')
  ;({snapshot, node} = await findNode('Сценарий'))
  await command('type_text', {snapshotId: snapshot.snapshotId, nodeRef: node.ref, text: 'Новый сценарий', replace: true})
  assert.equal(await page.locator('#script').inputValue(), 'Новый сценарий')
})

test('contenteditable text and actual button click work by observed references', async () => {
  let {snapshot, node} = await findNode('Текст сцены')
  await command('type_text', {snapshotId: snapshot.snapshotId, nodeRef: node.ref, text: 'Смысл в одном кадре'})
  assert.equal(await page.locator('#editor').innerText(), 'Смысл в одном кадре')
  ;({snapshot, node} = await findNode('Применить'))
  await command('click', {snapshotId: snapshot.snapshotId, nodeRef: node.ref})
  assert.equal(await page.locator('#apply').innerText(), 'Применено')
})

test('screenshot coordinates, pointer drag and local file input use real Chromium', async () => {
  const screenshot = await command('screenshot', {format: 'png'})
  assert.equal(screenshot.mimeType, 'image/png')
  assert.equal(screenshot.coordinateSpace, 'css-viewport')
  const png = Buffer.from(screenshot.data, 'base64')
  assert.equal(png.readUInt32BE(16), screenshot.viewport.width)
  assert.equal(png.readUInt32BE(20), screenshot.viewport.height)
  const box = await page.locator('#drag').boundingBox()
  await command('drag', {snapshotId: screenshot.snapshotId, from: {x: box.x + 20, y: box.y + 20}, to: {x: box.x + 200, y: box.y + 20}})
  assert.match(await page.locator('#dragResult').innerText(), /^drop:/)
  const {snapshot, node} = await findNode('Медиа')
  const pngPath = join(temporary, 'русское-изображение.png')
  await writeFile(pngPath, png)
  await command('upload', {snapshotId: snapshot.snapshotId, nodeRef: node.ref, files: [pngPath]})
  assert.equal(await page.locator('#media').evaluate(el => el.files[0].name), 'русское-изображение.png')
})

test('navigation to another document ends authority before any input', async () => {
  const screenshot = await command('screenshot')
  await page.goto(otherUrl)
  await assert.rejects(command('click', {snapshotId: screenshot.snapshotId, x: 20, y: 20}))
  assert.equal((await driver.status()).attached, false)
})
