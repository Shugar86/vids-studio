#!/usr/bin/env node
// Optional client of this installed skill's MCP; no separate browser control.
// Parameter JSON is accepted only on stdin with '-' so capabilities stay out of argv.
import {pathToFileURL, fileURLToPath} from 'node:url'
import {writeFileSync, readFileSync, realpathSync} from 'node:fs'
import {resolve, dirname, basename} from 'node:path'

const [tool, input, ...rest] = process.argv.slice(2)
if (!/^vids_[a-z_]+$/.test(tool || '') || (input !== undefined && input !== '-') ||
    (rest.length !== 0 && (rest.length !== 2 || rest[0] !== '--image' || !rest[1]))) {
  console.error('usage: vids_call.mjs <vids_tool> [-] [--image out.png]; send parameter JSON through stdin only')
  process.exit(2)
}
const here = dirname(realpathSync(fileURLToPath(import.meta.url)))
const expected = {'google-vids': 'codex', 'vids-director': 'claude'}[basename(dirname(here))]
if (!expected) {
  console.error('Run this helper inside its installed google-vids or vids-director skill. No fallback profile is used.')
  process.exit(2)
}
const bridgeVariable = expected === 'codex' ? 'VIDS_CODEX_BRIDGE' : 'VIDS_CLAUDE_BRIDGE'
const candidate = process.env[bridgeVariable] || resolve(here, '../../..')
let bridge
try {
  bridge = realpathSync(resolve(candidate))
  if (JSON.parse(readFileSync(`${bridge}/profile.json`, 'utf8')).id !== expected) throw Error('wrong profile')
} catch {
  console.error(`Set ${bridgeVariable} to an installed ${expected} build with matching profile.json. No fallback profile is used.`)
  process.exit(2)
}
let args
try {
  args = input === '-' ? JSON.parse(readFileSync(0, 'utf8')) : {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('invalid')
} catch {
  console.error('Provide one JSON object on stdin. Private payloads are not printed.')
  process.exit(2)
}
const sdk = file => import(pathToFileURL(`${bridge}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/${file}`).href)
const {Client} = await sdk('index.js')
const {StdioClientTransport} = await sdk('stdio.js')
const imageAt = rest.indexOf('--image')
const imagePath = imageAt >= 0 ? rest[imageAt + 1] : null
const client = new Client({name: `vids-${expected}-cli`, version: '1'})
// The SDK deliberately inherits only basic OS variables. Preserve the explicit
// Vids transport/state selection without forwarding unrelated app credentials.
const environmentKeys = [
  'VIDS_STUDIO_SOCKET', 'VIDS_STUDIO_FLEET_DIR', 'VIDS_STUDIO_REGISTRY_DIR',
  'VIDS_STUDIO_MEDIA_BUDGET_DIR', 'VIDS_STUDIO_PYTHON',
  'VIDS_STUDIO_FFMPEG', 'VIDS_STUDIO_FFPROBE', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME',
]
const env = Object.fromEntries(environmentKeys.filter(key => process.env[key] !== undefined)
  .map(key => [key, process.env[key]]))
try {
  await client.connect(new StdioClientTransport({command: process.execPath, args: [`${bridge}/server/index.mjs`], env}))
  const result = await client.callTool({name: tool, arguments: args}, undefined, {timeout: 60000})
  for (const part of result.content || []) {
    if (part.type === 'image') {
      if (!imagePath) { console.log('[image omitted: pass --image path]'); continue }
      writeFileSync(imagePath, Buffer.from(part.data, 'base64'), {flag: 'wx', mode: 0o600})
      console.log(JSON.stringify({image: imagePath, mimeType: part.mimeType}))
    } else console.log(part.text)
  }
  if (result.isError) process.exitCode = 1
} catch {
  console.error('MCP call did not return a confirmed result. Inspect status before continuing; never replay an unknown mutation.')
  process.exitCode = 1
} finally { await client.close().catch(() => {}) }
