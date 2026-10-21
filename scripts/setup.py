#!/usr/bin/env python3
"""Inspect/install one named Vids Studio profile, or restore its exact config files."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib
import uuid

ROOT = Path(__file__).resolve().parents[1]
SERVER_NAME = 'google-vids'  # Legacy imports; CLI/plan use the selected profile.
HOST_NAME = 'com.vids_studio.bridge'
MARKER = '# Managed by vids-studio/scripts/setup.py'


def verify_node(node):
    """Run only the explicitly selected executable, before touching config."""
    try:
        result = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=5, check=True)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError('The selected Node executable did not report its version') from exc
    match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)\s*', result.stdout)
    if not match or tuple(map(int, match.groups())) < (22, 13, 0):
        raise ValueError('Node.js 22.13.0 or newer is required for the built-in SQLite job store')
    return result.stdout.strip()


def extension_id(manifest):
    key = base64.b64decode(manifest['key'], validate=True)
    return ''.join(chr(ord('a') + int(n, 16)) for n in hashlib.sha256(key).hexdigest()[:32])


def atomic_write(path, content, mode=0o600):
    path = Path(path)
    if path.is_symlink():
        raise ValueError(f'Refusing to replace symlink: {path}')
    if path.exists() and not path.is_file():
        raise ValueError(f'Not a regular file: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.vids-', dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content.encode() if isinstance(content, str) else content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def snapshot(path):
    path = Path(path)
    if path.is_symlink():
        return {'kind': 'symlink', 'target': os.readlink(path)}
    if not path.exists():
        return {'kind': 'absent'}
    if not path.is_file():
        raise ValueError(f'Expected a file or managed symlink: {path}')
    return {'kind': 'file', 'data': base64.b64encode(path.read_bytes()).decode(),
            'mode': stat.S_IMODE(path.stat().st_mode)}


def restore_snapshot(path, value):
    path = Path(path)
    if value['kind'] == 'file':
        if path.is_symlink():
            path.unlink()
        atomic_write(path, base64.b64decode(value['data'], validate=True), value['mode'])
    elif value['kind'] == 'symlink':
        if path.exists() or path.is_symlink():
            path.unlink()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(value['target'], target_is_directory=True)
    elif value['kind'] == 'absent':
        path.unlink(missing_ok=True)
    else:
        raise ValueError('Invalid rollback snapshot')


def identity(root, profile=None):
    installed = json.loads((root / 'profile.json').read_text()) if (root / 'profile.json').exists() else None
    profile = profile or (installed or {}).get('id', 'codex')
    if profile not in ('codex', 'claude'):
        raise ValueError('Profile must be codex or claude')
    source = root / 'profiles' / f'{profile}.json'
    definition = json.loads(source.read_text())
    if definition.get('id') != profile or definition.get('schemaVersion') != 1:
        raise ValueError('Invalid profile definition')
    if installed and installed.get('id') != profile:
        raise ValueError('This checkout was materialized for another profile')
    return definition


def prepare(root, codex_dir, chrome_dir, node, *, profile=None, claude_dir=None, claude_config=None):
    """Validate all target files before writing; never activates a browser/client."""
    root, codex_dir, chrome_dir = Path(root), Path(codex_dir), Path(chrome_dir)
    if sys.platform != 'linux':
        raise ValueError('This installer currently supports Linux only')
    selected = identity(root, profile)
    skill_name, server_name = selected['skillName'], selected['mcpName']
    for relative in ['extension/manifest.json', 'native/bridge.py', 'server/index.mjs', f'skill/{skill_name}/SKILL.md']:
        if not (root / relative).is_file():
            raise ValueError(f'Missing package file: {relative}')
    if not os.access(root / 'native/bridge.py', os.X_OK):
        raise ValueError('Native host is not executable; run chmod +x native/bridge.py in this package')
    if not Path(node).is_file() or not os.access(node, os.X_OK):
        raise ValueError(f'Node executable not found: {node}')
    if not (root / 'node_modules/@modelcontextprotocol/sdk/package.json').is_file():
        raise ValueError('Install locked dependencies first: bun install --frozen-lockfile')
    manifest = json.loads((root / 'extension/manifest.json').read_text())
    if manifest.get('key') != selected['extensionKey']:
        raise ValueError('Extension identity does not match the selected profile')
    eid = extension_id(manifest)
    host_path = chrome_dir / 'NativeMessagingHosts' / f'{selected["nativeHostName"]}.json'
    host = {'name': selected['nativeHostName'], 'description': 'Google Vids Studio local bridge',
            'path': str(root / 'native/bridge.py'), 'type': 'stdio',
            'allowed_origins': [f'chrome-extension://{eid}/']}
    if host_path.is_symlink():
        raise ValueError(f'Native host manifest is a symlink: {host_path}')
    if host_path.exists():
        existing_host = json.loads(host_path.read_text())
        # Description is a client label, not a routing/authority difference.
        if {k: v for k, v in existing_host.items() if k != 'description'} != {k: v for k, v in host.items() if k != 'description'}:
            raise ValueError(f'A different native host already exists: {host_path}')
        host = existing_host
    client_dir = codex_dir if selected['id'] == 'codex' else Path(claude_dir or Path.home() / '.claude')
    skill_path, skill_source = client_dir / 'skills' / skill_name, root / 'skill' / skill_name
    if skill_path.exists() or skill_path.is_symlink():
        if not skill_path.is_symlink() or skill_path.resolve() != skill_source.resolve():
            raise ValueError(f'An unrelated skill already exists: {skill_path}')
    config_path = codex_dir / 'config.toml' if selected['id'] == 'codex' else Path(claude_config or Path.home() / '.claude.json')
    if config_path.is_symlink():
        raise ValueError(f'Client config is a symlink; edit its source explicitly: {config_path}')
    old_config = config_path.read_text() if config_path.exists() else ''
    if selected['id'] == 'codex':
        config = tomllib.loads(old_config)
        expected = {'command': node, 'args': [str(root / 'server/index.mjs')], 'startup_timeout_sec': 15, 'tool_timeout_sec': 35}
        existing = config.get('mcp_servers', {}).get(server_name)
        if existing is not None and existing != expected:
            raise ValueError(f'A different [mcp_servers.{server_name}] exists; no settings changed')
        addition = ('\n\n' + MARKER + f'\n[mcp_servers.{server_name}]\n' + f'command = {json.dumps(node)}\n'
                    + f'args = [{json.dumps(str(root / "server/index.mjs"))}]\nstartup_timeout_sec = 15\ntool_timeout_sec = 35\n')
        new_config = old_config if existing is not None else old_config + addition
        tomllib.loads(new_config)
    else:
        config = json.loads(old_config) if old_config else {}
        if not isinstance(config, dict) or not isinstance(config.get('mcpServers', {}), dict):
            raise ValueError('Claude config/mcpServers must be JSON objects')
        expected = {'type': 'stdio', 'command': node, 'args': [str(root / 'server/index.mjs')], 'env': {}}
        existing = config.get('mcpServers', {}).get(server_name)
        if existing is not None:
            normalized = {'type': 'stdio', 'env': {}, **existing} if isinstance(existing, dict) else existing
            if normalized != expected:
                raise ValueError(f'A different mcpServers.{server_name} exists; no settings changed')
            new_config = old_config
        else:
            config.setdefault('mcpServers', {})[server_name] = expected
            new_config = json.dumps(config, ensure_ascii=False, indent=2) + '\n'
    updates = []
    desired_host = json.dumps(host, indent=2) + '\n'
    for path, content in ((host_path, desired_host), (config_path, new_config)):
        before = snapshot(path)
        # An equivalent existing host should not be reformatted.
        if path == host_path and before['kind'] == 'file':
            content = path.read_text()
        mode = before.get('mode', 0o600)
        after = {'kind': 'file', 'data': base64.b64encode(content.encode()).decode(), 'mode': mode}
        updates.append({'path': str(path), 'before': before, 'after': after})
    updates.append({'path': str(skill_path), 'before': snapshot(skill_path),
                    'after': {'kind': 'symlink', 'target': str(skill_source)}})
    return {'profile': selected, 'extensionId': eid, 'extensionDirectory': str(root / 'extension'),
            'host_path': host_path, 'host': host, 'skill_path': skill_path, 'skill_source': skill_source,
            'config_path': config_path, 'old_config': old_config, 'new_config': new_config,
            'node': node, 'root': root, 'updates': updates}


def install(plan, backup_dir=None):
    """Transactional config change with a private exact-file rollback record."""
    updates = plan['updates']
    for update in updates:
        if snapshot(update['path']) != update['before']:
            raise ValueError('Configuration changed during setup; no target files were changed. Rerun dry-run')
    changed = [u for u in updates if u['before'] != u['after']]
    if not changed:
        return None
    directory = Path(backup_dir or plan['root'] / '.runtime' / 'install-backups')
    if directory.is_symlink():
        raise ValueError('Rollback directory must not be a symlink')
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Rollback directory must be owned and mode 0700')
    backup = directory / f'{plan["profile"]["id"]}-{uuid.uuid4().hex}.json'
    record = {'schemaVersion': 1, 'profile': plan['profile']['id'], 'updates': changed}
    atomic_write(backup, json.dumps(record, indent=2) + '\n')
    applied = []
    try:
        for update in changed:
            if snapshot(update['path']) != update['before']:
                raise ValueError('Configuration changed during setup; restoring preceding updates')
            restore_snapshot(update['path'], update['after'])
            applied.append(update)
    except BaseException:
        for update in reversed(applied):
            if snapshot(update['path']) == update['after']:
                restore_snapshot(update['path'], update['before'])
        raise
    return backup


def rollback(backup, *, apply=False):
    backup = Path(backup)
    info = backup.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('Rollback record must be an owned regular 0600 file')
    record = json.loads(backup.read_text())
    if record.get('schemaVersion') != 1 or record.get('profile') not in ('codex', 'claude'):
        raise ValueError('Invalid rollback record')
    for update in record['updates']:
        if not Path(update['path']).is_absolute():
            raise ValueError('Rollback target must be absolute')
        if snapshot(update['path']) != update['after']:
            raise ValueError(f'Rollback target changed after install; preserving it: {update["path"]}')
    if apply:
        applied = []
        try:
            for update in reversed(record['updates']):
                restore_snapshot(update['path'], update['before'])
                applied.append(update)
        except BaseException:
            for update in reversed(applied):
                restore_snapshot(update['path'], update['after'])
            raise
    return {'profile': record['profile'], 'restored': apply, 'files': [u['path'] for u in record['updates']], 'runtimeActivated': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=('codex', 'claude'))
    parser.add_argument('--install', action='store_true', help='Apply reviewed local files/config; never activates clients or Chrome')
    parser.add_argument('--rollback', type=Path, help='Inspect rollback; combine with --install to restore')
    parser.add_argument('--backup-dir', type=Path)
    parser.add_argument('--codex-dir', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))))
    parser.add_argument('--claude-dir', type=Path, default=Path.home() / '.claude')
    parser.add_argument('--claude-config', type=Path, default=Path.home() / '.claude.json')
    parser.add_argument('--chrome-dir', type=Path, default=Path.home() / '.config/google-chrome')
    parser.add_argument('--node', default=shutil.which('node'))
    args = parser.parse_args()
    try:
        if args.rollback:
            print(json.dumps(rollback(args.rollback, apply=args.install), ensure_ascii=False, indent=2))
            return 0
        if args.node is None:
            raise ValueError('Node.js is not installed')
        node_version = verify_node(str(Path(args.node).absolute()))
        plan = prepare(ROOT, args.codex_dir.expanduser().absolute(), args.chrome_dir.expanduser().absolute(), str(Path(args.node).absolute()),
                       profile=args.profile, claude_dir=args.claude_dir.expanduser().absolute(), claude_config=args.claude_config.expanduser().absolute())
        backup = install(plan, args.backup_dir) if args.install else None
        print(json.dumps({'installed': args.install, 'profile': plan['profile']['id'], 'nodeVersion': node_version, 'extensionId': plan['extensionId'],
            'extensionDirectory': plan['extensionDirectory'], 'nativeHostManifest': str(plan['host_path']),
            'skill': str(plan['skill_path']), 'mcpServer': plan['profile']['mcpName'],
            'changedFiles': [u['path'] for u in plan['updates'] if u['before'] != u['after']],
            'rollbackRecord': str(backup) if backup else None, 'runtimeActivated': False,
            'next': 'Reload the named unpacked extension at a convenient pause, reconnect the intended Vids tab, then refresh this client.'}, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, KeyError, OSError, tomllib.TOMLDecodeError) as exc:
        print(f'Setup refused: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
