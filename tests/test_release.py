"""Release tests use isolated sources, archives and user config directories."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys
import unittest
import zipfile

import test_profiles
import test_setup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
try:
    import build_release as release
finally:
    sys.path.pop(0)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        test_profiles.ProfileBuildTests.setUp(self)
        for name, content in {
            'bun.lock': '{}\n',
            'skill/google-vids/scripts/take_manifest.py': '# manifest helper\n',
            'README.md': '# Vids Studio\n',
            'README.ru.md': '# Vids Studio — русский\n',
            'docs/en/install.md': 'English install',
            'docs/ru/install.md': 'Установка',
            'docs/assets/hero.svg': '<svg/>',
            'docs/assets/workflow.svg': '<svg/>',
            'docs/assets/extension-popup.en.png': 'Public English popup fixture',
            'docs/assets/extension-popup.ru.png': 'Public Russian popup fixture',
            '.github/workflows/ci.yml': 'name: Test\n',
            'AGENTS.md': 'Canonical source contract',
            'CLAUDE.md': 'Canonical Claude development guidance',
        }.items():
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        for name in ('setup.py', 'build_profiles.py', 'build_release.py'):
            target = self.source / 'scripts' / name
            target.parent.mkdir(exist_ok=True)
            shutil.copy2(ROOT / 'scripts' / name, target)
        (self.source / 'native/bridge.py').chmod(0o755)

    def unzip(self, payload, destination):
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            archive.extractall(destination)
            for info in archive.infolist():
                (destination / info.filename).chmod(info.external_attr >> 16 & 0o777)
            return destination / archive.namelist()[0].split('/')[0]

    def test_archives_are_byte_reproducible_after_source_relocation(self):
        first, manifest = release.artifacts(self.source)
        relocated = self.base / 'relocated'
        shutil.copytree(self.source, relocated)
        second, _ = release.artifacts(relocated)
        self.assertEqual(first, second)
        self.assertEqual(set(manifest['artifacts']), {'source', 'codex', 'claude'})
        for line in first['SHA256SUMS'].decode().splitlines():
            digest, name = line.split('  ')
            self.assertEqual(hashlib.sha256(first[name]).hexdigest(), digest)

    def test_both_fresh_bundles_support_installer_with_isolated_configuration(self):
        files, _ = release.artifacts(self.source)
        for profile in ('codex', 'claude'):
            with self.subTest(profile=profile):
                root = self.unzip(files[f'vids-studio-0.2.0-{profile}.zip'], self.base / 'unpacked')
                dependency = root / 'node_modules/@modelcontextprotocol/sdk/package.json'
                dependency.parent.mkdir(parents=True)
                dependency.write_text('{}')
                home = self.base / f'home-{profile}'
                plan = test_setup.setup.prepare(root, home / 'codex', home / 'chrome', '/usr/bin/python3',
                    profile=profile, claude_dir=home / 'claude', claude_config=home / 'claude.json')
                self.assertEqual(plan['profile']['id'], profile)
                self.assertEqual(plan['skill_source'].name, self.definitions[profile]['skillName'])
                self.assertFalse(home.exists(), 'installer dry-run must not create config')
                backup = test_setup.setup.install(plan)
                self.assertTrue(plan['skill_path'].is_symlink())
                self.assertEqual(json.loads(plan['host_path'].read_text())['path'], str(root / 'native/bridge.py'))
                test_setup.setup.rollback(backup, apply=True)
                self.assertFalse(plan['host_path'].exists())

    def test_source_archive_can_build_a_complete_claude_target(self):
        files, _ = release.artifacts(self.source)
        source = self.unzip(files['vids-studio-0.2.0-source.zip'], self.base / 'source-extract')
        plan = release.profiles.materialization(source, self.base / 'fresh-claude', 'claude')
        release.profiles.write(plan)
        self.assertTrue((plan['target'] / 'skill/vids-director/SKILL.md').is_file())
        self.assertTrue((plan['target'] / 'skill/vids-director/assets/layers.html').is_file())
        self.assertEqual((plan['target'] / 'skill/vids-director/references/workflow.md').read_text(), 'Shared creative workflow')

    def test_profiles_and_source_share_public_docs_but_only_source_has_canonical_contracts(self):
        files, _ = release.artifacts(self.source)
        for kind in ('source', 'codex', 'claude'):
            with zipfile.ZipFile(io.BytesIO(files[f'vids-studio-0.2.0-{kind}.zip'])) as archive:
                names = {'/'.join(name.split('/')[1:]) for name in archive.namelist()}
                for name in ('README.md', 'README.ru.md', 'docs/en/install.md', 'docs/ru/install.md',
                             'docs/assets/hero.svg', 'docs/assets/workflow.svg',
                             'docs/assets/extension-popup.en.png', 'docs/assets/extension-popup.ru.png'):
                    self.assertIn(name, names)
                for name in ('AGENTS.md', 'CLAUDE.md', '.github/workflows/ci.yml'):
                    self.assertEqual(name in names, kind == 'source')

    def test_allowlist_excludes_dependencies_secrets_runtime_and_unreviewed_notes(self):
        excluded = ('node_modules/private.json', '.env', '.runtime/jobs.sqlite', 'private.mp4',
                    'server/.env', 'server/private.log', 'docs/private-notes.md', 'docs/assets/private-screenshot.png',
                    'skill/vids-director/.env', 'skill/vids-director/assets/export.mp4',
                    'scripts/private-script.py', '.github/workflows/.env')
        for name in excluded:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('DO-NOT-PUBLISH-PRIVATE-DATA')
        files, _ = release.artifacts(self.source)
        for name, content in files.items():
            self.assertNotIn(b'DO-NOT-PUBLISH-PRIVATE-DATA', content, name)
        with zipfile.ZipFile(io.BytesIO(files['vids-studio-0.2.0-source.zip'])) as archive:
            members = archive.namelist()
            self.assertTrue(any(name.endswith('/docs/en/install.md') for name in members))
            self.assertTrue(any(name.endswith('/.github/workflows/ci.yml') for name in members))

    def test_symlink_in_public_input_is_rejected(self):
        target = self.source / 'docs/en/install.md'
        target.unlink()
        secret = self.base / 'private.md'
        secret.write_text('private')
        target.symlink_to(secret)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            release.artifacts(self.source)

    def test_profile_validation_rejects_tampered_payload(self):
        plan = release.profiles.materialization(self.source, self.base / 'target', 'claude')
        files = dict(plan['files'])
        files['server/index.mjs'] = (b'// altered after build', 0o644)
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            release.validate_profile(files, 'claude')

    def test_archive_paths_modes_and_timestamps_are_portable(self):
        payload = release.archive_bytes('portable', {'native/bridge.py': (b'host', 0o775), 'README.md': (b'doc', 0o664)})
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for info in archive.infolist():
                self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(info.external_attr >> 16 & 0o777, 0o755 if info.filename.endswith('.py') else 0o644)
        with self.assertRaisesRegex(ValueError, 'Unsafe archive path'):
            release.archive_bytes('portable', {'../outside': (b'x', 0o644)})

    def test_release_outputs_are_repeatable_and_do_not_follow_links(self):
        files, _ = release.artifacts(self.source)
        output = self.base / 'release'
        release.write_artifacts(output, files)
        release.write_artifacts(output, files)
        self.assertEqual({path.name: path.read_bytes() for path in output.iterdir()}, files)
        target = output / 'SHA256SUMS'
        target.unlink()
        unrelated = self.base / 'unrelated.txt'
        unrelated.write_text('keep')
        target.symlink_to(unrelated)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            release.write_artifacts(output, files)
        self.assertEqual(unrelated.read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
