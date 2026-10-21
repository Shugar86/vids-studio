#!/usr/bin/env python3
"""Inspect/install one named Vids Studio profile, or restore its exact config files."""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import re
import shutil
import shlex
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
REGISTRY_ROOT = r'Software\Google\Chrome\NativeMessagingHosts'
SKILL_MARKER = '.vids-studio-managed.json'


def is_windows():
    return sys.platform == 'win32'


def security():
    # The runtime and installer share Windows owner/ACL checks.
    spec = importlib.util.spec_from_file_location('vids_setup_security', ROOT / 'native/platform_support.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def default_chrome_directory():
    if sys.platform == 'darwin':
        return Path.home() / 'Library/Application Support/Google/Chrome'
    if is_windows():
        return Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local'))) / 'Google/Chrome/User Data'
    return Path.home() / '.config/google-chrome'


def windows_native_launcher(python, root):
    """ASCII batch text; cmd.exe expands its own Unicode directory via %~dp0."""
    python, root = str(python), str(root)
    if any('"' in value or '\n' in value or '\r' in value for value in (python, root)):
        raise ValueError('Unsupported quote or newline in installation path')
    try:
        relative = ntpath.relpath(python, ntpath.join(root, '.runtime'))
    except ValueError:  # A selected Python on another drive needs an absolute path.
        relative = None
    if relative is not None and relative.isascii():
        interpreter = '%~dp0' + relative.replace('%', '%%')
    elif python.isascii():
        interpreter = python.replace('%', '%%')
    else:
        raise ValueError('Create a package-local .venv and run its Scripts\\python.exe: this external Python path cannot be represented safely in the Windows launcher')
    # The bridge and launcher are fixed siblings inside the package; no user
    # path bytes enter the batch source. Disable delayed expansion for ! paths.
    return f'@echo off\r\nsetlocal DisableDelayedExpansion\r\n"{interpreter}" -u "%~dp0..\\native\\bridge.py" %*\r\n'


def client_environment(python):
    if sys.platform == 'linux':
        return {}
    environment = {'VIDS_STUDIO_PYTHON': python}
    for command in ('ffmpeg', 'ffprobe'):
        executable = shutil.which(command)
        if executable:
            environment['VIDS_STUDIO_' + command.upper()] = str(Path(executable).absolute())
    return environment


def file_mode(path):
    # NTFS access is verified using DACLs, not POSIX chmod bits.
    return 0o600 if is_windows() else stat.S_IMODE(Path(path).stat().st_mode)


def reparse_point(path):
    return bool(getattr(Path(path).lstat(), 'st_file_attributes', 0) & 0x400)


def registry_snapshot(key, view=32):
    import winreg
    access = winreg.KEY_READ | (winreg.KEY_WOW64_32KEY if view == 32 else winreg.KEY_WOW64_64KEY)
    try:
        handle = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, access)
    except FileNotFoundError:
        return {'kind': 'absent'}
    with handle:
        values, children = [], []
        for function, output in ((winreg.EnumValue, values), (winreg.EnumKey, children)):
            index = 0
            while True:
                try:
                    output.append(function(handle, index))
                    index += 1
                except OSError as exc:
                    if getattr(exc, 'winerror', None) != 259:
                        raise
                    break
        # Store binary values losslessly; unrelated values are never changed.
        encoded = []
        for name, value, value_type in values:
            encoded.append([name, {'base64': base64.b64encode(value).decode()} if isinstance(value, bytes) else value, value_type])
        return {'kind': 'registry', 'values': sorted(encoded), 'children': sorted(children)}


def restore_registry(key, value, view=32):
    import winreg
    access = winreg.KEY_READ | winreg.KEY_WRITE | (winreg.KEY_WOW64_32KEY if view == 32 else winreg.KEY_WOW64_64KEY)
    if value['kind'] == 'absent':
        # The precondition already excludes later user edits. Delete only our
        # default value and an otherwise empty key, never a parent subtree.
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, access) as handle:
            winreg.DeleteValue(handle, '')
        winreg.DeleteKeyEx(winreg.HKEY_CURRENT_USER, key, access & (winreg.KEY_WOW64_32KEY | winreg.KEY_WOW64_64KEY), 0)
        return
    desired = next((item for item in value['values'] if item[0] == ''), None)
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key, 0, access) as handle:
        if desired:
            payload = desired[1]
            if isinstance(payload, dict) and set(payload) == {'base64'}:
                payload = base64.b64decode(payload['base64'], validate=True)
            winreg.SetValueEx(handle, '', 0, desired[2], payload)
        else:
            try:
                winreg.DeleteValue(handle, '')
            except FileNotFoundError:
                pass


