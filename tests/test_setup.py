"""Installer checks use isolated homes and never touch actual user configuration."""

import importlib.util
import json
import base64
import copy
import os
import subprocess
import sys
from contextlib import ExitStack
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch, Mock

SPEC = importlib.util.spec_from_file_location('vids_setup', Path(__file__).resolve().parents[1] / 'scripts/setup.py')
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


@unittest.skipUnless(sys.platform == 'linux', 'Existing POSIX Linux permission contract')
class InstallerTests(unittest.TestCase):
    def test_node_version_requires_sqlite_without_flag(self):
        for version in ('v18.20.0', 'v22.12.0', 'Python 3.12.0'):
            with self.subTest(version=version), patch.object(setup.subprocess, 'run') as run:
                run.return_value.stdout = version + '\n'
                with self.assertRaisesRegex(ValueError, '22.13.0'):
                    setup.verify_node('/selected/node')
        for version in ('v22.13.0', 'v24.18.1'):
            with self.subTest(version=version), patch.object(setup.subprocess, 'run') as run:
                run.return_value.stdout = version + '\n'
                self.assertEqual(setup.verify_node('/selected/node'), version)
                self.assertEqual(run.call_args.args[0], ['/selected/node', '--version'])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'package'
        for name, content in {
            'extension/manifest.json': json.dumps({'key': json.loads((setup.ROOT / 'profiles/codex.json').read_text())['extensionKey']}),
            'native/bridge.py': '#!/usr/bin/env python3\n',
            'server/index.mjs': '',
            'skill/google-vids/SKILL.md': '---\nname: google-vids\n---\n',
            'node_modules/@modelcontextprotocol/sdk/package.json': '{}',
        }.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        (self.root / 'profiles').mkdir()
        for profile in ('codex', 'claude'):
            (self.root / 'profiles' / f'{profile}.json').write_text((setup.ROOT / 'profiles' / f'{profile}.json').read_text())
        (self.root / 'native/bridge.py').chmod(0o755)
        self.codex = self.base / 'codex'
        self.chrome = self.base / 'chrome'
        self.codex.mkdir()
        self.config = self.codex / 'config.toml'
        self.original = '# retain this comment\nmodel = "existing-model"\n[mcp_servers.previous]\ncommand = "previous"\n'
        self.config.write_text(self.original)

    def plan(self):
        return setup.prepare(self.root, self.codex, self.chrome, '/usr/bin/python3')

    def test_preserves_existing_config_and_is_idempotent(self):
        plan = self.plan()
        setup.install(plan)
        first = self.config.read_text()
        self.assertTrue(first.startswith(self.original))
        parsed = tomllib.loads(first)
        self.assertEqual(parsed['mcp_servers']['previous'], {'command': 'previous'})
        self.assertNotIn('default_tools_approval_mode', parsed['mcp_servers']['google-vids'])
        self.assertTrue((self.codex / 'skills/google-vids').is_symlink())
        host = json.loads(plan['host_path'].read_text())
        self.assertEqual(len(host['allowed_origins']), 1)
        self.assertNotIn('*', host['allowed_origins'][0])
        setup.install(self.plan())
        self.assertEqual(self.config.read_text(), first)

    def test_refuses_existing_other_skill_before_writes(self):
        existing = self.codex / 'skills/google-vids'
        existing.mkdir(parents=True)
        (existing / 'SKILL.md').write_text('user skill')
        with self.assertRaisesRegex(ValueError, 'unrelated skill'):
            self.plan()
        self.assertEqual(self.config.read_text(), self.original)
        self.assertFalse(self.chrome.exists())

    def test_refuses_nonexecutable_native_host_before_config_changes(self):
        (self.root / 'native/bridge.py').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'chmod'):
            self.plan()
        self.assertEqual(self.config.read_text(), self.original)
        self.assertFalse(self.chrome.exists())

    def test_refuses_other_mcp_server(self):
        self.config.write_text(self.original + '\n[mcp_servers.google-vids]\ncommand = "other"\n')
        with self.assertRaisesRegex(ValueError, 'different'):
            self.plan()
        self.assertFalse(self.chrome.exists())

    def test_refuses_symlink_host(self):
        target = self.base / 'unrelated.json'
        target.write_text('{}')
        host = self.chrome / 'NativeMessagingHosts/com.vids_studio.bridge.json'
        host.parent.mkdir(parents=True)
        host.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.plan()
        self.assertEqual(target.read_text(), '{}')

    def test_does_not_overwrite_concurrent_config_edit(self):
        plan = self.plan()
        self.config.write_text(self.original + '\n# concurrent user edit\n')
        with self.assertRaisesRegex(ValueError, 'changed during setup'):
            setup.install(plan)
        self.assertIn('# concurrent user edit', self.config.read_text())
        self.assertFalse(plan['host_path'].exists())
        self.assertFalse(plan['skill_path'].is_symlink())

    def test_rollback_restores_exact_bytes_modes_and_absent_files(self):
        self.config.chmod(0o640)
        plan = self.plan()
        backup = setup.install(plan)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(backup.parent.stat().st_mode & 0o777, 0o700)
        self.assertFalse(setup.rollback(backup)['restored'])
        self.assertNotEqual(self.config.read_text(), self.original)
        setup.rollback(backup, apply=True)
        self.assertEqual(self.config.read_text(), self.original)
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o640)
        self.assertFalse(plan['host_path'].exists())
        self.assertFalse(plan['skill_path'].is_symlink())

    def test_rollback_preserves_a_later_user_change(self):
        backup = setup.install(self.plan())
        self.config.write_text(self.config.read_text() + '\n# later edit\n')
        with self.assertRaisesRegex(ValueError, 'changed after install'):
            setup.rollback(backup, apply=True)
        self.assertIn('# later edit', self.config.read_text())

    def test_failed_install_rolls_back_prior_targets(self):
        plan = self.plan()
        original_restore = setup.restore_snapshot
        def fail_config(path, value):
            if path == str(self.config) and value == plan['updates'][1]['after']:
                raise OSError('simulated disk error')
            original_restore(path, value)
        with patch.object(setup, 'restore_snapshot', side_effect=fail_config):
            with self.assertRaisesRegex(OSError, 'simulated disk error'):
                setup.install(plan)
        self.assertFalse(plan['host_path'].exists())
        self.assertEqual(self.config.read_text(), self.original)

    def test_claude_profile_preserves_codex_and_unrelated_claude_settings(self):
        definition = json.loads((self.root / 'profiles/claude.json').read_text())
        (self.root / 'extension/manifest.json').write_text(json.dumps({'key': definition['extensionKey']}))
        skill = self.root / 'skill/vids-director/SKILL.md'
        skill.parent.mkdir(); skill.write_text('Claude wrapper')
        claude_dir, config = self.base / 'claude', self.base / 'claude.json'
        original = {'theme': 'dark', 'mcpServers': {'other': {'command': 'other'}}}
        config.write_text(json.dumps(original))
        plan = setup.prepare(self.root, self.codex, self.chrome, '/usr/bin/python3',
                             profile='claude', claude_dir=claude_dir, claude_config=config)
        self.assertEqual(self.config.read_text(), self.original)
        self.assertEqual(json.loads(config.read_text()), original)  # Dry-run writes nothing.
        backup = setup.install(plan)
        parsed = json.loads(config.read_text())
        self.assertEqual(parsed['theme'], 'dark')
        self.assertEqual(parsed['mcpServers']['other'], original['mcpServers']['other'])
        self.assertEqual(parsed['mcpServers']['vids-claude']['args'], [str(self.root / 'server/index.mjs')])
        self.assertEqual(plan['host']['name'], 'com.vids_studio.claude_bridge')
        self.assertTrue((claude_dir / 'skills/vids-director').is_symlink())
        self.assertEqual(self.config.read_text(), self.original)
        again = setup.prepare(self.root, self.codex, self.chrome, '/usr/bin/python3', profile='claude', claude_dir=claude_dir, claude_config=config)
        self.assertIsNone(setup.install(again))
        setup.rollback(backup, apply=True)
        self.assertEqual(json.loads(config.read_text()), original)

    def test_profile_identity_collision_refused_before_any_write(self):
        skill = self.root / 'skill/vids-director/SKILL.md'
        skill.parent.mkdir(); skill.write_text('Claude wrapper')
        with self.assertRaisesRegex(ValueError, 'identity'):
            setup.prepare(self.root, self.codex, self.chrome, '/usr/bin/python3', profile='claude')


