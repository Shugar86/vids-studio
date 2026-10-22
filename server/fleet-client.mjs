import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {PROFILE} from './runtime.mjs';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('../native/fleet.py', import.meta.url));
let cached;
let reading;

const empty = () => ({schemaVersion: 1, generatedAt: Date.now() / 1000, sessions: [], summary: {}, policy: {}, resources: {}});

// Discovery reads only metadata published by explicitly attached workers. It
// never enumerates Chrome tabs, creates an attachment, or returns capabilities.
export async function fleetSnapshot({env = process.env, fresh = false} = {}) {
  if (env.VIDS_STUDIO_SOCKET && !env.VIDS_STUDIO_FLEET_DIR) return empty();
  const key = JSON.stringify([env.VIDS_STUDIO_FLEET_DIR, env.VIDS_STUDIO_REGISTRY_DIR, env.XDG_STATE_HOME, env.HOME, env.USERPROFILE, env.LOCALAPPDATA, env.VIDS_STUDIO_PYTHON]);
  if (!fresh && cached?.key === key && Date.now() - cached.at < 750) return cached.value;
  if (reading?.key === key) return reading.promise;
  const promise = (async () => {
    const python = env.VIDS_STUDIO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    try {
      const {stdout} = await execute(python, [helper, 'snapshot', '--json'], {
        env, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
      });
      const envelope = JSON.parse(stdout);
      if (envelope.ok !== true || envelope.result?.schemaVersion !== 1 || !Array.isArray(envelope.result.sessions)) throw new Error('Invalid fleet snapshot');
      const value = envelope.result;
      cached = {key, at: Date.now(), value};
      return value;
    } catch {
      const error = new Error('Could not read the private fleet registry. Check the shared monitor; no browser action was performed.');
      error.code = 'FLEET_UNAVAILABLE';
      throw error;
    } finally { if (reading?.promise === promise) reading = null; }
  })();
  reading = {key, promise};
  return promise;
}

const PUBLIC_FIELDS = ['sessionId', 'documentId', 'profileId', 'browserInstanceId', 'ownerLabel', 'state', 'updatedAt', 'pending', 'paused', 'runtime', 'lastAction', 'recovery', 'bindingId', 'claimed', 'connected'];
export async function listSessions(options = {}) {
  const snapshot = await fleetSnapshot(options);
  return {schemaVersion: 1, generatedAt: snapshot.generatedAt, profileId: PROFILE.id,
    sessions: snapshot.sessions.filter(item => item.profileId === PROFILE.id).map(item =>
      Object.fromEntries(PUBLIC_FIELDS.filter(key => item[key] !== undefined).map(key => [key, item[key]]))),
    policy: snapshot.policy, resources: snapshot.resources,
  };
}
