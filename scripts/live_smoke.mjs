#!/usr/bin/env node
// Explicit-document, read-only live acceptance. Never prints owner capabilities.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function runSmoke(client, {documentId, screenshotPath, write = writeFile}) {
  if (typeof documentId !== 'string' || !documentId) throw new Error('An explicit expected document ID is required.');
  if (screenshotPath && !path.isAbsolute(screenshotPath)) throw new Error('Screenshot output must be absolute.');
  let control;
  const evidence = {readOnly: true, passed: false, documentMatched: false, stages: [], released: false};
  async function call(method, args = {}) {
    const response = await client.callTool({name: `vids_${method}`, arguments: args});
    const data = JSON.parse(response.content.find(item => item.type === 'text').text);
    if (response.isError || data.error || data.ok === false) throw new Error(`${method}: ${data.error?.code || 'FAILED'}`);
    return {response, data};
  }
  try {
    await client.connect(new StdioClientTransport({command: process.execPath,
      args: [fileURLToPath(new URL('../server/index.mjs', import.meta.url))]}));
    const listed = await client.listTools();
    evidence.tools = listed.tools.map(tool => tool.name);
    const {data: diagnostics} = await call('diagnostics');
    evidence.runtime = diagnostics.runtime;
    if (!diagnostics.compatibility?.ready) throw new Error('Loaded MCP, native host and extension do not match. Reload this profile and refresh the MCP client.');
    const {data: status} = await call('status');
    if (!status.connected || !status.attached || status.documentId !== documentId || typeof status.sessionId !== 'string' || !status.sessionId) throw new Error('The attached document differs from the explicit smoke target.');
    evidence.documentMatched = true;
    evidence.stages.push('status');
    const {data: acquired} = await call('acquire_control', {sessionId: status.sessionId, ownerLabel: 'Upgrade read-only acceptance'});
    const granted = acquired.result;
    if (typeof granted?.sessionId === 'string' && typeof granted.controlToken === 'string' && granted.controlToken.length >= 32) control = {sessionId: granted.sessionId, controlToken: granted.controlToken};
    if (!control || control.sessionId !== status.sessionId) throw new Error('Control receipt does not match the observed attached session.');
    evidence.stages.push('acquire');
    const {data: observed} = await call('observe', {...control, maxNodes: 200});
    const snapshot = observed.result;
    if (snapshot?.documentId !== documentId || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId || !Array.isArray(snapshot.nodes)) throw new Error('Observation does not identify the expected document and a fresh snapshot.');
    evidence.observation = {nodes: snapshot.nodes.length, hasCyrillic: snapshot.nodes.some(node => /[А-Яа-яЁё]/.test(node.name || ''))};
    evidence.stages.push('observe');
    const {response: screenshot, data: metadata} = await call('screenshot', {...control, format: 'png'});
    const frame = screenshot.content.find(item => item.type === 'image');
    if (frame?.mimeType !== 'image/png' || typeof frame.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data) || typeof metadata.snapshotId !== 'string' || !metadata.snapshotId || !(metadata.image?.width > 0 && metadata.image?.height > 0)) throw new Error('No standard MCP PNG ImageContent with snapshot metadata returned.');
    const bytes = Buffer.from(frame.data, 'base64');
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Screenshot content is not a PNG.');
    evidence.screenshot = {mimeType: frame.mimeType, bytes: bytes.length};
    if (screenshotPath) await write(screenshotPath, bytes, {flag: 'wx', mode: 0o600});
    evidence.stages.push('screenshot');
  } catch (error) {
    evidence.error = String(error.message);
  } finally {
    if (control) {
      try {
        const {data} = await call('release_control', control);
        if (data.result?.released !== true) throw new Error('Release receipt did not confirm that control was released.');
        evidence.released = true;
        evidence.stages.push('release');
      } catch (error) { evidence.releaseError = String(error.message); }
    }
    try { await client.close(); } catch (error) { evidence.closeError = String(error.message); }
  }
  evidence.passed = !evidence.error && !evidence.releaseError && !evidence.closeError && evidence.released && evidence.stages.includes('screenshot');
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    if (!['--document', '--screenshot'].includes(key) || !process.argv[i + 1]) throw new Error('Usage: node scripts/live_smoke.mjs --document ID [--screenshot /absolute/new.png]');
    options[key] = process.argv[i + 1];
  }
  const client = new Client({name: 'vids-explicit-read-only-smoke', version: '1'});
  const evidence = await runSmoke(client, {documentId: options['--document'], screenshotPath: options['--screenshot']});
  process.exitCode = evidence.passed ? 0 : 1;
  console.log(JSON.stringify(evidence, null, 2));
}
