#!/usr/bin/env node
// Local monitoring only. Browser work is never dispatched by this server.
import http from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile, unlink, lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, join} from 'node:path';
import {stateHome, windowsFileCheck} from './platform-files.mjs';
import {privateDirectory} from './jobs-store.mjs';
import {readMonitoredJobs} from './jobs-monitor.mjs';

const executeFile = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ASSETS = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const MAX_BODY = 2048;
const MAX_RESPONSE = 1024 * 1024;
const safeText = (value, maximum = 256) => typeof value === 'string' ? value.slice(0, maximum) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const fields = (source, strings = [], numbers = [], booleans = []) => Object.fromEntries([
  ...strings.map(key => [key, safeText(source?.[key])]), ...numbers.map(key => [key, number(source?.[key])]),
  ...booleans.map(key => [key, typeof source?.[key] === 'boolean' ? source[key] : null]),
].filter(([, value]) => value !== null));

// An explicit projection is a second boundary against capabilities or private
// endpoint descriptors accidentally appearing in a future registry schema.
export function publicSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isFinite(value.generatedAt) || !Array.isArray(value.sessions) || value.sessions.length > 512) throw new Error('INVALID_FLEET_SNAPSHOT');
  const result = {
    schemaVersion: 1, generatedAt: value.generatedAt,
    ...fields(value, ['status', 'reason']),
    policy: fields(value.policy, ['adaptationReason'], ['maxConcurrency', 'effectiveConcurrency'], ['paused','telemetryAvailable']),
    resources: {...fields(value.resources, ['reason'], ['active', 'waiting', 'pending', 'captureBytes', 'captureLimitBytes', 'memoryAvailableBytes', 'memoryTotalBytes', 'cpuPercent', 'measuredAt', 'logicalCpuCount']),
      pressure: Object.fromEntries(['cpu','memory','io'].map(key => [key, fields(value.resources?.pressure?.[key], [], ['avg10', 'avg60', 'avg300'])])), gpu: null},
    summary: fields(value.summary, [], ['attached', 'active', 'remoteWait', 'throttled', 'needsAttention', 'stale']),
    sessions: value.sessions.map(session => ({
      ...fields(session, ['id', 'documentId', 'profileId', 'browserInstanceId', 'sessionId', 'ownerLabel', 'title', 'state', 'stage', 'reason', 'method', 'lastAction'], ['pending', 'ageSeconds', 'updatedAt'], ['stale', 'paused']),
      runtime: {...fields(session.runtime, ['version', 'buildId', 'profileId'], ['protocol']),
        host: fields(session.runtime?.host,['version','buildId','profileId'],['protocol']),
        extension: fields(session.runtime?.extension,['version','buildId','profileId'],['protocol'])},
      recovery: {...fields(session.recovery, ['phase', 'method']),blocks:Array.isArray(session.recovery?.blocks)?session.recovery.blocks.filter(value=>['mutations','screenshot'].includes(value)):[]},
      metrics: fields(session.metrics, [], ['requests', 'errors']),
      ...(session.error ? {error: fields(session.error, ['code', 'message'])} : {}),
    })),
    jobs: {status: safeText(value.jobs?.status,32) || 'not_reported',records:Array.isArray(value.jobs?.records) ? value.jobs.records.slice(0,200).map(job=>({
      ...fields(job,['jobId','profileId','documentId','sessionId','state','reportedState','stage','updatedAt','issueCode'],[],['runnerFresh','cancelRequested','hasVerifiedFile']),
    })) : []},
    localMedia: fields(value.localMedia,['status'],['maxSlots','reservedSlots']),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE) throw new Error('FLEET_SNAPSHOT_LIMIT');
  return result;
}

export function createFleetCLI({python = process.env.VIDS_STUDIO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), registryDirectory,
  jobsDirectory = join(stateHome(),'vids-studio-jobs'), mediaBudgetDirectory} = {}) {
  return async (operation, policy) => {
    const args = [join(ROOT, 'native/fleet.py'), operation, '--json'];
    if (registryDirectory) args.push('--directory', registryDirectory);
    if (operation === 'policy') {
      if (policy.paused !== undefined) args.push('--paused', String(policy.paused));
      if (policy.maxConcurrency !== undefined) args.push('--max-concurrency', String(policy.maxConcurrency));
      if (policy.sessionId !== undefined) args.push('--session-id', policy.sessionId);
    }
    const {stdout} = await executeFile(python, args, {timeout: 5000, maxBuffer: MAX_RESPONSE, windowsHide: true});
    const response = JSON.parse(stdout);
    if (response.ok !== true || !response.result) throw new Error('FLEET_UNAVAILABLE');
    if(operation==='snapshot'){
      response.result.jobs=await readMonitoredJobs(jobsDirectory);
      const mediaArgs=[join(ROOT,'native/media_budget.py'),'status'];
      if(mediaBudgetDirectory)mediaArgs.push('--directory',mediaBudgetDirectory);
      try{const media=JSON.parse((await executeFile(python,mediaArgs,{timeout:2000,maxBuffer:16384,windowsHide:true})).stdout);response.result.localMedia={status:'available',maxSlots:media.result.maxSlots,reservedSlots:media.result.slots.length};}
      catch{response.result.localMedia={status:'unavailable'};}
    }
    return response.result;
  };
}

