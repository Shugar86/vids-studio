import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrapper = join(root, 'skill/vids-director/scripts/vids_call.mjs');
const available = await access(wrapper).then(() => true, () => false);

test('Claude CLI preserves explicit Vids endpoints through the real SDK without forwarding unrelated secrets', {skip: !available, timeout: 15000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vids-cli-env-'));
  const keys = ['VIDS_STUDIO_SOCKET', 'VIDS_STUDIO_FLEET_DIR', 'VIDS_STUDIO_REGISTRY_DIR',
    'VIDS_STUDIO_MEDIA_BUDGET_DIR', 'VIDS_STUDIO_PYTHON', 'VIDS_STUDIO_FFMPEG',
    'VIDS_STUDIO_FFPROBE', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME'];
  try {
    await mkdir(join(directory, 'server'));
    await mkdir(join(directory, 'node_modules/@modelcontextprotocol'), {recursive: true});
    await symlink(join(root, 'node_modules/@modelcontextprotocol/sdk'),
      join(directory, 'node_modules/@modelcontextprotocol/sdk'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(directory, 'profile.json'), JSON.stringify({id: 'claude'}));
    const moduleUrl = name => pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server', name)).href;
    // This private MCP fixture never loads the native bridge or opens a socket.
    await writeFile(join(directory, 'server/index.mjs'), `
      import {McpServer} from ${JSON.stringify(moduleUrl('mcp.js'))};
      import {StdioServerTransport} from ${JSON.stringify(moduleUrl('stdio.js'))};
      const server = new McpServer({name:'private-env-fixture',version:'1'});
      server.tool('vids_status', {}, async () => ({content:[{type:'text',text:JSON.stringify({
        received:Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,process.env[key]??null])),
        unrelated:process.env.VIDS_STUDIO_UNRELATED_SECRET??null,
        provider:process.env.OPENAI_API_KEY??null
      })}]}));
      await server.connect(new StdioServerTransport());
    `);
    const expected = Object.fromEntries(keys.map(key => [key, join(directory, key.toLowerCase())]));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wrapper, 'vids_status', '-'], {env: {...process.env, ...expected,
        VIDS_CLAUDE_BRIDGE: directory, VIDS_STUDIO_UNRELATED_SECRET: 'fixture-unrelated', OPENAI_API_KEY: 'fixture-provider'},
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
      let stdout = '', stderr = '';
      const deadline = setTimeout(() => child.kill('SIGKILL'), 8000);
      child.stdout.on('data', value => stdout += value);
      child.stderr.on('data', value => stderr += value);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', code => { clearTimeout(deadline); resolve({code, stdout, stderr}); });
      child.stdin.end('{}');
    });
    assert.equal(result.code, 0, result.stderr);
    const observed = JSON.parse(result.stdout.trim());
    assert.deepEqual(observed.received, expected);
    assert.equal(observed.unrelated, null);
    assert.equal(observed.provider, null);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
