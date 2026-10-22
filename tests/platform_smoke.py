"""Run real OS integration checks without touching installed client configuration.

This suite runs on Linux, macOS and Windows. Browser/native messages are a local
protocol fixture; it does not claim acceptance against Chrome or Google Vids.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def run(command, *, cwd=ROOT, env=None, input=None):
    result = subprocess.run([str(item) for item in command], cwd=cwd, env=env,
                            text=True, encoding='utf-8', errors='replace',
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, input=input)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {command}\n{result.stdout}")
    return result.stdout


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


@contextmanager
def private_temporary_directory(parent):
    if sys.platform != 'win32':
        with tempfile.TemporaryDirectory(prefix='vids-platform-', dir=parent) as temporary:
            yield Path(temporary).resolve()
        return
    # Elevated Windows processes may otherwise create Administrators-owned
    # fixtures. Exercise the same explicit owner-SID creation as the runtime.
    sys.path.insert(0, str(ROOT / 'native'))
    from platform_support import ensure_private_directory
    directory = parent / f'vids-platform-{uuid.uuid4().hex[:12]}'
    ensure_private_directory(directory)
    try:
        yield directory
    finally:
        shutil.rmtree(directory)


def create_fixture_file(path, content):
    from platform_support import secure_open
    fd = secure_open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(content)


def widen_access(filename):
    """Deliberately corrupt only an isolated fixture's permissions."""
    if sys.platform == 'win32':
        import ntsecuritycon
        import win32security
        descriptor = win32security.GetFileSecurity(str(filename), win32security.DACL_SECURITY_INFORMATION)
        acl = descriptor.GetSecurityDescriptorDacl()
        everyone = win32security.CreateWellKnownSid(win32security.WinWorldSid, None)
        acl.AddAccessAllowedAce(win32security.ACL_REVISION, ntsecuritycon.FILE_GENERIC_READ, everyone)
        win32security.SetNamedSecurityInfo(str(filename), win32security.SE_FILE_OBJECT,
                                         win32security.DACL_SECURITY_INFORMATION,
                                         None, None, acl, None)
    else:
        Path(filename).chmod(0o644)


def verify_archives(base):
    first, second = base / 'release-a', base / 'release-b'
    for output in (first, second):
        run([sys.executable, ROOT / 'scripts/build_release.py', '--output', output])
    assert sorted(p.name for p in first.iterdir()) == sorted(p.name for p in second.iterdir())
    for file in first.iterdir():
        assert file.read_bytes() == (second / file.name).read_bytes(), file.name
    for line in (first / 'SHA256SUMS').read_text().splitlines():
        digest, name = line.split('  ', 1)
        assert hashlib.sha256((first / name).read_bytes()).hexdigest() == digest, name
    archives = list(first.glob('*.zip'))
    assert len(archives) == 3
    for archive in archives:
        with zipfile.ZipFile(archive) as package:
            prefix = package.namelist()[0].split('/')[0]
            assert package.read(f'{prefix}/LICENSE') == (ROOT / 'LICENSE').read_bytes()
            assert package.read(f'{prefix}/requirements-windows.txt') == (ROOT / 'requirements-windows.txt').read_bytes()
            assert json.loads(package.read(f'{prefix}/package.json'))['license'] == 'MIT'
    print('PASS: all three release archives, MIT/Windows dependency files, checksums and reproducibility')