function authorized(header, token) {
  if (typeof header !== 'string' || header.length !== token.length + 7 || !header.startsWith('Bearer ')) return false;
  return timingSafeEqual(Buffer.from(header.slice(7)), Buffer.from(token));
}

async function body(request) {
  if (request.headers['content-type'] !== 'application/json') throw new Error('CONTENT_TYPE');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('BODY_LIMIT');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['paused', 'maxConcurrency', 'sessionId'].includes(key)) || !Object.keys(value).length ||
      ('paused' in value && typeof value.paused !== 'boolean') || ('maxConcurrency' in value && (!Number.isInteger(value.maxConcurrency) || value.maxConcurrency < 1 || value.maxConcurrency > 100)) ||
      ('maxConcurrency' in value && 'paused' in value) ||
      ('sessionId' in value && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.sessionId) || !('paused' in value) || 'maxConcurrency' in value))) throw new Error('INVALID_POLICY');
  return value;
}

export async function startDashboard({fleet = createFleetCLI(), token = randomBytes(32).toString('base64url'), clock = Date.now} = {}) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('INVALID_MONITOR_CAPABILITY');
  const assets = new Map(await Promise.all([...ASSETS].map(async ([url, [file, type]]) => [url, {type, bytes: await readFile(join(ROOT, 'dashboard', file))}])));
  let origin, pending, cached, cacheTime = 0, inflight = 0;
  const snapshot = async () => {
    if (cached && clock() - cacheTime < 1500) return cached;
    if (!pending) pending = Promise.resolve().then(() => fleet('snapshot')).then(publicSnapshot).then(result => { cached = result; cacheTime = clock(); return result; }).finally(() => { pending = null; });
    return pending;
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader('X-Frame-Options', 'DENY');
    const send = (status, value) => { response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); response.end(JSON.stringify(value)); };
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.headers.host !== origin.slice(7) ||
        (request.headers.origin && request.headers.origin !== origin) || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) return send(403, {error: 'LOCAL_ORIGIN_REQUIRED'});
    if (++inflight > 16) { inflight--; return send(429, {error: 'MONITOR_BUSY'}); }
    try {
      const asset = assets.get(request.url);
      if (asset && request.method === 'GET') { response.writeHead(200, {'Content-Type': asset.type}); response.end(asset.bytes); return; }
      if (!['/api/snapshot', '/api/policy'].includes(request.url)) return send(404, {error: 'NOT_FOUND'});
      if (!authorized(request.headers.authorization, token) || request.headers['x-vids-monitor'] !== '1') return send(401, {error: 'MONITOR_AUTH_REQUIRED'});
      if (request.url === '/api/snapshot' && request.method === 'GET') return send(200, await snapshot());
      if (request.url === '/api/policy' && request.method === 'POST') {
        // A bearer header alone is not a cross-origin write permission.
        if (request.headers.origin !== origin) return send(403, {error: 'LOCAL_ORIGIN_REQUIRED'});
        let policy;
        try { policy = await body(request); } catch { return send(400, {error: 'INVALID_POLICY'}); }
        await fleet('policy', policy);
        // Discard an older in-flight snapshot before publishing the new policy.
        await pending?.catch(() => {}); cached = null; cacheTime = 0;
        return send(200, {ok: true, snapshot: await snapshot()});
      }
      send(405, {error: 'METHOD_NOT_ALLOWED'});
    } catch { send(503, {error: 'FLEET_UNAVAILABLE'}); }
    finally { inflight--; }
  });
  server.maxConnections = 32; server.requestTimeout = 8000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {origin, url: `${origin}/#${token}`, token, close: () => new Promise((resolve, reject) => { server.closeIdleConnections(); server.close(error => error ? reject(error) : resolve()); })};
}

export async function launchDashboard() {
  const directory = privateDirectory(join(stateHome(), 'vids-studio', 'monitor'));
  const dashboard = await startDashboard();
  const descriptor = join(directory, `monitor-${process.pid}-${randomBytes(6).toString('hex')}.json`);
  try {
    if (process.platform === 'win32') windowsFileCheck('create-file', descriptor);
    await writeFile(descriptor, JSON.stringify({schemaVersion: 1, pid: process.pid, url: dashboard.url}) + '\n', {flag: process.platform === 'win32' ? 'w' : 'wx', mode: 0o600});
    if (process.platform === 'win32') windowsFileCheck('verify-file', descriptor);
    const identity = await lstat(descriptor); let closing = false;
    const close = async () => {
      if (closing) return; closing = true;
      await dashboard.close();
      try { const info = await lstat(descriptor); if (info.dev === identity.dev && info.ino === identity.ino) await unlink(descriptor); } catch {}
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close(); });
    process.stdout.write(`Vids Studio monitor\n${dashboard.url}\nPrivate launch file: ${descriptor}\n`);
    return {...dashboard, descriptor, close};
  } catch (error) { await dashboard.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) { process.stderr.write('Usage: node server/fleet-dashboard.mjs\n'); process.exitCode = 2; }
  else await launchDashboard().catch(() => { process.stderr.write('Could not start the private local monitor. Check its state directory and runtime.\n'); process.exitCode = 1; });
}
