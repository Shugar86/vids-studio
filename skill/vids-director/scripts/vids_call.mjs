#!/usr/bin/env node
// Optional client of the installed Claude MCP; no separate browser control.
// Pass JSON on stdin with '-' to keep capabilities out of shell arguments.
import {pathToFileURL, fileURLToPath} from 'node:url'
import {writeFileSync, readFileSync, realpathSync} from 'node:fs'
import {resolve} from 'node:path'

const [tool, json = '{}', ...rest] = process.argv.slice(2)
if (!tool?.startsWith('vids_')) {
  console.error('usage: vids_call.mjs <vids_tool> [json-args|-] [--image out.png]')
  process.exit(2)
}
const candidate = process.env.VIDS_CLAUDE_BRIDGE || fileURLToPath(new URL('../../../', import.meta.url))
let bridge
try {
  bridge = realpathSync(resolve(candidate))
  if (JSON.parse(readFileSync(`${bridge}/profile.json`, 'utf8')).id !== 'claude') throw Error('wrong profile')
} catch {
  console.error('Set VIDS_CLAUDE_BRIDGE to an installed Claude build with profile.json id "claude". No fallback profile is used.')
  process.exit(2)
}
const sdk = file => import(pathToFileURL(`${bridge}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/${file}`).href)
const {Client} = await sdk('index.js')
const {StdioClientTransport} = await sdk('stdio.js')
const imageAt = rest.indexOf('--image')
const imagePath = imageAt >= 0 ? rest[imageAt + 1] : null
const args = JSON.parse(json === '-' ? readFileSync(0, 'utf8') : json)
const client = new Client({name: 'vids-director-cli', version: '1'})
await client.connect(new StdioClientTransport({command: process.execPath, args: [`${bridge}/server/index.mjs`]}))
try {
  const result = await client.callTool({name: tool, arguments: args}, undefined, {timeout: 60000})
  for (const part of result.content || []) {
    if (part.type === 'image') {
      if (!imagePath) { console.log('[image omitted: pass --image path]'); continue }
      writeFileSync(imagePath, Buffer.from(part.data, 'base64'), {flag: 'wx', mode: 0o600})
      console.log(JSON.stringify({image: imagePath, mimeType: part.mimeType}))
    } else console.log(part.text)
  }
  if (result.isError) process.exitCode = 1
} finally { await client.close() }