def verify_private_files(base):
    sys.path.insert(0, str(ROOT / 'native'))
    from platform_support import ensure_private_directory, assert_private_file
    private = base / 'acl-fixture'
    ensure_private_directory(private)
    file = private / 'private.txt'
    create_fixture_file(file, b'isolated fixture')
    assert_private_file(file)
    widen_access(file)
    try:
        assert_private_file(file)
    except (PermissionError, OSError, ValueError):
        pass
    else:
        raise AssertionError('Widened file permissions were accepted')
    if sys.platform == 'win32':
        # -S removes site-packages and therefore pywin32. Missing ACL support
        # must refuse to start, not fall back to an unauthenticated endpoint.
        endpoint = base / 'no-pywin32' / 'bridge.json'
        result = subprocess.run([sys.executable, '-S', str(ROOT / 'native/bridge.py'),
                                 '--socket', str(endpoint), '--registry', str(base / 'no-dependency-registry')],
                                input=b'', stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        assert result.returncode != 0, 'Host started without its Windows ACL dependency'
        assert not endpoint.exists(), 'Host exposed an endpoint without ACL verification'
        print('PASS: Windows refuses to start without its ACL dependency')
    print('PASS: private storage rejects widened permissions')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--widen-acl', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.widen_acl:
        widen_access(args.widen_acl)
        return
    node, bun = shutil.which('node'), shutil.which('bun')
    assert node and bun, 'Node and Bun are required'
    media_tools = {f'VIDS_STUDIO_{name.upper()}': str(Path(shutil.which(name)).absolute())
                   for name in ('ffmpeg', 'ffprobe') if shutil.which(name)}
    assert len(media_tools) == 2, 'FFmpeg and ffprobe are required'
    # Windows verifies the owner profile. A short canonical home path also
    # avoids macOS's 104-byte Unix socket limit and its symlinked /tmp alias.
    temporary_parent = Path.home().resolve()
    with private_temporary_directory(temporary_parent) as base:
        env = {**os.environ, 'PYTHONUTF8': '1', 'VIDS_STUDIO_PYTHON': sys.executable,
               'VIDS_PLATFORM_SMOKE_DIR': str(base), 'XDG_STATE_HOME': str(base / 'mcp-state'),
               'VIDS_STUDIO_FLEET_DIR': str(base / 'fleet'),
               'VIDS_STUDIO_MEDIA_BUDGET_DIR': str(base / 'media-budget')}
        verify_private_files(base)
        setup = module('vids_platform_setup', ROOT / 'scripts/setup.py')
        backups, configurations, launchers, profile_targets, profile_environments = [], {}, {}, {}, {}
        registry_root = rf'Software\VidsStudioTests\{uuid.uuid4().hex}'
        codex_dir, claude_dir = base / 'config/codex', base / 'config/claude'
        from platform_support import ensure_private_directory
        ensure_private_directory(codex_dir)
        ensure_private_directory(claude_dir)
        codex_config, claude_config = codex_dir / 'config.toml', base / 'config/claude.json'
        create_fixture_file(codex_config, b'# retained setting\nmodel = "fixture"\n')
        create_fixture_file(claude_config, b'{"theme":"fixture","mcpServers":{"previous":{"command":"fixture"}}}\n')
        configurations = {file: file.read_bytes() for file in (codex_config, claude_config)}
        try:
            for profile in ('codex', 'claude'):
                target = base / 'Установка 🎥' / profile
                profile_targets[profile] = str(target)
                run([sys.executable, ROOT / 'scripts/build_profiles.py', '--profile', profile, '--target', target, '--write'], env=env)
                run([sys.executable, ROOT / 'scripts/build_profiles.py', '--profile', profile, '--target', target, '--check'], env=env)
                run([bun, 'install', '--frozen-lockfile'], cwd=target, env=env)
                selected_python = sys.executable
                if sys.platform == 'win32' and profile == 'codex':
                    # Exercise Unicode paths in both the bridge and Python
                    # itself. Claude separately covers the external interpreter.
                    run([sys.executable, '-m', 'venv', '--system-site-packages', target / '.venv'], env=env)
                    selected_python = str(target / '.venv/Scripts/python.exe')
                definition = json.loads((target / 'profile.json').read_text(encoding='utf-8'))
                helper = target / 'skill' / definition['skillName'] / 'scripts/take_manifest.py'
                take_manifest = base / f'{profile}-takes.json'
                created = json.loads(run([sys.executable, helper, take_manifest], env=env,
                                         input=json.dumps({'op': 'init', 'project_id': 'native-platform-fixture'})))
                assert created['ok'] is True
                status = json.loads(run([sys.executable, helper, take_manifest], env=env,
                                        input=json.dumps({'op': 'status'})))
                assert status['ok'] is True and status['result']['project_id'] == 'native-platform-fixture'
                plan = setup.prepare(target, codex_dir, base / 'chrome', node, profile=profile,
                                     claude_dir=claude_dir, claude_config=claude_config,
                                     registry_root=registry_root, python=selected_python)
                assert {file: file.read_bytes() for file in configurations} == configurations, 'Dry-run changed configuration'
                backup = setup.install(plan)
                assert backup is not None
                backups.append(backup)
                host = json.loads(plan['host_path'].read_text(encoding='utf-8'))
                assert len(host['allowed_origins']) == 1 and '*' not in host['allowed_origins'][0]
                launchers[profile] = host['path']
                configured = (tomllib.loads(codex_config.read_text(encoding='utf-8'))['mcp_servers']
                              if profile == 'codex' else json.loads(claude_config.read_text(encoding='utf-8'))['mcpServers'])
                profile_environments[profile] = configured[definition['mcpName']].get('env', {})
                if sys.platform in ('win32', 'darwin'):
                    assert profile_environments[profile]['VIDS_STUDIO_PYTHON'] == str(Path(selected_python).resolve())
                    for key, value in media_tools.items():
                        pinned = Path(profile_environments[profile][key])
                        assert pinned.is_absolute() and pinned.resolve() == Path(value).resolve(), f'{profile}: missing or incorrect {key} pin'
                repeated = setup.prepare(target, codex_dir, base / 'chrome', node, profile=profile,
                                         claude_dir=claude_dir, claude_config=claude_config,
                                         registry_root=registry_root, python=selected_python)
                assert setup.install(repeated) is None, 'Repeated install was not idempotent'
                configurations = {file: file.read_bytes() for file in configurations}
            (base / 'launchers.json').write_text(json.dumps(launchers), encoding='utf-8')
            (base / 'profile-targets.json').write_text(json.dumps(profile_targets), encoding='utf-8')
            (base / 'profile-environments.json').write_text(json.dumps(profile_environments), encoding='utf-8')
            # Linux preserves its existing installer config, so pass explicit
            # pins there; Windows/macOS exercise the actual installed pins.
            env.update(media_tools if sys.platform == 'linux' else {
                key: profile_environments['codex'][key] for key in media_tools})
            print('PASS: Unicode profile paths, frozen dependencies, isolated installation and idempotence')
            print(run([node, '--test', '--test-concurrency=1', ROOT / 'tests/platform_mcp.mjs'], env=env), end='')
        finally:
            for backup in reversed(backups):
                assert not setup.rollback(backup)['restored']
                setup.rollback(backup, apply=True)
        assert codex_config.read_bytes() == b'# retained setting\nmodel = "fixture"\n'
        assert claude_config.read_bytes() == b'{"theme":"fixture","mcpServers":{"previous":{"command":"fixture"}}}\n'
        for profile in ('codex', 'claude'):
            definition = json.loads((Path(profile_targets[profile]) / 'profile.json').read_text(encoding='utf-8'))
            assert not (base / 'chrome/NativeMessagingHosts' / f"{definition['nativeHostName']}.json").exists()
        if sys.platform == 'win32':
            import winreg
            for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
                try:
                    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, registry_root, 0, winreg.KEY_READ | view)
                except FileNotFoundError:
                    continue
                with key:
                    assert winreg.QueryInfoKey(key)[0] == 0, 'Installer left a native-host registry entry after rollback'
                winreg.DeleteKeyEx(winreg.HKEY_CURRENT_USER, registry_root, view)
        print('PASS: rollback restored exact client configuration and removed native registrations')
        verify_archives(base)
    print(f'PASS: native platform smoke on {sys.platform}; no live browser or Google Vids used')


if __name__ == '__main__':
    main()
