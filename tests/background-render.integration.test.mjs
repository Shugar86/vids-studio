import assert from 'node:assert/strict'
import test from 'node:test'
import {spawn} from 'node:child_process'
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {chromium} from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureUrl = 'https://docs.google.com/videos/d/background_render_fixture/edit'
const coverUrl = 'https://example.invalid/active-fixture'

test('ordinary extension renders and edits a background tab without activating it, and detaching restores visibility', {timeout: 45000}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vids-background-render-'))
  const extension = join(temporary, 'extension')
  const profile = join(temporary, 'profile')
  let browser, child, exit
  try {
    await cp(join(root, 'extension'), extension, {recursive: true})
    // The popup's user gesture normally grants activeTab URL access. Give only
    // this disposable fixture equivalent URL visibility without clicking UI.
    // This does not make chrome.debugger a trusted browser CDP client.
    const manifestPath = join(extension, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.permissions.push('tabs')
    await writeFile(manifestPath, JSON.stringify(manifest))
    // Use the production driver and real ordinary chrome.debugger API. Replace
    // only the native port so this fixture cannot connect to an installed host.
    await writeFile(join(extension, 'background.js'), `
      import {createDriver} from './driver.js';
      globalThis.fixtureMessages = [];
      globalThis.fixtureDriver = createDriver({
        debugger: chrome.debugger, tabs: chrome.tabs, storage: chrome.storage,
        action: chrome.action, downloads: chrome.downloads,
        runtime: {connectNative() { return {
          postMessage(message) { fixtureMessages.push(message); }, disconnect() {},
          onMessage: {addListener() {}}, onDisconnect: {addListener() {}}
        }; }}
      });
      chrome.debugger.onEvent.addListener(fixtureDriver.onDebuggerEvent);
      chrome.debugger.onDetach.addListener(fixtureDriver.onDebuggerDetach);
      chrome.tabs.onUpdated.addListener(fixtureDriver.onTabUpdated);
      chrome.tabs.onRemoved.addListener(fixtureDriver.onTabRemoved);
    `)
    // Playwright's normal launch disables background throttling; its normal
    // page setup also enables focus emulation. Neither is allowed to make this
    // regression pass. Launch plain Chromium and explicitly skip CDP defaults.
    child = spawn(chromium.executablePath(), [
      '--no-sandbox', '--headless=new', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      '--force-device-scale-factor=1.5', '--window-size=1200,900',
      '--disable-background-networking', `--user-data-dir=${profile}`,
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      'about:blank',
    ], {stdio: ['ignore', 'ignore', 'pipe']})
    exit = new Promise(resolve => child.once('exit', resolve))
    let stderr = ''
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
    let port
    for (let attempt = 0; attempt < 100; attempt++) {
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch {}
      if (port) break
      if (child.exitCode !== null) throw new Error(`Fixture Chromium exited: ${stderr}`)
      await delay(50)
    }
    assert.match(port ?? '', /^\d+$/, `Fixture Chromium did not start: ${stderr}`)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {noDefaults: true})
    const context = browser.contexts()[0]
    // Every page request is fulfilled locally or aborted, including the fake
    // Google URL needed to exercise the production document-binding guard.
    await context.route('**/*', route => {
      if (route.request().url() === coverUrl) return route.fulfill({contentType: 'text/html', body: '<title>Active fixture</title>'})
      if (route.request().url() !== fixtureUrl) return route.abort()
      return route.fulfill({contentType: 'text/html', body: `<!doctype html>
        <title>Background rendering fixture</title>
        <style>body{margin:0;height:3000px;background:linear-gradient(#ddd,#888)}
          button,canvas{position:fixed;top:20px;left:20px}canvas{top:80px}</style>
        <button onclick="window.clicks++;requestAnimationFrame(()=>window.paintedClicks=window.clicks)">Paint canvas</button>
        <canvas width="160" height="80"></canvas>
        <script>
          window.frames=0;window.clicks=0;window.paintedClicks=0;window.wheels=0;
          window.addEventListener('wheel',()=>window.wheels++,{passive:true});
          const ctx=document.querySelector('canvas').getContext('2d');
          function paint(){if(window.stopPainting)return;window.frames++;ctx.fillStyle=window.paintedClicks?'#00ff00':'#ff0000';ctx.fillRect(0,0,160,80);requestAnimationFrame(paint)}
          requestAnimationFrame(paint);
        </script>`})
    })
    const isFixtureWorker = worker => worker.url().endsWith('/background.js')
    const worker = context.serviceWorkers().find(isFixtureWorker)
      ?? await context.waitForEvent('serviceworker', {predicate: isFixtureWorker, timeout: 10000})
    const page = await context.newPage()
    await page.goto(fixtureUrl)
    const cover = await context.newPage()
    await cover.goto(coverUrl)
    assert.deepEqual(await page.evaluate(() => ({visibility: document.visibilityState, focused: document.hasFocus()})),
      {visibility: 'hidden', focused: false}, 'the target must really be backgrounded before attachment')
    const activeTabs = () => worker.evaluate(async () => (await chrome.tabs.query({active: true})).map(tab => tab.id))
    const activeBefore = await activeTabs()
    const attach = () => worker.evaluate(async url => {
      const tab = (await chrome.debugger.getTargets()).find(target => target.url === url)
      if (!tab?.tabId) throw new Error('Missing isolated fixture tab')
      return fixtureDriver.attach({id: tab.tabId, url, title: 'Background rendering fixture'})
    }, fixtureUrl)
    await attach()
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible')
    await worker.evaluate(() => fixtureDriver.detach())
    await page.waitForFunction(() => document.visibilityState === 'hidden' && !document.hasFocus(), null, {polling: 50, timeout: 3000})
    assert.deepEqual(await activeTabs(), activeBefore)
    const status = await attach()
    assert.equal(status.attached, true)
    assert.deepEqual(await activeTabs(), activeBefore)
    const initialFrames = await page.evaluate(() => window.frames)
    await page.waitForFunction(frames => window.frames > frames + 2, initialFrames, {timeout: 3000})
    let id = 0
    const request = (method, params = {}) => worker.evaluate(envelope => fixtureDriver.handleRequest(envelope),
      {v: 2, type: 'request', id: `background-${++id}`, sessionId: status.sessionId, method, params})
    assert.ok(await page.evaluate(() => window.devicePixelRatio > 1), 'exercise screenshot CSS/image scaling')
    const pixelOf = shot => worker.evaluate(async ({data, image, mimeType}) => {
      const bytes = Uint8Array.from(atob(data), value => value.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], {type: mimeType}))
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      return [...context.getImageData(Math.round(100 * image.scaleX), Math.round(120 * image.scaleY), 1, 1).data]
    }, shot)
    for (let iteration = 0; iteration < 2; iteration++) {
      const format = iteration === 0 ? 'png' : 'jpeg'
      const shot = await request('screenshot', {format, ...(format === 'jpeg' ? {quality: 45} : {})})
      assert.equal(shot.ok, true, JSON.stringify(shot.error))
      assert.equal(shot.result.mimeType, `image/${format}`)
      assert.ok(shot.result.image.width > 0 && shot.result.image.height > 0)
      assert.ok(shot.result.data.length > 100)
      const pixel = await pixelOf(shot.result)
      assert.ok(iteration === 0 ? pixel[0] > 200 && pixel[1] < 50 : pixel[0] < 50 && pixel[1] > 200,
        `the screenshot must contain the current canvas frame, got ${pixel}`)
      const observed = await request('observe')
      assert.equal(observed.ok, true, JSON.stringify(observed.error))
      const button = observed.result.nodes.find(node => node.name === 'Paint canvas')
      assert.ok(button)
      const click = await request('click', {snapshotId: observed.result.snapshotId, nodeRef: button.ref})
      assert.equal(click.ok, true, JSON.stringify(click.error))
      await page.waitForFunction(expected => window.paintedClicks === expected, iteration + 1, {timeout: 3000})
      const fresh = await request('observe')
      const scroll = await request('scroll', {snapshotId: fresh.result.snapshotId, x: 400, y: 300, deltaY: 200})
      assert.equal(scroll.ok, true, JSON.stringify(scroll.error))
      await page.waitForFunction(expected => window.wheels === expected && window.scrollY > expected * 150,
        iteration + 1, {timeout: 3000})
      assert.deepEqual(await activeTabs(), activeBefore, 'driver must never activate its tab')
      const current = await request('status')
      assert.equal(current.result.sessionId, status.sessionId)
      assert.equal(current.result.recovery, null)
    }
    assert.deepEqual(await page.evaluate(() => [...document.querySelector('canvas').getContext('2d').getImageData(0, 0, 1, 1).data]),
      [0, 255, 0, 255], 'the hidden canvas must paint the requested edit')
    await page.evaluate(() => { window.stopPainting = true })
    await delay(100)
    for (let iteration = 0; iteration < 2; iteration++) {
      if (iteration === 1) await page.evaluate(async () => {
        const context = document.querySelector('canvas').getContext('2d')
        context.fillStyle = '#0000ff'
        context.fillRect(0, 0, 160, 80)
        // Establish a presented static fixture, without restarting its render
        // loop. Capturing before a paint commits can correctly show the old UI.
        // This is fixture setup, not a claim that a screenshot settles mutations.
        await new Promise(requestAnimationFrame)
        await new Promise(requestAnimationFrame)
      })
      const format = iteration === 0 ? 'jpeg' : 'png'
      const shot = await request('screenshot', {format, ...(format === 'jpeg' ? {quality: 45} : {})})
      assert.equal(shot.ok, true, `static frame ${iteration}: ${JSON.stringify(shot.error)}`)
      assert.equal(shot.result.mimeType, `image/${format}`)
      const pixel = await pixelOf(shot.result)
      assert.ok(iteration === 0 ? pixel[1] > 200 && pixel[2] < 50 : pixel[1] < 50 && pixel[2] > 200,
        `the static screenshot must contain the newly painted frame, got ${pixel}`)
    }
    await worker.evaluate(() => fixtureDriver.detach())
    // Real pointer input may leave DOM focus in the background page. The
    // visibility override, which keeps rendering alive, must still be gone.
    await page.waitForFunction(() => document.visibilityState === 'hidden', null, {polling: 50, timeout: 3000})
    assert.deepEqual(await activeTabs(), activeBefore)
    assert.equal(await worker.evaluate(() => fixtureDriver.status().attached), false)
  } finally {
    await browser?.close()
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([exit, delay(3000, undefined, {ref: false})])
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit }
    }
    await rm(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
  }
})