def update_snapshot(update):
    if update.get('registryKey'):
        return registry_snapshot(update['registryKey'], update['registryView'])
    return snapshot(update['path'])


def restore_update(update, which):
    if update.get('registryKey'):
        restore_registry(update['registryKey'], update[which], update['registryView'])
    else:
        restore_snapshot(update['path'], update[which])


def update_label(update):
    return 'HKCU\\' + update['registryKey'] if update.get('registryKey') else update['path']


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
    if is_windows():
        private = security()
        private.ensure_private_directory(path.parent)
        temporary = path.parent / ('.vids-' + uuid.uuid4().hex)
        descriptor = private.secure_open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix='.vids-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            if not is_windows():
                os.fchmod(stream.fileno(), mode)
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
    if path.is_dir():
        if reparse_point(path):
            raise ValueError(f'Refusing reparse point: {path}')
        files, directories = {}, []
        for child in sorted(path.rglob('*')):
            relative = child.relative_to(path)
            if '__pycache__' in relative.parts or child.suffix in ('.pyc', '.pyo'):
                continue
            if child.is_symlink() or reparse_point(child):
                raise ValueError(f'Refusing link in managed skill: {child}')
            if child.is_file():
                files[child.relative_to(path).as_posix()] = {'data': base64.b64encode(child.read_bytes()).decode(), 'mode': file_mode(child)}
            elif child.is_dir():
                directories.append(relative.as_posix())
            else:
                raise ValueError(f'Not a regular skill file: {child}')
        return {'kind': 'directory', 'files': files, 'directories': directories}
    if not path.is_file():
        raise ValueError(f'Expected a file or managed symlink: {path}')
    return {'kind': 'file', 'data': base64.b64encode(path.read_bytes()).decode(),
            'mode': file_mode(path)}


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
    elif value['kind'] == 'directory':
        # Only installer-validated managed trees reach this function. Build the
        # replacement first; no privileged symlink/developer mode is required.
        if is_windows():
            temporary = path.parent / ('.vids-skill-' + uuid.uuid4().hex)
            security().ensure_private_directory(temporary)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = Path(tempfile.mkdtemp(prefix='.vids-skill-', dir=path.parent))
        try:
            for name in value.get('directories', []):
                relative = Path(name)
                if relative.anchor or '..' in relative.parts:
                    raise ValueError('Invalid managed skill directory')
                if is_windows():
                    security().ensure_private_directory(temporary / relative)
                else:
                    (temporary / relative).mkdir(parents=True, exist_ok=True)
            for name, item in value['files'].items():
                relative = Path(name)
                if relative.anchor or '..' in relative.parts:
                    raise ValueError('Invalid managed skill path')
                atomic_write(temporary / relative, base64.b64decode(item['data'], validate=True), item['mode'])
            if path.exists():
                old = path.with_name('.vids-old-' + uuid.uuid4().hex)
                os.replace(path, old)
                try:
                    os.replace(temporary, path)
                except BaseException:
                    os.replace(old, path)
                    raise
                shutil.rmtree(old)
            else:
                os.replace(temporary, path)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    elif value['kind'] == 'absent':
        if path.is_dir() and not path.is_symlink():
            if reparse_point(path):
                raise ValueError('Refusing to remove a reparse point')
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)
    else:
        raise ValueError('Invalid rollback snapshot')


def identity(root, profile=None):
    installed = json.loads((root / 'profile.json').read_text(encoding='utf-8')) if (root / 'profile.json').exists() else None
    profile = profile or (installed or {}).get('id', 'codex')
    if profile not in ('codex', 'claude'):
        raise ValueError('Profile must be codex or claude')
    source = root / 'profiles' / f'{profile}.json'
    definition = json.loads(source.read_text(encoding='utf-8'))
    if definition.get('id') != profile or definition.get('schemaVersion') != 1:
        raise ValueError('Invalid profile definition')
    if installed and installed.get('id') != profile:
        raise ValueError('This checkout was materialized for another profile')
    return definition


