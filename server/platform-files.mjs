import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {homedir} from 'node:os';

// Use the same Python environment as Chrome's native host. Never invoke a shell.
export function windowsFileCheck(command, path) {
  try {
    const result = JSON.parse(execFileSync(process.env.VIDS_STUDIO_PYTHON || 'python',
      [fileURLToPath(new URL('../native/platform_support.py', import.meta.url)), command, path],
      {encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true}));
    if (result.ok !== true) throw new Error('Private storage check failed');
    return result;
  } catch {
    const error = new Error('Windows storage ownership or ACL check failed. Use the Python environment selected during installation.');
    error.code = 'UNSAFE_JOB_STORE';
    throw error;
  }
}

export function stateHome(env = process.env, platform = process.platform, home = homedir()) {
  if (env.XDG_STATE_HOME) return env.XDG_STATE_HOME;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'VidsStudio');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'VidsStudio');
  return join(home, '.local', 'state');
}
