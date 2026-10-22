import net from 'node:net';
import path from 'node:path';
import {randomUUID, randomBytes, createHmac, timingSafeEqual} from 'node:crypto';
import {lstat, realpath, stat, open} from 'node:fs/promises';
import {lstatSync} from 'node:fs';
import {PROFILE, MCP_RUNTIME} from './runtime.mjs';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {listSessions} from './fleet-client.mjs';

const executeFile = promisify(execFile);
const WINDOWS = process.platform === 'win32';

export const MAX_RESPONSE = 24 * 1024 * 1024;
export const LOCAL_PROTOCOL = 3;
export const MUTATIONS = new Set(['click', 'drag', 'scroll', 'type_text', 'press_key', 'upload', 'upload_via_picker', 'export_trigger']);
export const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4', '.webm', '.mov', '.m4v', '.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac', '.srt', '.vtt']);

export function privateRuntimeDirectory(candidate, uid = process.getuid?.()) {
  if (WINDOWS) return false;
  if (!candidate || !path.isAbsolute(candidate)) return false;
  try {
    const info = lstatSync(candidate);
    return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o7777) === 0o700;
  } catch { return false; }
}

export function socketPath(env = process.env) {
  if (env.VIDS_STUDIO_SOCKET) return env.VIDS_STUDIO_SOCKET;
  if (WINDOWS) return path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'VidsStudio', 'runtime', PROFILE.socketNamespace, 'bridge.json');
  const uid = process.getuid();
  if (process.platform === 'darwin') return `/private/tmp/${PROFILE.socketNamespace}-${uid}/bridge.sock`;
  // Codex/MCP child environments may omit XDG_RUNTIME_DIR while Chrome has it.
  for (const runtime of [env.XDG_RUNTIME_DIR, `/run/user/${uid}`]) {
    if (privateRuntimeDirectory(runtime, uid)) return path.join(runtime, PROFILE.socketNamespace, 'bridge.sock');
  }
  return `/tmp/${PROFILE.socketNamespace}-${uid}/bridge.sock`;
}

async function windowsEndpoint(endpoint) {
  if (!path.isAbsolute(endpoint)) throw new Error('Endpoint must be absolute');
  const helper = fileURLToPath(new URL('../native/platform_support.py', import.meta.url));
  const verify = () => executeFile(process.env.VIDS_STUDIO_PYTHON || 'python', [helper, 'verify-file', endpoint], {timeout: 10000, windowsHide: true, maxBuffer: 65536});
  const before = await lstat(endpoint);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 4096) throw new Error('Invalid descriptor');
  await verify();
  const handle = await open(endpoint, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Descriptor changed');
    const data = JSON.parse(await handle.readFile({encoding: 'utf8'}));
    await verify();
    const after = await lstat(endpoint);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw new Error('Descriptor changed');
    if (data.v !== 1 || data.transport !== 'tcp' || data.host !== '127.0.0.1' || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535 || !/^[0-9a-f]{64}$/.test(data.token)) throw new Error('Invalid descriptor');
    return data;
  } finally { await handle.close(); }
}

export async function validateUpload(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 20) throw new Error('Provide 1..20 media files');
  return Promise.all(files.map(async file => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Uploads require absolute local paths');
    if (!MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new Error('Only allowlisted media and SRT/VTT subtitle files can be uploaded');
    const resolved = await realpath(file);
    if (!MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error('Upload symlink target must also be a media file');
    const info = await stat(resolved);
    if (!info.isFile() || info.size === 0) throw new Error('Upload path must be a nonempty regular media file');
    return resolved;
  }));
}

export const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionSocketPath(sessionId, base = socketPath()) {
  if (typeof sessionId !== 'string' || !SESSION_UUID.test(sessionId)) throw Object.assign(new Error('Use an exact session UUID from vids_list_sessions.'), {code: 'SESSION_REQUIRED'});
  return path.join(path.dirname(base), 'sessions', `${sessionId}.${WINDOWS ? 'json' : 'sock'}`);
}

export async function bridgeRequest(method, args = {}, options = {}) {
  // Explicit endpoints are used by isolated transport tests and legacy tools.
  // Otherwise every fleet action is routed by its immutable attachment ID.
  if (options.socketPath) return transportRequest(method, args, options);
  if (method === 'list_sessions') {
    try { return {ok: true, result: await listSessions({fresh: true})}; }
    catch (error) { return failure(error.code || 'FLEET_UNAVAILABLE', error.message); }
  }
  if (args.sessionId && SESSION_UUID.test(args.sessionId)) {
    const endpoint = sessionSocketPath(args.sessionId);
    try {
      await lstat(endpoint);
      return transportRequest(method, args, {...options, socketPath: endpoint});
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return failure('SOCKET_CHECK_FAILED', 'Could not inspect this session endpoint.');
      try {
        await lstat(path.dirname(endpoint));
        return failure('NOT_CONNECTED', 'This attachment is disconnected. Reconnect only its intended document and obtain a fresh session; another tab was not selected.');
      } catch (directoryError) {
        if (!['ENOENT', 'ENOTDIR'].includes(directoryError.code)) return failure('SOCKET_CHECK_FAILED', 'Could not inspect the session directory.');
      }
    }
  }
  if (['status', 'diagnostics'].includes(method) && !args.sessionId) {
    try {
      const fleet = await listSessions();
      if (fleet.sessions.length) return {ok: true, result: {...fleet, fleet: true, attached: false,
        selectionRequired: true, nextStep: 'Choose the exact document authorized for this chat. Claim its pairing ticket, then pass its sessionId explicitly to every tool. No active tab is selected automatically.'}};
    } catch (error) { return failure(error.code || 'FLEET_UNAVAILABLE', error.message); }
  }
  return transportRequest(method, args, options);
}

