import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'

test('Chrome loads the actual MV3 worker and both popup languages in a disposable profile', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const extension = join(root, 'extension')
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'))
  const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
    .map(n => String.fromCharCode(97 + Number.parseInt(n, 16))).join('')
  const profile = await mkdtemp(join(tmpdir(), 'vids-extension-test-'))
  let context
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, locale: 'en-US',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    })
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout: 10000})
    assert.equal(new URL(worker.url()).hostname, extensionId)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`chrome-extension://${extensionId}/popup.html`)
    await page.getByText('No tab connected', {exact: true}).waitFor()
    await page.getByRole('button', {name: 'Connect this tab', exact: true}).click()
    await page.getByRole('alert').filter({hasText: 'Open a Google Vids document'}).waitFor()
    await page.getByRole('button', {name: 'Переключить на русский', exact: true}).click()
    await page.getByText('Вкладка не подключена', {exact: true}).waitFor()
    await page.getByRole('button', {name: 'Подключить эту вкладку', exact: true}).click()
    await page.getByRole('alert').filter({hasText: 'Откройте документ Google Vids'}).waitFor()
    await page.reload()
    await page.getByText('Вкладка не подключена', {exact: true}).waitFor()
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru')
    const installed = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8'))
    assert.equal(await page.locator('h1').textContent(), installed.displayName)
    assert.deepEqual(errors, [])
  } finally {
    await context?.close()
    await rm(profile, {recursive: true, force: true})
  }
})
