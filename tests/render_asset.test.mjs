import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const exec = promisify(execFile);
const profile = JSON.parse(await fs.readFile(new URL('../profile.json', import.meta.url), 'utf8'));
const script = fileURLToPath(new URL(`../skill/${profile.skillName}/scripts/render_asset.mjs`, import.meta.url));
const inline = `<!doctype html><html lang="ru"><meta charset="utf-8"><style>
  body{margin:0;background:#16283b;color:#fff;font:24px "DejaVu Sans",sans-serif;padding:24px}
  img{width:20px;height:20px} p{color:#8ee0c5}</style><h1>Заявка</h1><p>Анна · консультация</p>
  <img alt="" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=">`;

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vids-render-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const input = path.join(dir, 'asset.html'), output = path.join(dir, 'asset.png');
  await fs.writeFile(input, inline);
  return {dir, input, output};
}

async function run(input, output, extra = [], options = {}) {
  try {
    const result = await exec(process.execPath, [script, input, '--output', output, '--width', '400', '--height', '300', ...extra], {timeout: 30000, ...options});
    return {...result, code: 0};
  } catch (error) { return {stdout: error.stdout, stderr: error.stderr, code: error.code}; }
}

test('render help is available without launching Chromium', async () => {
  const {stdout} = await exec(process.execPath, [script, '--help'], {env: {...process.env, PLAYWRIGHT_BROWSERS_PATH: '/nonexistent/vids-render-cache'}});
  assert.match(stdout, /--width 1080 --height 1920/);
  assert.match(stdout, /installs\/downloads nothing/);
  assert.match(stdout, /--transparent/);
});

test('--transparent renders zero-alpha surroundings while preserving the opaque element and default white background', async t => {
  const {dir, input, output} = await fixture(t);
  const html = '<!doctype html><style>html,body{margin:0;background:transparent}.card{position:absolute;left:40px;top:40px;width:200px;height:100px;background:#d1ef62}</style><div class="card">Заявка</div>';
  await fs.writeFile(input, html);
  const opaque = await run(input, output);
  const transparentOutput = path.join(dir, 'transparent.png');
  const transparent = await run(input, transparentOutput, ['--transparent']);
  assert.equal(opaque.code, 0, opaque.stderr);
  assert.equal(transparent.code, 0, transparent.stderr);
  assert.equal(JSON.parse(opaque.stdout).transparent, false);
  assert.equal(JSON.parse(transparent.stdout).transparent, true);
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.setOffline(true);
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  for (const [filename, expectedCorner] of [[output, [255, 255, 255, 255]], [transparentOutput, [0, 0, 0, 0]]]) {
    // Decode the actual PNG, not CLI metadata. No network or source JS runs.
    const pixels = await page.evaluate(async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return {size: [image.width, image.height], corner: [...context.getImageData(0, 0, 1, 1).data],
        inside: [...context.getImageData(100, 100, 1, 1).data]};
    }, (await fs.readFile(filename)).toString('base64'));
    assert.deepEqual(pixels.size, [400, 300]);
    assert.deepEqual(pixels.corner, expectedCorner);
    assert.deepEqual(pixels.inside, [209, 239, 98, 255], 'explicit CSS fill remains opaque');
  }
  assert.equal(await fs.readFile(input, 'utf8'), html);
});

