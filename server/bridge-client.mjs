import net from 'node:net';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstat, realpath, stat} from 'node:fs/promises';
import {lstatSync} from 'node:fs';
import {PROFILE, MCP_RUNTIME} from './runtime.mjs';

export const MAX_RESPONSE = 24 * 1024 * 1024;
export const LOCAL_PROTOCOL = 3;
export const MUTATIONS = new Set(['click', 'drag', 'scroll', 'type_text', 'press_key', 'upload', 'upload_via_picker', 'export_trigger']);
export const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4', '.webm', '.mov', '.m4v', '.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac', '.srt', '.vtt']);

export function privateRuntimeDirectory(candidate, uid = process.getuid()) {
  if (!candidate || !path.isAbsolute(candidate)) return false;
  try {
    const info = lstatSync(candidate);
    return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o7777) === 0o700;
  } catch { return false; }
}

export function socketPath(env = process.env) {
  if (env.VIDS_STUDIO_SOCKET) return env.VIDS_STUDIO_SOCKET;
  const uid = process.getuid();
  // Codex/MCP child environments may omit XDG_RUNTIME_DIR while Chrome has it.
  for (const runtime of [env.XDG_RUNTIME_DIR, `/run/user/${uid}`]) {
    if (privateRuntimeDirectory(runtime, uid)) return path.join(runtime, PROFILE.socketNamespace, 'bridge.sock');
  }
  return `/tmp/${PROFILE.socketNamespace}-${uid}/bridge.sock`;
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

export async function bridgeRequest(method, args = {}, options = {}) {
  const {sessionId, operation_id, controlToken, ...params} = args;
  const mutating = MUTATIONS.has(method) || ['acquire_control', 'renew_control', 'release_control', 'reconcile_control'].includes(method);
  const id = randomUUID();
  const request = {v: LOCAL_PROTOCOL, type: 'request', id, method, params, client: MCP_RUNTIME};
  if (sessionId !== undefined) request.sessionId = sessionId;
  if (operation_id !== undefined) request.operation_id = operation_id;
  if (controlToken !== undefined) request.controlToken = controlToken;
  const data = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(data) > 256 * 1024) return failure('REQUEST_TOO_LARGE', 'Request exceeds 256 KiB; split long text into smaller insertions');
  const endpoint = options.socketPath || socketPath();
  try {
    const [dir, sock] = await Promise.all([lstat(path.dirname(endpoint)), lstat(endpoint)]);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700 ||
        !sock.isSocket() || sock.uid !== process.getuid() || (sock.mode & 0o777) !== 0o600) {
      return failure('UNSAFE_SOCKET', 'Bridge endpoint must be an owned 0600 socket in a private 0700 directory');
    }
  } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes(err.code)) return failure('NOT_CONNECTED', 'Open the Vids Studio extension and attach the intended Google Vids tab');
    return failure('SOCKET_CHECK_FAILED', 'Could not verify the local bridge endpoint');
  }
  return new Promise(resolve => {
    const socket = net.createConnection(endpoint);
    let done = false;
    let sent = false;
    let buffer = Buffer.alloc(0);
    const finish = response => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };
    const transportFailure = (code, message) => finish(failure(code, message, mutating && sent));
    const timer = setTimeout(() => transportFailure('TIMEOUT', 'Bridge timed out. Observe the document; do not replay an uncertain mutation'), options.timeoutMs ?? 24000);
    socket.on('connect', () => { sent = true; socket.write(data); });
    socket.on('data', chunk => {
      if (buffer.length + chunk.length > MAX_RESPONSE) return transportFailure('RESPONSE_TOO_LARGE', 'Bridge response exceeds 24 MiB');
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, end).toString('utf8'));
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