async function transportRequest(method, args = {}, options = {}) {
  const {sessionId, operation_id, controlToken, ...params} = args;
  const mutating = MUTATIONS.has(method) || ['acquire_control', 'renew_control', 'release_control', 'reconcile_control', 'claim_attachment', 'resume_binding', 'release_binding'].includes(method);
  const id = randomUUID();
  const request = {v: LOCAL_PROTOCOL, type: 'request', id, method, params, client: MCP_RUNTIME};
  if (sessionId !== undefined) request.sessionId = sessionId;
  if (operation_id !== undefined) request.operation_id = operation_id;
  if (controlToken !== undefined) request.controlToken = controlToken;
  let data = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(data) > 256 * 1024) return failure('REQUEST_TOO_LARGE', 'Request exceeds 256 KiB; split long text into smaller insertions');
  const endpoint = options.socketPath || socketPath();
  let descriptor;
  try {
    if (WINDOWS) descriptor = await windowsEndpoint(endpoint);
    else {
      const [dir, sock] = await Promise.all([lstat(path.dirname(endpoint)), lstat(endpoint)]);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700 ||
          !sock.isSocket() || sock.uid !== process.getuid() || (sock.mode & 0o777) !== 0o600) {
        return failure('UNSAFE_SOCKET', 'Bridge endpoint must be an owned 0600 socket in a private 0700 directory');
      }
    }
  } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes(err.code)) return failure('NOT_CONNECTED', 'Open the Vids Studio extension and attach the intended Google Vids tab');
    return failure('SOCKET_CHECK_FAILED', 'Could not verify the private local bridge endpoint');
  }
  return new Promise(resolve => {
    const socket = net.createConnection(WINDOWS ? {host: descriptor.host, port: descriptor.port} : endpoint);
    const clientNonce = WINDOWS ? randomBytes(32).toString('hex') : null;
    let authenticated = !WINDOWS;
    let done = false;
    let sent = false;
    let chunks = [];
    let buffered = 0;
    const finish = response => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };
    const transportFailure = (code, message) => finish(failure(code, message, mutating && sent));
    const timer = setTimeout(() => transportFailure('TIMEOUT', 'Bridge timed out. Observe the document; do not replay an uncertain mutation'), options.timeoutMs ?? 24000);
    socket.on('connect', () => {
      if (WINDOWS) socket.write(`${JSON.stringify({v: 1, type: 'transport_hello', nonce: clientNonce})}\n`);
      else { sent = true; socket.write(data); }
    });
    socket.on('data', chunk => {
      if (buffered + chunk.length > (authenticated ? MAX_RESPONSE : 4096)) return transportFailure('RESPONSE_TOO_LARGE', 'Bridge response exceeds 24 MiB');
      chunks.push(chunk);
      buffered += chunk.length;
      if (chunk.indexOf(10) < 0) return;
      const buffer = Buffer.concat(chunks, buffered);
      const end = buffer.indexOf(10);
      try {
        const response = JSON.parse(buffer.subarray(0, end).toString('utf8'));
        if (!authenticated) {
          if (response.v !== 1 || response.type !== 'transport_challenge' || !/^[0-9a-f]{64}$/.test(response.nonce) || !/^[0-9a-f]{64}$/.test(response.proof) || buffer.subarray(end + 1).toString().trim()) return finish(failure('UNSAFE_SOCKET', 'Native host authentication failed; no browser request was sent'));
          const proof = role => createHmac('sha256', Buffer.from(descriptor.token, 'hex')).update(`${role}:${clientNonce}:${response.nonce}`, 'ascii').digest('hex');
          if (!timingSafeEqual(Buffer.from(response.proof, 'hex'), Buffer.from(proof('server'), 'hex'))) return finish(failure('UNSAFE_SOCKET', 'Native host authentication failed; no browser request was sent'));
          data = `${JSON.stringify({...request, transportProof: proof('client')})}\n`;
          if (Buffer.byteLength(data) > 256 * 1024) return finish(failure('REQUEST_TOO_LARGE', 'Request exceeds the authenticated transport limit'));
          authenticated = true; chunks = []; buffered = 0; sent = true; socket.write(data); return;
        }
        // Old v1/v2 hosts reject v3 before forwarding any browser operation.
        // Their explicit INVALID_ARGUMENT reply requests an upgrade safely.
        if ([1, 2].includes(response.v) && response.type === 'response' && response.id === id && response.ok === false && response.error?.code === 'INVALID_ARGUMENT') {
          return finish(failure('RECONNECT_REQUIRED', `The native bridge is from an older version. Reload the ${PROFILE.displayName} extension card and explicitly attach the intended tab; no browser action was performed`));
        }
        if (response.v !== LOCAL_PROTOCOL || response.type !== 'response' || response.id !== id || typeof response.ok !== 'boolean') throw new Error('Invalid response');
        finish(response);
      } catch { transportFailure('INVALID_RESPONSE', 'Malformed bridge response'); }
    });
    socket.on('error', err => transportFailure(['ECONNREFUSED', 'ENOENT'].includes(err.code) ? 'NOT_CONNECTED' : 'DISCONNECTED', 'Native bridge is unavailable; reconnect through the extension'));
    socket.on('end', () => transportFailure('DISCONNECTED', 'Bridge closed without a receipt. Observe before any further mutation'));
  });
}

export function failure(code, message, unknown = false) {
  return {ok: false, error: {code, message, outcome: unknown ? 'unknown' : 'not_performed'}};
}