test('static Cyrillic/data-image PNG has exact dimensions; JavaScript and external resources cannot alter it', async t => {
  const {dir, input, output} = await fixture(t);
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.writeHead(500); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const reference = await run(input, output, ['--scale', '1.5']);
  assert.equal(reference.code, 0, reference.stderr);
  const info = JSON.parse(reference.stdout), png = await fs.readFile(output);
  assert.equal(info.pixelWidth, 600); assert.equal(info.pixelHeight, 450);
  assert.equal(png.readUInt32BE(16), 600); assert.equal(png.readUInt32BE(20), 450);
  assert.equal(info.failedImageCount, 0); assert.equal(info.blockedResourceCount, 0);
  const attempted = path.join(dir, 'attempted.html'), attemptedPNG = path.join(dir, 'attempted.png');
  const html = `${inline}<script>document.body.style.background='red';document.querySelector('h1').textContent='WRONG';fetch('${url}/script')</script>
    <style>@import url('${url}/external.css');</style><link rel="stylesheet" href="${url}/linked.css">
    <img style="display:none" src="${url}/external.png"><iframe style="display:none" src="${url}/frame"></iframe>
    <img style="display:none" src="file://${input}">`;
  await fs.writeFile(attempted, html);
  const result = await run(attempted, attemptedPNG, ['--scale', '1.5']);
  assert.equal(result.code, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(requests, 0, 'no request may reach even the local fixture HTTP server');
  assert.equal(actual.pageJavaScript, false); assert.equal(actual.externalResourcesAllowed, false);
  assert.ok(actual.blockedResourceCount >= 4, result.stdout);
  assert.equal(actual.failedImageCount, 2);
  assert.match(result.stderr, /absent from the PNG/);
  assert.deepEqual(await fs.readFile(attemptedPNG), png, 'script and blocked hidden resources must not alter rendered pixels');
  assert.equal(await fs.readFile(attempted, 'utf8'), html, 'editable source is preserved');
});

test('existing output, hardlink and symlink paths are refused without changing source or target', async t => {
  const {dir, input, output} = await fixture(t);
  const original = await fs.readFile(input);
  await fs.link(input, output);
  let result = await run(input, output);
  assert.equal(result.code, 1); assert.match(result.stderr, /already exists/);
  assert.deepEqual(await fs.readFile(input), original);
  await fs.unlink(output);
  await fs.symlink(input, output);
  result = await run(input, output);
  assert.equal(result.code, 1); assert.match(result.stderr, /Symlink/);
  await fs.unlink(output);
  await fs.symlink(path.join(dir, 'missing.png'), output);
  result = await run(input, output);
  assert.equal(result.code, 1); assert.match(result.stderr, /Symlink/);
  const linkedInput = path.join(dir, 'linked.html');
  await fs.symlink(input, linkedInput);
  result = await run(linkedInput, path.join(dir, 'new.png'));
  assert.equal(result.code, 1); assert.match(result.stderr, /Symlink/);
  const linkedDir = path.join(dir, 'parent-link');
  await fs.symlink(dir, linkedDir);
  result = await run(input, path.join(linkedDir, 'new.png'));
  assert.equal(result.code, 1); assert.match(result.stderr, /Symlink/);
  result = await run(input, input);
  assert.equal(result.code, 1);
  assert.deepEqual(await fs.readFile(input), original);
});

test('input, image size and scale limits fail before any output is created', async t => {
  const {input, output} = await fixture(t);
  for (const args of [['--width', '0'], ['--height', '4097'], ['--width', '2.5'], ['--scale', '0'], ['--scale', 'NaN'], ['--scale', '2.1'], ['--width', '4096', '--height', '4096', '--scale', '2']]) {
    const result = await run(input, output, args);
    assert.equal(result.code, 1, JSON.stringify({args, result}));
    assert.match(result.stderr, /^Error:/);
  }
  await fs.writeFile(input, Buffer.alloc(10 * 1024 * 1024 + 1));
  const result = await run(input, output);
  assert.equal(result.code, 1); assert.match(result.stderr, /at most 10 MiB/);
  await assert.rejects(fs.access(output), {code: 'ENOENT'});
});

test('missing Chromium produces an actionable error and no download/output', async t => {
  const {dir, input, output} = await fixture(t);
  const cache = path.join(dir, 'browser-cache-does-not-exist');
  const result = await run(input, output, [], {env: {...process.env, PLAYWRIGHT_BROWSERS_PATH: cache}});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Chromium is not installed/);
  assert.match(result.stderr, /nothing will be downloaded/);
  await assert.rejects(fs.access(cache), {code: 'ENOENT'});
  await assert.rejects(fs.access(output), {code: 'ENOENT'});
});
