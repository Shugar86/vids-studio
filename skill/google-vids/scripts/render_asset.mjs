#!/usr/bin/env node
// Static asset preparation only. Never connects to a running/user browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';

const HELP = `Render self-contained local HTML/CSS and data images to a new PNG.
Usage: node render_asset.mjs input.html --output NEW.png --width 1080 --height 1920 [--scale 1] [--transparent]

Requires already installed Playwright and its Chromium; installs/downloads nothing.
Page JavaScript, external resources and browser profiles are not used.
--transparent omits the browser's default white background (default: false).
Explicit HTML/CSS backgrounds remain visible; use transparent CSS for cutout elements.
Dimensions: integer CSS pixels 1..4096; scale >0 and <=2; at most 16 million output pixels.
Input: UTF-8 HTML, at most 10 MiB. Output parent must exist. Symlinks and existing outputs are refused.
Rendering is limited to 20 seconds. JSON reports dimensions and blocked resources;
a blocked resource is not present in the PNG. Keep the HTML as the editable source.
`;
const MAX_INPUT = 10 * 1024 * 1024;
const TIMEOUT = 20000;

async function noSymlinks(filename) {
  let current = path.parse(filename).root;
  for (const part of filename.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink paths are not accepted: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function freshOutput(output, input) {
  await noSymlinks(output);
  if (output === input) throw new Error('Output would overwrite the input. Choose a new PNG path.');
  try {
    await fs.lstat(output);
    throw new Error(`Output already exists. Choose a new PNG path: ${output}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!(await fs.stat(path.dirname(output))).isDirectory()) throw new Error('Output parent must be an existing directory.');
}

async function main() {
  let browser;
  let deadline;
  try {
    const {values, positionals} = parseArgs({allowPositionals: true, options: {
      output: {type: 'string'}, width: {type: 'string'}, height: {type: 'string'},
      scale: {type: 'string', default: '1'}, help: {type: 'boolean', short: 'h'},
      transparent: {type: 'boolean', default: false},
    }});
    if (values.help) { process.stdout.write(HELP); return; }
    if (positionals.length !== 1 || !values.output || !values.width || !values.height) throw new Error('Supply one input.html, --output, --width and --height. Use --help for usage.');
    const width = Number(values.width), height = Number(values.height), scale = Number(values.scale);
    if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 4096)) throw new Error('Width and height must be integers from 1 to 4096.');
    if (!Number.isFinite(scale) || scale <= 0 || scale > 2) throw new Error('Scale must be finite, positive and at most 2.');
    const pixelWidth = Math.round(width * scale), pixelHeight = Math.round(height * scale);
    if (pixelWidth < 1 || pixelHeight < 1 || pixelWidth * pixelHeight > 16000000) throw new Error('Scaled image must contain 1..16000000 pixels.');
    const input = path.resolve(positionals[0]), output = path.resolve(values.output);
    if (!/\.html?$/i.test(input) || !/\.png$/i.test(output)) throw new Error('Input must be .html/.htm and output must be .png.');
    await noSymlinks(input);
    const stat = await fs.stat(input);
    if (!stat.isFile() || stat.size > MAX_INPUT) throw new Error('Input must be a regular HTML file of at most 10 MiB.');
    await freshOutput(output, input);
    const source = await fs.readFile(input);
    if (source.length > MAX_INPUT) throw new Error('Input exceeds 10 MiB.');
    const html = new TextDecoder('utf-8', {fatal: true}).decode(source);
    let chromium;
    try { ({chromium} = await import('playwright')); }
    catch { throw new Error('Playwright is not available. Use the existing vids-studio Node environment; this script does not install dependencies.'); }
    try { await fs.access(chromium.executablePath()); }
    catch { throw new Error('Playwright Chromium is not installed in the current cache. Use an existing browser installation/cache; nothing will be downloaded.'); }

    const render = async () => {
      browser = await chromium.launch({headless: true, timeout: 10000});
      const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: scale,
        javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce'});
      await context.setOffline(true);
      let blockedResourceCount = 0;
      await context.route('**/*', route => { blockedResourceCount++; return route.abort('blockedbyclient'); });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const cdp = await context.newCDPSession(page);
      cdp.on('Audits.issueAdded', ({issue}) => {
        const details = issue.details.contentSecurityPolicyIssueDetails;
        if (details?.contentSecurityPolicyViolationType === 'kURLViolation') blockedResourceCount++;
      });
      await cdp.send('Audits.enable');
      // Put a restrictive policy first, before any source markup. Later policies
      // cannot relax it. Routes also abort navigation and speculative requests.
      const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'";
      let navigated = false;
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigated = true; });
      await page.setContent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">${html.replace(/^\s*<!doctype[^>]*>/i, '')}`, {waitUntil: 'load', timeout: 8000});
      const failedImageCount = await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
        return [...document.images].filter(image => !image.naturalWidth).length;
      });
      const png = await page.screenshot({type: 'png', omitBackground: values.transparent, fullPage: false, animations: 'disabled', caret: 'hide', timeout: 8000});
      if (navigated) throw new Error('HTML attempted to navigate away. Remove navigation and use self-contained static HTML.');
      const actualWidth = png.readUInt32BE(16), actualHeight = png.readUInt32BE(20);
      // Chromium rounds fractional device pixels; report the actual PNG size.
      if (Math.abs(actualWidth - width * scale) > 1 || Math.abs(actualHeight - height * scale) > 1) throw new Error('Unexpected screenshot dimensions; no output was written.');
      return {png, blockedResourceCount, failedImageCount, actualWidth, actualHeight};
    };
    const result = await Promise.race([render(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Rendering exceeded 20 seconds; simplify the HTML.')), TIMEOUT);
    })]);
    clearTimeout(deadline);
    await browser.close();
    browser = null;
    await freshOutput(output, input);
    // Exclusive creation prevents a concurrent existing output/hardlink/symlink
    // from being overwritten even after the preflight check.
    await fs.writeFile(output, result.png, {flag: 'wx', mode: 0o600});
    process.stdout.write(JSON.stringify({input, output, width, height, scale, transparent: values.transparent,
      pixelWidth: result.actualWidth, pixelHeight: result.actualHeight,
      blockedResourceCount: result.blockedResourceCount, failedImageCount: result.failedImageCount,
      pageJavaScript: false, externalResourcesAllowed: false}) + '\n');
    if (result.blockedResourceCount || result.failedImageCount) process.stderr.write('Warning: blocked or failed resources are absent from the PNG. Use inline CSS and data images only.\n');
  } catch (error) {
    process.stderr.write(`Error: ${error.message.split('\n')[0]}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => {});
  }
}

await main();
