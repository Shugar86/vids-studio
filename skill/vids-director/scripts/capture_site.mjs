#!/usr/bin/env node
// Capture a real page the user allowed to show: a phone-sized screenshot, a tall page
// screenshot, and optionally a smooth scroll clip, as source material for Google Vids.
// Isolated headless Chromium (existing Playwright): no user profile, cookies or system input.
// Cookie banners are never accepted; --hide only hides elements in the capture.
import {chromium} from 'playwright'
import {existsSync, mkdirSync, readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import path from 'node:path'
import {parseArgs} from 'node:util'

const {values, positionals} = parseArgs({allowPositionals: true, options: {
  out: {type: 'string'},
  width: {type: 'string', default: '360'},     // CSS px; 360×640 at scale 3 = a full 1080×1920 frame
  height: {type: 'string', default: '640'},
  scale: {type: 'string', default: '3'},
  'max-height': {type: 'string', default: '3200'},
  start: {type: 'string', default: '0'},        // CSS px from the top where the tall capture begins
  scroll: {type: 'string'},                    // seconds of scroll clip
  hide: {type: 'string'},                      // comma-separated CSS selectors
  locale: {type: 'string', default: 'en-US'},
  wait: {type: 'string', default: '1500'},
}})
const [url] = positionals
if (!url || !values.out || !/^(https?|file):/.test(url)) {
  console.error('usage: capture_site.mjs https://example.com --out work/assets/site-v1 [--scroll 6] [--start 0] [--hide ".cookie"] [--width 360 --height 640 --scale 3]')
  process.exit(2)
}
const out = path.resolve(values.out)
if (existsSync(out) && readdirSync(out).length) {
  console.error(`Refusing to write into non-empty ${out}`)
  process.exit(1)
}
mkdirSync(out, {recursive: true})
const [w, h, scale] = [Number(values.width), Number(values.height), Number(values.scale)]

const browser = await chromium.launch()
const result = {url, out, files: []}
try {
  const context = await browser.newContext({viewport: {width: w, height: h}, deviceScaleFactor: scale,
    isMobile: true, hasTouch: true, locale: values.locale})
  const page = await context.newPage()
  await page.goto(url, {waitUntil: 'networkidle', timeout: 45000})
  if (values.hide) await page.addStyleTag({content: `${values.hide} { display: none !important; }`})
  // Walk the page once so lazy images load, then return to the top.
  const start = Number(values.start)
  await page.evaluate(async ([from, limit]) => {
    for (let y = 0; y < Math.min(document.body.scrollHeight, from + limit); y += innerHeight / 2) {
      scrollTo(0, y)
      await new Promise(r => setTimeout(r, 120))
    }
    scrollTo(0, from)
  }, [start, Number(values['max-height'])])
  await page.waitForTimeout(Number(values.wait))
  const viewport = path.join(out, 'viewport.png')
  await page.screenshot({path: viewport})
  result.files.push(viewport)
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight)
  // Pages often end in empty space (hidden widgets, min-height wrappers). Stop the tall shot at the
  // last visible text or media, otherwise the scroll clip glides into a blank screen.
  const contentBottom = await page.evaluate(() => {
    let bottom = 0
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || Number(s.opacity) === 0) continue
      const media = /^(img|video|canvas|svg|picture)$/i.test(el.tagName)
      const text = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
      if (media || text) bottom = Math.max(bottom, r.bottom + scrollY)
    }
    return Math.ceil(bottom)
  })
  const tallHeight = Math.min(Math.min(pageHeight, contentBottom + 48) - start, Number(values['max-height']))
  if (tallHeight < h) throw new Error(`--start ${start} leaves less than one screen of page`)
  const tall = path.join(out, 'page.png')
  await page.screenshot({path: tall, fullPage: true, clip: {x: 0, y: start, width: w, height: tallHeight}})
  result.files.push(tall)
  result.page_height_css = pageHeight
  result.content_bottom_css = contentBottom

  if (values.scroll) {
    const seconds = Number(values.scroll)
    const [fw, fh] = [Math.round(w * scale / 2) * 2, Math.round(h * scale / 2) * 2]
    const clip = path.join(out, 'scroll.mp4')
    // Hold 0.5 s at both ends, ease in and out between them; a stand-in for a screen recording.
    const p = `clip((t-0.5)/${Math.max(seconds - 1, 0.1)},0,1)`
    const vf = `crop=${fw}:${fh}:0:'(in_h-${fh})*(1-cos(PI*${p}))/2',format=yuv420p`
    const run = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '2', '-loop', '1', '-framerate', '30',
      '-i', tall, '-vf', vf, '-t', String(seconds), '-r', '30', '-c:v', 'libx264', '-crf', '18', clip], {encoding: 'utf8'})
    if (run.status !== 0) throw new Error(`ffmpeg scroll clip failed: ${run.stderr.slice(0, 400)}`)
    result.files.push(clip)
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