def prepare(root, codex_dir, chrome_dir, node, *, profile=None, claude_dir=None, claude_config=None, registry_root=REGISTRY_ROOT, python=None):
    """Validate all target files before writing; never activates a browser/client."""
    root, codex_dir, chrome_dir = Path(root), Path(codex_dir), Path(chrome_dir)
    if sys.platform not in ('linux', 'darwin', 'win32'):
        raise ValueError('This installer supports Linux, macOS and Windows')
    selected = identity(root, profile)
    skill_name, server_name = selected['skillName'], selected['mcpName']
    for relative in ['extension/manifest.json', 'native/bridge.py', 'server/index.mjs', f'skill/{skill_name}/SKILL.md']:
        if not (root / relative).is_file():
            raise ValueError(f'Missing package file: {relative}')
    if sys.platform == 'linux' and not os.access(root / 'native/bridge.py', os.X_OK):
        raise ValueError('Native host is not executable; run chmod +x native/bridge.py in this package')
    if not Path(node).is_file() or (not is_windows() and not os.access(node, os.X_OK)):
        raise ValueError(f'Node executable not found: {node}')
    if not (root / 'node_modules/@modelcontextprotocol/sdk/package.json').is_file():
        raise ValueError('Install locked dependencies first: bun install --frozen-lockfile')
    manifest = json.loads((root / 'extension/manifest.json').read_text(encoding='utf-8'))
    if manifest.get('key') != selected['extensionKey']:
        raise ValueError('Extension identity does not match the selected profile')
    eid = extension_id(manifest)
    python = str(Path(python or sys.executable).resolve())
    if not Path(python).is_file():
        raise ValueError('Python executable not found')
    host_path = chrome_dir / 'NativeMessagingHosts' / f'{selected["nativeHostName"]}.json'
    host_command = root / 'native/bridge.py'
    launcher = None
    if sys.platform == 'darwin':
        host_command = root / '.runtime' / f'{selected["id"]}-native-host.sh'
        launcher = '#!/bin/sh\nexec ' + shlex.quote(python) + ' -u ' + shlex.quote(str(root / 'native/bridge.py')) + ' "$@"\n'
    elif is_windows():
        host_command = root / '.runtime' / f'{selected["id"]}-native-host.cmd'
        launcher = windows_native_launcher(python, root)
    host = {'name': selected['nativeHostName'], 'description': 'Google Vids Studio local bridge',
            'path': str(host_command), 'type': 'stdio',
            'allowed_origins': [f'chrome-extension://{eid}/']}
    if host_path.is_symlink():
        raise ValueError(f'Native host manifest is a symlink: {host_path}')
    if host_path.exists():
        existing_host = json.loads(host_path.read_text(encoding='utf-8'))
        # Description is a client label, not a routing/authority difference.
        if {k: v for k, v in existing_host.items() if k != 'description'} != {k: v for k, v in host.items() if k != 'description'}:
            raise ValueError(f'A different native host already exists: {host_path}')
        host = existing_host
    client_dir = codex_dir if selected['id'] == 'codex' else Path(claude_dir or Path.home() / '.claude')
    skill_path, skill_source = client_dir / 'skills' / skill_name, root / 'skill' / skill_name
    if is_windows():
        desired_skill = snapshot(skill_source)
        if desired_skill['kind'] != 'directory':
            raise ValueError('Skill source must be a directory')
        marker = {'schemaVersion': 1, 'profile': selected['id'], 'source': str(skill_source), 'directories': desired_skill['directories'],
                  'files': {name: hashlib.sha256(base64.b64decode(value['data'])).hexdigest() for name, value in desired_skill['files'].items()}}
        desired_skill['files'][SKILL_MARKER] = {'data': base64.b64encode((json.dumps(marker, indent=2) + '\n').encode()).decode(), 'mode': 0o600}
        if skill_path.exists() or skill_path.is_symlink():
            current = snapshot(skill_path)
            if current['kind'] != 'directory' or SKILL_MARKER not in current['files']:
                raise ValueError(f'An unrelated skill already exists: {skill_path}')
            previous = json.loads(base64.b64decode(current['files'][SKILL_MARKER]['data']))
            hashes = {name: hashlib.sha256(base64.b64decode(value['data'])).hexdigest() for name, value in current['files'].items() if name != SKILL_MARKER}
            if previous.get('schemaVersion') != 1 or previous.get('profile') != selected['id'] or previous.get('source') != str(skill_source) or previous.get('files') != hashes or previous.get('directories', []) != current.get('directories', []):
                raise ValueError(f'Managed skill changed after installation; preserving it: {skill_path}')
    else:
        desired_skill = {'kind': 'symlink', 'target': str(skill_source)}
        if skill_path.exists() or skill_path.is_symlink():
            if not skill_path.is_symlink() or skill_path.resolve() != skill_source.resolve():
                raise ValueError(f'An unrelated skill already exists: {skill_path}')
    config_path = codex_dir / 'config.toml' if selected['id'] == 'codex' else Path(claude_config or Path.home() / '.claude.json')
    if config_path.is_symlink():
        raise ValueError(f'Client config is a symlink; edit its source explicitly: {config_path}')
    old_config = config_path.read_text(encoding='utf-8') if config_path.exists() else ''
    environment = client_environment(python)
    if selected['id'] == 'codex':
        config = tomllib.loads(old_config)
        expected = {'command': node, 'args': [str(root / 'server/index.mjs')], 'startup_timeout_sec': 15, 'tool_timeout_sec': 35}
        if sys.platform != 'linux':
            expected['env'] = environment
        existing = config.get('mcp_servers', {}).get(server_name)
        if existing is not None and existing != expected:
            raise ValueError(f'A different [mcp_servers.{server_name}] exists; no settings changed')
        addition = ('\n\n' + MARKER + f'\n[mcp_servers.{server_name}]\n' + f'command = {json.dumps(node, ensure_ascii=False)}\n'
                    + f'args = [{json.dumps(str(root / "server/index.mjs"), ensure_ascii=False)}]\nstartup_timeout_sec = 15\ntool_timeout_sec = 35\n')
        if sys.platform != 'linux':
            entries = ', '.join(f'{key} = {json.dumps(value, ensure_ascii=False)}' for key, value in environment.items())
            addition += f'env = {{ {entries} }}\n'
        new_config = old_config if existing is not None else old_config + addition
        tomllib.loads(new_config)
    else:
        config = json.loads(old_config) if old_config else {}
        if not isinstance(config, dict) or not isinstance(config.get('mcpServers', {}), dict):
            raise ValueError('Claude config/mcpServers must be JSON objects')
        expected = {'type': 'stdio', 'command': node, 'args': [str(root / 'server/index.mjs')], 'env': {}}
        if sys.platform != 'linux':
            expected['env'] = environment
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
        mode = before.get('mode', 0o600)
        after = before if path == host_path and before['kind'] == 'file' else {'kind': 'file', 'data': base64.b64encode(content.encode()).decode(), 'mode': mode}
        updates.append({'path': str(path), 'before': before, 'after': after})
    updates.append({'path': str(skill_path), 'before': snapshot(skill_path),
                    'after': desired_skill})
    if launcher is not None:
        before = snapshot(host_command)
        content = launcher.encode()
        after = {'kind': 'file', 'data': base64.b64encode(content).decode(), 'mode': 0o600 if is_windows() else 0o700}
        if before['kind'] not in ('absent', 'file') or (before['kind'] == 'file' and before != after):
            raise ValueError('Native launcher already exists with different content; preserve it and inspect the installation')
        updates.append({'path': str(host_command), 'before': before, 'after': after})
    if is_windows():
        if not registry_root.startswith('Software\\') or '..' in registry_root.split('\\'):
            raise ValueError('Windows registry root must be a user Software subkey')
        key = registry_root.rstrip('\\') + '\\' + selected['nativeHostName']
        before = registry_snapshot(key, 32)
        for previous in (before, registry_snapshot(key, 64)):
            default = next((v for v in previous.get('values', []) if v[0] == ''), None)
            if default is not None and default != ['', str(host_path), 1]:
                raise ValueError('A different Windows native host registration exists; no settings changed')
        after = {'kind': 'registry', 'values': sorted([v for v in before.get('values', []) if v[0] != ''] + [['', str(host_path), 1]]), 'children': before.get('children', [])}
        updates.append({'registryKey': key, 'registryView': 32, 'before': before, 'after': after})
    return {'profile': selected, 'extensionId': eid, 'extensionDirectory': str(root / 'extension'),
            'host_path': host_path, 'host': host, 'skill_path': skill_path, 'skill_source': skill_source,
            'config_path': config_path, 'old_config': old_config, 'new_config': new_config,
            'node': node, 'root': root, 'updates': updates}


