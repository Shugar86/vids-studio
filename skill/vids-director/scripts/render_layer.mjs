#!/usr/bin/env node
// Render design layers (HTML) to PNG for upload into Google Vids, where they are placed and animated.
// Isolated headless Chromium from the existing Playwright install: no user profile, no network,
// no system input. Background is transparent unless --opaque, so layers sit over video.
//   --show note,remind   only these .layer elements stay visible; full-frame PNG keeps their position
//   --selector "#note"   crop to one element instead
//   --guides             overlay safe zones and the caption band (for checking, never for upload)
import {chromium} from 'playwright'
import {existsSync} from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'

const {values, positionals} = parseArgs({allowPositionals: true, options: {
  selector: {type: 'string'},
  show: {type: 'string'},
  width: {type: 'string', default: '1080'},
  height: {type: 'string', default: '1920'},
  opaque: {type: 'boolean', default: false},
  guides: {type: 'boolean', default: false},
}})
const [input, output] = positionals
if (!input || !output) {
  console.error('usage: render_layer.mjs layers.html out.png [--show id1,id2] [--selector "#id"] [--opaque] [--guides] [--width 1080 --height 1920]')
  process.exit(2)
}
if (existsSync(output)) {
  console.error(`Refusing to overwrite ${output}; choose a new versioned name`)
  process.exit(1)
}

const browser = await chromium.launch()
try {
  const [w, h] = [Number(values.width), Number(values.height)]
  const page = await browser.newPage({viewport: {width: w, height: h}, deviceScaleFactor: 1})
  // Local files and data: URIs only, so a layer can never leak text or fetch remote content.
  await page.route('**/*', route => /^(file|data):/.test(route.request().url()) ? route.continue() : route.abort())
  await page.goto(pathToFileURL(path.resolve(input)).href)
  await page.evaluate(() => document.fonts.ready)
  if (values.show) {
    const ids = values.show.split(',').map(s => s.trim()).filter(Boolean)
    const bad = ids.filter(id => !/^[A-Za-z][\w-]*$/.test(id))
    if (bad.length) throw new Error(`Layer ids must be plain identifiers: ${bad.join(', ')}`)
    const missing = await page.evaluate(list => list.filter(id => !document.getElementById(id)), ids)
    if (missing.length) throw new Error(`No element with id: ${missing.join(', ')}`)
    const keep = ids.map(id => `:not(#${id})`).join('')
    await page.addStyleTag({content: `.layer${keep} { visibility: hidden !important; }`})
  }
  if (values.guides) {
    // Same zones as qa_export.py's social profile; the dashed band is where Vids captions go.
    await page.addStyleTag({content: `.__g{position:fixed;background:rgba(255,0,0,.28);z-index:2147483647;pointer-events:none}
      .__band{position:fixed;left:5%;width:83%;top:${Math.round(h * .651)}px;height:${Math.round(h * .115)}px;outline:4px dashed #1f6feb;z-index:2147483647}`})
    await page.evaluate(() => {
      for (const s of ['left:0;top:0;width:100%;height:12%', 'left:0;bottom:0;width:100%;height:22%',
        'left:0;top:0;width:5%;height:100%', 'right:0;top:0;width:12%;height:100%']) {
        const d = document.createElement('div'); d.className = '__g'; d.style.cssText = s; document.body.append(d)
      }
      const b = document.createElement('div'); b.className = '__band'; document.body.append(b)
    })
  }
  // data-fit="N": the visible text may take at most N lines and must not overflow sideways.
  const overflow = await page.evaluate(() => [...document.querySelectorAll('[data-fit]')]
    .filter(el => el.offsetParent && getComputedStyle(el).visibility !== 'hidden')
    .flatMap(el => {
      // Count line boxes of the text itself; element boxes of nested spans are not lines.
      const tops = new Set()
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top / 8))
      }
      const lines = tops.size
      const max = Number(el.dataset.fit) || 1
      const wide = el.scrollWidth > el.clientWidth + 1
      return lines > max || wide ? [`${el.id || el.className || el.tagName}: ${lines} стр. при максимуме ${max}${wide ? ', шире блока' : ''}`] : []
    }))
  const target = values.selector ? page.locator(values.selector) : page
  await target.screenshot({path: output, omitBackground: !values.opaque})
  console.log(JSON.stringify({output: path.resolve(output), show: values.show || null, selector: values.selector || null, overflow}))
  if (overflow.length) {
    console.error(`Text does not fit: ${overflow.join('; ')} — shorten the text or enlarge the box`)
    process.exitCode = 3
  }
} finally {
  await browser.close()
}
