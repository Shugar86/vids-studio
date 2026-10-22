#!/usr/bin/env node
// Opt-in paid/account-backed acceptance. CI uses fleet-integration.test.mjs.
import {spawn, execFileSync} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir, homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchFullChainFixture} from '../tests/fleet-chain-fixture.mjs';
import {MCP_RUNTIME} from '../server/runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
if (!argv.includes('--run-agents')) {
  console.error('Opt-in only: node scripts/parallel_smoke.mjs --run-agents --count 5 [--report /absolute/report.json]. Uses your existing Codex login and model usage, in disposable browser fixtures.');
  process.exit(2);
}
const value = name => argv[argv.indexOf(name) + 1];
const count = argv.includes('--count') ? Number(value('--count')) : 5;
if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('This bounded acceptance supports 1–10 real agents.');
const reportPath = argv.includes('--report') ? resolve(value('--report')) : null;
const python = process.env.VIDS_STUDIO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
// Read only model preferences into this process; never copy authentication or
// the user's live MCP/browser configuration into the fixture agent.
const preferences = JSON.parse(execFileSync(python, ['-c',
  'import json,pathlib,sys,tomllib; p=pathlib.Path(sys.argv[1]); c=tomllib.loads(p.read_text()) if p.exists() else {}; print(json.dumps({k:c[k] for k in ("model","model_reasoning_effort","model_service_tier") if k in c}))', configPath], {encoding: 'utf8', windowsHide: true}));