class PlatformInstallerTests(unittest.TestCase):
    setUp = InstallerTests.setUp

    def plan(self):
        return setup.prepare(self.root, self.codex, self.chrome, sys.executable)

    def windows(self):
        """Model registry races locally; platform_smoke exercises real Windows."""
        stack = ExitStack()
        state = {}
        stack.enter_context(patch.object(setup.sys, 'platform', 'win32'))
        private = Mock(spec=['secure_open', 'ensure_private_directory', 'assert_private_file'])
        private.ensure_private_directory.side_effect = lambda path: Path(path).mkdir(parents=True, exist_ok=True)
        private.secure_open.side_effect = lambda path, flags: os.open(path, flags, 0o600)
        stack.enter_context(patch.object(setup, 'security', return_value=private))
        def read(key, view=32):
            return copy.deepcopy(state.get((key, view), {'kind': 'absent'}))
        def write(key, value, view=32):
            if value['kind'] == 'absent':
                state.pop((key, view), None)
            else:
                state[(key, view)] = copy.deepcopy(value)
        stack.enter_context(patch.object(setup, 'registry_snapshot', side_effect=read))
        stack.enter_context(patch.object(setup, 'restore_registry', side_effect=write))
        return stack, state

    def test_platform_chrome_directories(self):
        with patch.object(setup.Path, 'home', return_value=self.base):
            with patch.object(setup.sys, 'platform', 'darwin'):
                self.assertEqual(setup.default_chrome_directory(), self.base / 'Library/Application Support/Google/Chrome')
            with patch.object(setup.sys, 'platform', 'linux'):
                self.assertEqual(setup.default_chrome_directory(), self.base / '.config/google-chrome')
            with patch.object(setup.sys, 'platform', 'win32'), patch.dict(os.environ, {'LOCALAPPDATA': str(self.base / 'Local')}):
                self.assertEqual(setup.default_chrome_directory(), self.base / 'Local/Google/Chrome/User Data')

    @unittest.skipIf(sys.platform == 'win32', 'Executes the POSIX launcher')
    def test_macos_launcher_uses_selected_python_and_preserves_arguments(self):
        renamed = self.root.with_name("package with spaces and 'quotes'")
        self.root.rename(renamed)
        self.root = renamed
        (self.root / 'native/bridge.py').write_text('import json, sys\nprint(json.dumps(sys.argv[1:]))\n')
        with patch.object(setup.sys, 'platform', 'darwin'):
            plan = self.plan()
            self.assertFalse(self.chrome.exists())
            self.assertFalse((self.root / '.runtime').exists())
            self.assertEqual(tomllib.loads(plan['new_config'])['mcp_servers']['google-vids']['env'],
                             {'VIDS_STUDIO_PYTHON': str(Path(sys.executable).resolve())})
            backup = setup.install(plan)
            launcher = Path(plan['host']['path'])
            self.assertEqual(launcher.stat().st_mode & 0o777, 0o700)
            result = subprocess.run([str(launcher), 'one argument', '"quoted"'], check=True, text=True, capture_output=True)
            self.assertEqual(json.loads(result.stdout), ['one argument', '"quoted"'])
            self.assertIsNone(setup.install(self.plan()))
            setup.rollback(backup, apply=True)
            self.assertFalse(launcher.exists())
            self.assertEqual(self.config.read_text(), self.original)

    def test_windows_dry_run_then_copy_registry_and_exact_rollback(self):
        stack, state = self.windows()
        with stack:
            plan = self.plan()
            self.assertFalse(self.chrome.exists())
            self.assertFalse(state)
            self.assertEqual(self.config.read_text(), self.original)
            self.assertEqual(plan['updates'][-1]['registryView'], 32)
            backup = setup.install(plan)
            self.assertTrue(plan['skill_path'].is_dir())
            self.assertFalse(plan['skill_path'].is_symlink())
            self.assertTrue((plan['skill_path'] / setup.SKILL_MARKER).is_file())
            self.assertEqual((plan['skill_path'] / 'SKILL.md').read_bytes(), (plan['skill_source'] / 'SKILL.md').read_bytes())
            self.assertEqual(len(state), 1)
            self.assertIn(b'setlocal DisableDelayedExpansion\r\n', Path(plan['host']['path']).read_bytes())
            self.assertIsNone(setup.install(self.plan()))
            setup.rollback(backup, apply=True)
            self.assertFalse(state)
            self.assertFalse(plan['skill_path'].exists())
            self.assertFalse(Path(plan['host']['path']).exists())
            self.assertEqual(self.config.read_text(), self.original)

    def test_windows_checks_both_registry_views_before_any_write(self):
        stack, state = self.windows()
        with stack:
            key = setup.REGISTRY_ROOT + '\\' + setup.HOST_NAME
            state[(key, 64)] = {'kind': 'registry', 'values': [['', 'another-host.json', 1]], 'children': []}
            with self.assertRaisesRegex(ValueError, 'different Windows native host'):
                self.plan()
            self.assertFalse(self.chrome.exists())
            self.assertEqual(self.config.read_text(), self.original)

    def test_windows_preserves_subsequent_skill_and_registry_edits(self):
        stack, state = self.windows()
        with stack:
            plan = self.plan()
            backup = setup.install(plan)
            skill = plan['skill_path'] / 'SKILL.md'
            original = skill.read_bytes()
            skill.write_text('later user edit')
            with self.assertRaisesRegex(ValueError, 'changed after install'):
                setup.rollback(backup, apply=True)
            with self.assertRaisesRegex(ValueError, 'Managed skill changed'):
                self.plan()
            self.assertEqual(skill.read_text(), 'later user edit')
            skill.write_bytes(original)
            key = next(iter(state))
            state[key]['values'].append(['user-setting', 'keep', 1])
            with self.assertRaisesRegex(ValueError, 'changed after install'):
                setup.rollback(backup, apply=True)
            self.assertTrue(plan['host_path'].exists())

    def test_windows_registry_failure_rolls_back_files(self):
        stack, state = self.windows()
        with stack:
            plan = self.plan()
            with patch.object(setup, 'restore_registry', side_effect=PermissionError('registry denied')):
                with self.assertRaisesRegex(PermissionError, 'registry denied'):
                    setup.install(plan)
            self.assertFalse(state)
            self.assertFalse(plan['host_path'].exists())
            self.assertFalse(plan['skill_path'].exists())
            self.assertFalse(Path(plan['host']['path']).exists())
            self.assertEqual(self.config.read_text(), self.original)

    def test_windows_updates_unchanged_managed_skill_and_can_restore_it(self):
        stack, state = self.windows()
        with stack:
            first = self.plan()
            setup.install(first)
            old = (first['skill_path'] / 'SKILL.md').read_bytes()
            (first['skill_source'] / 'SKILL.md').write_text('updated skill')
            second = self.plan()
            backup = setup.install(second)
            self.assertEqual((first['skill_path'] / 'SKILL.md').read_text(), 'updated skill')
            setup.rollback(backup, apply=True)
            self.assertEqual((first['skill_path'] / 'SKILL.md').read_bytes(), old)


if __name__ == '__main__':
    unittest.main()
