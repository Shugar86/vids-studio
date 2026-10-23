"""Profile builds preserve existing identities and detect generated-code drift."""
import importlib.util
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('vids_build', ROOT / 'scripts/build_profiles.py')
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class ProfileBuildTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.source = self.base / 'canonical'
        self.source.mkdir()
        definitions = {name: json.loads((ROOT / 'profiles' / f'{name}.json').read_text()) for name in ('codex', 'claude')}
        self.definitions = definitions
        contents = {
            'package.json': json.dumps({'name': 'vids-studio-mcp', 'version': '0.2.0'}),
            'extension/manifest.json': json.dumps({'key': definitions['codex']['extensionKey'], 'permissions': ['debugger'], 'action': {}}),
            'extension/popup.html': '<title>Vids Studio</title>Codex сможет',
            'extension/driver.js': 'export const driver = true;\n',
            'native/bridge.py': '# fixture\n', 'server/index.mjs': '// fixture\n',
            'skill/google-vids/SKILL.md': 'Codex wrapper',
            'skill/google-vids/agents/openai.yaml': 'display_name: Vids Studio',
            'skill/google-vids/references/workflow.md': 'Shared creative workflow',
            'skill/google-vids/scripts/review.py': '# shared helper\n',
            'skill/google-vids/assets/shared.html': '<p>Shared layer preview</p>',
            'skill/vids-director/SKILL.md': 'Claude wrapper',
            'skill/vids-director/references/vids-operations.md': 'Claude operations',
            'skill/vids-director/references/workflow.md': 'Outdated duplicate',
            'skill/vids-director/assets/layers.html': '<p>Layer preview</p>',
            'skill/vids-director/scripts/qa_export.py': '# Claude helper\n',
            'skill/vids-director/tests/test_qa_export.py': '# Claude check\n',
        }
        for name, value in definitions.items():
            contents[f'profiles/{name}.json'] = json.dumps(value)
        for name, content in contents.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)

    def plan(self, profile='claude'):
        return build.materialization(self.source, self.base / profile, profile)

    def test_dry_run_then_reproducible_profiles_share_core_and_keep_distinct_identities(self):
        claude = self.plan()
        self.assertFalse(claude['target'].exists())
        build.write(claude)
        codex = self.plan('codex'); build.write(codex)
        profiles = [json.loads((p['target'] / 'profile.json').read_text()) for p in (codex, claude)]
        self.assertEqual(profiles[0]['coreBuildId'], profiles[1]['coreBuildId'])
        self.assertNotEqual(profiles[0]['nativeHostName'], profiles[1]['nativeHostName'])
        self.assertNotEqual(profiles[0]['socketNamespace'], profiles[1]['socketNamespace'])
        for profile, plan in zip(('codex', 'claude'), (codex, claude)):
            manifest = json.loads((plan['target'] / 'extension/manifest.json').read_text())
            self.assertEqual(manifest['key'], self.definitions[profile]['extensionKey'])
            self.assertIn('storage', manifest['permissions'])
            self.assertEqual(build.materialization(self.source, plan['target'], profile)['changes'], [])

    def test_profile_cannot_replace_another_extension(self):
        plan = self.plan('codex'); build.write(plan)
        with self.assertRaisesRegex(ValueError, 'identity'):
            build.materialization(self.source, plan['target'], 'claude')

    def test_materialized_claude_cannot_become_canonical_source(self):
        plan = self.plan(); build.write(plan)
        with self.assertRaisesRegex(ValueError, 'Canonical sources'):
            build.materialization(plan['target'], plan['target'], 'claude')

    def test_generated_drift_is_visible_and_reviewable(self):
        plan = self.plan(); build.write(plan)
        driver = plan['target'] / 'extension/driver.js'
        driver.write_text('// accidental local edit\n')
        checked = self.plan()
        self.assertIn('extension/driver.js', checked['changes'])
        self.assertEqual(driver.read_text(), '// accidental local edit\n')

    def test_concurrent_target_change_is_preserved(self):
        plan = self.plan(); build.write(plan)
        (self.source / 'extension/driver.js').write_text('// new canonical code\n')
        updated = self.plan()
        target = plan['target'] / 'extension/driver.js'
        target.write_text('// concurrent change\n')
        with self.assertRaisesRegex(ValueError, 'changed during build'):
            build.write(updated)
        self.assertEqual(target.read_text(), '// concurrent change\n')

    def test_fresh_claude_contains_wrapper_helpers_assets_tests_and_canonical_corpus(self):
        plan = self.plan(); build.write(plan)
        skill = plan['target'] / 'skill/vids-director'
        self.assertEqual((skill / 'SKILL.md').read_text(), 'Claude wrapper')
        self.assertEqual((skill / 'references/workflow.md').read_text(), 'Shared creative workflow')
        for name in ('assets/layers.html', 'assets/shared.html', 'scripts/qa_export.py', 'tests/test_qa_export.py'):
            self.assertTrue((skill / name).is_file(), name)

    def test_both_profiles_receive_shared_helpers_and_assets_with_their_own_wrapper(self):
        for profile, name in (('codex', 'google-vids'), ('claude', 'vids-director')):
            plan = self.plan(profile); build.write(plan)
            skill = plan['target'] / 'skill' / name
            self.assertEqual((skill / 'scripts/review.py').read_text(), '# shared helper\n')
            self.assertEqual((skill / 'assets/shared.html').read_text(), '<p>Shared layer preview</p>')
            self.assertEqual((skill / 'SKILL.md').read_text(), profile.capitalize() + ' wrapper')

    def test_shared_skill_corpus_updates_wrapper_and_preserves_unmanaged_client_files(self):
        plan = self.plan(); build.write(plan)
        skill = plan['target'] / 'skill/vids-director'
        (skill / 'scripts/claude-only.py').write_text('# keep\n')
        (self.source / 'skill/google-vids/references/workflow.md').write_text('Updated shared direction')
        (self.source / 'skill/vids-director/SKILL.md').write_text('Updated Claude wrapper')
        build.write(self.plan())
        self.assertEqual((skill / 'references/workflow.md').read_text(), 'Updated shared direction')
        self.assertEqual((skill / 'SKILL.md').read_text(), 'Updated Claude wrapper')
        self.assertEqual((skill / 'references/vids-operations.md').read_text(), 'Claude operations')
        self.assertTrue((skill / 'scripts/claude-only.py').exists())

    def test_provenance_and_profile_bytes_do_not_depend_on_source_location(self):
        first = self.plan()
        relocated = self.base / 'another-source'
        shutil.copytree(self.source, relocated)
        second = build.materialization(relocated, self.base / 'other-target', 'claude')
        self.assertEqual(first['files'], second['files'])
        provenance = json.loads(first['files']['build-manifest.json'][0])
        self.assertEqual(provenance['canonicalSource'], '.')
        self.assertNotIn(str(self.base), json.dumps(provenance))

    def test_distribution_modes_do_not_depend_on_group_write_umask(self):
        (self.source / 'native/bridge.py').chmod(0o775)
        (self.source / 'skill/vids-director/SKILL.md').chmod(0o664)
        plan = self.plan()
        self.assertEqual(plan['files']['native/bridge.py'][1], 0o755)
        self.assertEqual(plan['files']['skill/vids-director/SKILL.md'][1], 0o644)

    def test_missing_named_wrapper_is_rejected_before_materialization(self):
        (self.source / 'skill/vids-director/SKILL.md').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing client skill wrapper'):
            self.plan()

    def test_failed_materialization_restores_every_applied_file(self):
        plan = self.plan(); build.write(plan)
        target = plan['target']
        before = {p.relative_to(target): (p.read_bytes(), p.stat().st_mode) for p in target.rglob('*') if p.is_file()}
        (self.source / 'extension/driver.js').write_text('// new code\n')
        updated = self.plan()
        original_replace, calls = build.os.replace, []
        def replace(source, destination):
            calls.append(destination)
            if len(calls) == 3:
                raise OSError('simulated replacement failure')
            return original_replace(source, destination)
        with patch.object(build.os, 'replace', side_effect=replace):
            with self.assertRaisesRegex(OSError, 'simulated replacement failure'):
                build.write(updated)
        after = {p.relative_to(target): (p.read_bytes(), p.stat().st_mode) for p in target.rglob('*') if p.is_file()}
        self.assertEqual(after, before)

    def test_local_runtime_and_unrelated_setup_files_are_not_materialized(self):
        for name in ('server/.env', 'server/session.log', 'scripts/one-off.py'):
            path = self.source / name
            path.parent.mkdir(exist_ok=True)
            path.write_text('private local material')
        plan = self.plan()
        for name in ('server/.env', 'server/session.log', 'scripts/one-off.py'):
            self.assertNotIn(name, plan['files'])

    def test_named_release_docs_and_live_smoke_are_materialized_without_client_contract(self):
        managed = ('docs/jobs.md', 'docs/runtime-safety.md', 'scripts/live_smoke.mjs')
        for name in (*managed, 'CLAUDE.md', 'docs/private-notes.md', 'scripts/one-off.mjs'):
            path = self.source / name
            path.parent.mkdir(exist_ok=True)
            path.write_text('fixture')
        files = self.plan()['files']
        for name in managed:
            self.assertIn(name, files)
        for name in ('CLAUDE.md', 'docs/private-notes.md', 'scripts/one-off.mjs'):
            self.assertNotIn(name, files)

    def test_fresh_profile_contains_complete_public_guide_links_and_no_source_contracts(self):
        guides = {
            'README.md': '[Install](docs/en/installation.md) · [Русский](README.ru.md)',
            'README.ru.md': '[Установка](docs/ru/installation.md)',
            'docs/en/installation.md': '[Русский](../ru/installation.md) · [Home](../../README.md)',
            'docs/ru/installation.md': '[English](../en/installation.md) · [Главная](../../README.ru.md)',
            'docs/profile-install.md': '[English](en/installation.md) · [Русский](ru/installation.md)',
            'docs/assets/hero.svg': '<svg/>', 'SECURITY.md': 'Security policy',
            'AGENTS.md': 'Canonical source contract', 'CLAUDE.md': 'Canonical Claude guidance',
            '.github/workflows/ci.yml': 'Source CI',
        }
        for name, content in guides.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        for profile in ('codex', 'claude'):
            plan = self.plan(profile); build.write(plan)
            for name in guides:
                if name in ('AGENTS.md', 'CLAUDE.md') or name.startswith('.github/'):
                    self.assertNotIn(name, plan['files'])
                    continue
                path = plan['target'] / name
                self.assertTrue(path.is_file(), name)
                if path.suffix == '.md':
                    for link in re.findall(r'\]\(([^)]+)\)', path.read_text()):
                        self.assertTrue((path.parent / link).is_file(), f'{name} -> {link}')

    def test_directory_symlinks_cannot_redirect_source_or_target(self):
        outside = self.base / 'unrelated'
        outside.mkdir()
        private = outside / 'index.mjs'
        private.write_text('// unrelated code')
        plan = self.plan(); build.write(plan)
        shutil.rmtree(plan['target'] / 'server')
        (plan['target'] / 'server').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.plan()
        self.assertEqual(private.read_text(), '// unrelated code')
        shutil.rmtree(self.source / 'server')
        (self.source / 'server').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.plan('codex')

    def test_directory_symlink_created_after_plan_is_rejected_before_writes(self):
        plan = self.plan(); build.write(plan)
        (self.source / 'server/index.mjs').write_text('// new canonical code')
        pending = self.plan()
        outside = self.base / 'external'
        outside.mkdir()
        private = outside / 'index.mjs'
        private.write_text('// user material')
        shutil.rmtree(plan['target'] / 'server')
        (plan['target'] / 'server').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            build.write(pending)
        self.assertEqual(private.read_text(), '// user material')


if __name__ == '__main__':
    unittest.main()