const work = await mkdtemp(join(tmpdir(), 'vids-agent-acceptance-'));
let fixture;
const children = new Set();
const records = [];
const startedAt = new Date().toISOString();
try {
  fixture = await launchFullChainFixture({count, connectClients: false});
  const tomlString = s => JSON.stringify(String(s));
  const fixtureEnv = Object.fromEntries(Object.entries(fixture.env).filter(([key]) => key.startsWith('VIDS_STUDIO_')));
  const envTable = Object.entries(fixtureEnv).map(([k, v]) => `${k}=${tomlString(v)}`).join(',');
  const mcp = `mcp_servers={vids_acceptance={command=${tomlString(process.execPath)},args=[${tomlString(join(root, 'server/index.mjs'))}],env={${envTable}},required=true,startup_timeout_sec=30,tool_timeout_sec=45,default_tools_approval_mode="approve"}}`;
  await Promise.all(Array.from({length: count}, async (_, index) => {
    const dir = join(work, `agent-${index + 1}`); await mkdir(dir, {mode: 0o700});
    const assigned = fixture.sessions[index];
    const ticket = fixture.attached[index].pairing.ticket;
    const bindingId = randomUUID(), intentId = randomUUID(), bindingToken = randomBytes(32).toString('base64url');
    const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', dir, '--json', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', mcp];
    for (const [k, v] of Object.entries(preferences)) args.push('-c', `${k}=${JSON.stringify(v)}`);
    for (const feature of ['apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent', 'image_generation', 'shell_tool', 'unified_exec']) args.push('--disable', feature);
    args.push('-');
    const env = {...process.env}; delete env.CODEX_THREAD_ID;
    const record = {agent: index + 1, startedAt: new Date().toISOString(), completedAt: null, exitCode: null, toolCalls: 0, callsByTool: {}, toolResults: [], verified: false};
    records.push(record);
    const child = spawn(process.env.VIDS_STUDIO_CODEX || 'codex', args, {env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']}); children.add(child);
    const timeout = setTimeout(() => child.kill(), 240000);
    let pending = '';
    child.stdout.on('data', chunk => {
      pending += chunk;
      if (pending.length > 2 * 1024 * 1024) { pending = ''; child.kill(); return; }
      for (;;) {
        const newline = pending.indexOf('\n'); if (newline < 0) break;
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
            record.toolCalls++;
            const name = String(event.item.tool || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80);
            record.callsByTool[name] = (record.callsByTool[name] || 0) + 1;
            let code = null;
            try { code = JSON.parse(event.item.result?.content?.find(c => c.type === 'text')?.text || '{}').error?.code || null; } catch {}
            record.toolResults.push({tool: name, status: event.item.status, isError: event.item.result?.isError, code, transportError: Boolean(event.item.error),
              ...(event.item.error ? {transportErrorReason: JSON.stringify(event.item.error).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 400)} : {})});
          }
          if (event.type === 'turn.failed' || event.type === 'error') record.clientError = true;
        } catch { /* Never print raw events: tool arguments may contain capabilities. */ }
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(`Complete this bounded Vids Studio acceptance task using only the vids_acceptance MCP tools. The browser is a disposable local fixture; the user explicitly authorized this isolated test. Do not use shell, files, browser tools, OS input, external services, or any other document. Work independently of the other agents.\n\nYour exact assigned sessionId is ${assigned.sessionId}; expectedDocumentId is ${assigned.documentId}. Your private one-time pairingTicket is ${ticket}; your private bindingId is ${bindingId}, bindingToken is ${bindingToken}, intentId is ${intentId}. These credentials belong only to your task. Do not print them. Owner label: Codex acceptance ${index + 1}.\n\n1. Read vids_status for your exact session. 2. Claim your attachment with the supplied credentials. 3. Acquire your control with your binding credentials and exact expectedDocumentId. 4. Observe, locate the button named "Apply ${index}", then click that observed nodeRef using that fresh snapshot and a unique operation_id. 5. Observe again and establish that your page now contains "edited ${index}". 6. Release your control, then your binding. Do not take screenshots. If the fleet rejects an operation with outcome not_performed due to capacity, observe again before a bounded retry; never retry an unknown mutation. Finish with only a short success or failure report, with no credentials.\n`);
    await new Promise(resolveClose => {
      child.on('error', () => {record.clientError = true; resolveClose();});
      child.on('close', code => {record.exitCode = code; resolveClose();});
    });
    clearTimeout(timeout); children.delete(child); record.completedAt = new Date().toISOString();
    record.pageResult = await fixture.browserFixture.pages[index].locator('output').textContent();
    record.verified = record.pageResult === `edited ${index}`;
    const verifier = await fixture.connectClient(index);
    const status = await verifier.callTool({name: 'vids_status', arguments: {sessionId: assigned.sessionId}});
    const state = JSON.parse(status.content.find(c => c.type === 'text').text);
    record.controlReleased = state.control?.held === false;
    record.compatible = state.compatibility?.ready === true;
    process.stdout.write(JSON.stringify({agent: record.agent, exitCode: record.exitCode, verified: record.verified, toolCalls: record.toolCalls}) + '\n');
  }));
  fixture.check();
  const coverUntouched = await fixture.browserFixture.cover.locator('input').inputValue() === 'untouched';
  const activeUnchanged = JSON.stringify(await fixture.browserFixture.activeTabs()) === JSON.stringify(fixture.browserFixture.activeBefore);
  const firstEnd = Math.min(...records.map(r => Date.parse(r.completedAt)));
  const overlappingAgents = records.filter(r => Date.parse(r.startedAt) < firstEnd).length;
  const discovery = await fixture.clients[0].callTool({name: 'vids_list_sessions', arguments: {}});
  const bindingsReleased = JSON.parse(discovery.content.find(c => c.type === 'text').text).sessions.every(s => !s.ownerLabel);
  const successfulCalls = (record, name) => record.toolResults.filter(t => t.tool === name && t.status === 'completed' && !t.code && !t.transportError && !t.isError).length;
  const report = {schemaVersion: 1, startedAt, completedAt: new Date().toISOString(), runtime: MCP_RUNTIME, kind: 'real_codex_agents_local_chrome_fixture', count, overlappingAgents, coverUntouched, activeUnchanged, bindingsReleased,
    allPassed: coverUntouched && activeUnchanged && bindingsReleased && records.every(r => r.exitCode === 0 && !r.clientError && r.verified && r.controlReleased && r.compatible &&
      ['vids_claim_attachment','vids_acquire_control','vids_click','vids_release_control','vids_release_binding'].every(name => successfulCalls(r, name) >= 1) && successfulCalls(r, 'vids_observe') >= 2), agents: records.sort((a, b) => a.agent - b.agent),
    scope: 'Actual Codex model processes, actual MCP/native hosts and Chrome extension. Local fixture pages; not live Google Vids editing, generation, quotas or export acceptance.'};
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  process.stdout.write(JSON.stringify(report) + '\n');
  if (!report.allPassed) process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await fixture?.close();
  await rm(work, {recursive: true, force: true});
}