def install(plan, backup_dir=None):
    """Transactional config change with a private exact-file rollback record."""
    updates = plan['updates']
    for update in updates:
        if update_snapshot(update) != update['before']:
            raise ValueError('Configuration changed during setup; no target files were changed. Rerun dry-run')
    changed = [u for u in updates if u['before'] != u['after']]
    if not changed:
        return None
    directory = Path(backup_dir or plan['root'] / '.runtime' / 'install-backups')
    if directory.is_symlink():
        raise ValueError('Rollback directory must not be a symlink')
    if is_windows():
        security().ensure_private_directory(directory)
    else:
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
            if update_snapshot(update) != update['before']:
                raise ValueError('Configuration changed during setup; restoring preceding updates')
            restore_update(update, 'after')
            applied.append(update)
    except BaseException:
        for update in reversed(applied):
            if update_snapshot(update) == update['after']:
                restore_update(update, 'before')
        raise
    return backup


def rollback(backup, *, apply=False):
    backup = Path(backup)
    info = backup.lstat()
    if is_windows():
        security().assert_private_file(backup)
    elif not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('Rollback record must be an owned regular 0600 file')
    record = json.loads(backup.read_text(encoding='utf-8'))
    if record.get('schemaVersion') != 1 or record.get('profile') not in ('codex', 'claude'):
        raise ValueError('Invalid rollback record')
    for update in record['updates']:
        if update.get('registryKey'):
            if not is_windows() or not update['registryKey'].startswith('Software\\') or update.get('registryView') not in (32, 64):
                raise ValueError('Invalid Windows registry rollback target')
        elif not Path(update['path']).is_absolute():
            raise ValueError('Rollback target must be absolute')
        if update_snapshot(update) != update['after']:
            raise ValueError(f'Rollback target changed after install; preserving it: {update_label(update)}')
    if apply:
        applied = []
        try:
            for update in reversed(record['updates']):
                if update_snapshot(update) != update['after']:
                    raise ValueError(f'Rollback target changed during restore: {update_label(update)}')
                restore_update(update, 'before')
                applied.append(update)
        except BaseException:
            for update in reversed(applied):
                if update_snapshot(update) == update['before']:
                    restore_update(update, 'after')
            raise
    return {'profile': record['profile'], 'restored': apply, 'files': [update_label(u) for u in record['updates']], 'runtimeActivated': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=('codex', 'claude'))
    parser.add_argument('--install', action='store_true', help='Apply reviewed local files/config; never activates clients or Chrome')
    parser.add_argument('--rollback', type=Path, help='Inspect rollback; combine with --install to restore')
    parser.add_argument('--backup-dir', type=Path)
    parser.add_argument('--codex-dir', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))))
    parser.add_argument('--claude-dir', type=Path, default=Path.home() / '.claude')
    parser.add_argument('--claude-config', type=Path, default=Path.home() / '.claude.json')
    parser.add_argument('--chrome-dir', type=Path, default=default_chrome_directory())
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--registry-root', default=REGISTRY_ROOT, help='Windows HKCU native-host root; override only for isolated testing')
    args = parser.parse_args()
    try:
        if args.rollback:
            print(json.dumps(rollback(args.rollback, apply=args.install), ensure_ascii=False, indent=2))
            return 0
        if args.node is None:
            raise ValueError('Node.js is not installed')
        node_version = verify_node(str(Path(args.node).absolute()))
        plan = prepare(ROOT, args.codex_dir.expanduser().absolute(), args.chrome_dir.expanduser().absolute(), str(Path(args.node).absolute()),
                       profile=args.profile, claude_dir=args.claude_dir.expanduser().absolute(), claude_config=args.claude_config.expanduser().absolute(), registry_root=args.registry_root)
        backup = install(plan, args.backup_dir) if args.install else None
        print(json.dumps({'installed': args.install, 'profile': plan['profile']['id'], 'nodeVersion': node_version, 'extensionId': plan['extensionId'],
            'extensionDirectory': plan['extensionDirectory'], 'nativeHostManifest': str(plan['host_path']),
            'skill': str(plan['skill_path']), 'mcpServer': plan['profile']['mcpName'],
            'changedFiles': [update_label(u) for u in plan['updates'] if u['before'] != u['after']],
            'rollbackRecord': str(backup) if backup else None, 'runtimeActivated': False,
            'next': 'Reload the named unpacked extension at a convenient pause, reconnect the intended Vids tab, then refresh this client.'}, ensure_ascii=False, indent=2))
        return 0
    except ImportError:
        print('Setup refused: Windows requires the selected Python environment to install requirements-windows.txt', file=sys.stderr)
        return 1
    except (ValueError, KeyError, OSError, tomllib.TOMLDecodeError) as exc:
        print(f'Setup refused: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
