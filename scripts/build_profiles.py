#!/usr/bin/env python3
"""Materialize one named profile from canonical sources; dry-run unless --write."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DIRECTORIES = ('native', 'server', 'extension', 'scripts', 'tests', 'profiles')
GENERATED = {'profile.json', 'build-manifest.json', 'extension/profile.js'}
SOURCE_SUFFIXES = {'native': {'.py'}, 'server': {'.mjs'}, 'extension': {'.js', '.mjs', '.json', '.html', '.css'},
                   'scripts': {'.py', '.mjs'}, 'tests': {'.py', '.mjs'}, 'profiles': {'.json'}}
SKILL_DIRECTORIES = {'references': {'.md'}, 'scripts': {'.py', '.mjs'},
                     'tests': {'.py', '.mjs'}, 'agents': {'.yaml', '.yml'},
                     'assets': {'.html', '.css', '.svg', '.png', '.jpg', '.webp', '.json'}}
PUBLIC_ROOT_FILES = ('README.md', 'README.ru.md', 'LICENSE', 'LICENSE.md',
                     'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
                     '.gitignore', '.gitattributes', '.editorconfig')
PUBLIC_DOC_FILES = ('docs/profile-install.md', 'docs/jobs.md', 'docs/runtime-safety.md',
                    'docs/VERIFICATION.md', 'VERIFICATION.md', 'docs/assets/hero.svg',
                    'docs/assets/workflow.svg', 'docs/assets/extension-popup.en.png',
                    'docs/assets/extension-popup.ru.png',
                    'site/index.html', 'site/ru/index.html', 'site/style.css',
                    'site/assets/sasha-and-the-lamp.jpg',
                    'site/assets/sasha-and-the-lamp-v4.mp4',
                    'site/assets/sasha-and-the-lamp.en.vtt',
                    'site/assets/sasha-and-the-lamp-v5.mp4',
                    'site/assets/sasha-and-the-lamp-v5.jpg',
                    'site/assets/sasha-and-the-lamp-v5.en.vtt')
PUBLIC_DIRECTORIES = {'docs/en': {'.md'}, 'docs/ru': {'.md'}}
SOURCE_METADATA = ('AGENTS.md', 'CLAUDE.md')
SOURCE_DIRECTORIES = {'.github/workflows': {'.yml', '.yaml'},
                      '.github/ISSUE_TEMPLATE': {'.md', '.yml', '.yaml'}}


def serialized(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + '\n'


def source_mode(path):
    """Use Git/Unix distribution modes, independent of the builder's umask."""
    # Windows does not preserve Unix executable bits. These two entry points
    # are executable in every archive, regardless of the build host filesystem.
    return 0o755 if (path.parent.name, path.name) in {('native', 'bridge.py'), ('server', 'index.mjs')} else 0o644


def link_or_reparse(path):
    try:
        info = Path(path).lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def canonical_root(path):
    path = Path(path).absolute()
    if os.name == 'nt':
        # Resolve only after checking the original spelling; junctions otherwise
        # disappear into an apparently ordinary destination on another tree.
        checked_path(Path(path.anchor), path.relative_to(path.anchor))
    return path.resolve()


def checked_path(root, relative):
    """Reject links in any managed path, including directory ancestors."""
    current = root
    if link_or_reparse(current):
        raise ValueError(f'Refusing symlink or reparse point in managed root: {current}')
    parts = Path(relative).parts
    for index, part in enumerate(parts):
        current = current / part
        if link_or_reparse(current):
            raise ValueError(f'Refusing symlink or reparse point in managed path: {current}')
        if index < len(parts) - 1 and current.exists() and not current.is_dir():
            raise ValueError(f'Refusing nondirectory managed ancestor: {current}')
    return current


def profile_definition(source, profile):
    if profile not in ('codex', 'claude'):
        raise ValueError('Select codex or claude explicitly')
    value = json.loads(checked_path(source, f'profiles/{profile}.json').read_text(encoding='utf-8'))
    if value.get('schemaVersion') != 1 or value.get('id') != profile:
        raise ValueError('Invalid profile definition')
    return value


def public_files(source, *, source_metadata=False):
    """Share a complete public guide set across source and profile distributions."""
    files = {}
    names = list(PUBLIC_ROOT_FILES + PUBLIC_DOC_FILES)
    directories = dict(PUBLIC_DIRECTORIES)
    if source_metadata:
        names.extend(SOURCE_METADATA)
        directories.update(SOURCE_DIRECTORIES)
    for directory, suffixes in directories.items():
        for path in sorted(checked_path(source, directory).rglob('*')):
            relative = path.relative_to(source)
            # .github itself is an explicit source root; nested hidden files are not.
            if any(part.startswith('.') for part in relative.parts[1:]):
                continue
            checked_path(source, relative)
            if path.is_file() and path.suffix in suffixes:
                names.append(relative.as_posix())
    for name in names:
        path = checked_path(source, name)
        if path.exists():
            if not path.is_file():
                raise ValueError(f'Public artifact input must be a regular file: {name}')
            files[name] = (path.read_bytes(), source_mode(path))
    return files


def source_files(source):
    files = {}
    for directory in DIRECTORIES:
        for path in sorted(checked_path(source, directory).rglob('*')):
            if '__pycache__' in path.parts or path.suffix not in SOURCE_SUFFIXES[directory] or not path.is_file():
                continue
            if any(part.startswith('.') for part in path.relative_to(source).parts):
                continue
            if directory == 'scripts' and path.name not in ('setup.py', 'build_profiles.py', 'build_release.py', 'live_smoke.mjs'):
                continue
            if directory == 'profiles' and path.name not in ('codex.json', 'claude.json'):
                continue
            relative = path.relative_to(source).as_posix()
            checked_path(source, relative)
            if relative not in GENERATED:
                files[relative] = (path.read_bytes(), source_mode(path))
    for name in ('package.json', 'bun.lock', 'requirements-windows.txt'):
        path = checked_path(source, name)
        if path.exists():
            if path.is_symlink() or not path.is_file():
                raise ValueError(f'Canonical source must be a regular file: {path}')
            files[name] = (path.read_bytes(), source_mode(path))
    return files


def skill_files(source, skill_name):
    """A release owns its named wrapper and client helpers; never copies runtime."""
    root = checked_path(source, f'skill/{skill_name}')
    wrapper = checked_path(root, 'SKILL.md')
    if not wrapper.is_file():
        raise ValueError(f'Missing client skill wrapper: skill/{skill_name}/SKILL.md')
    files = {'SKILL.md': (wrapper.read_bytes(), source_mode(wrapper))}
    for directory, suffixes in SKILL_DIRECTORIES.items():
        base = checked_path(root, directory)
        for path in sorted(base.rglob('*')):
            relative = path.relative_to(root)
            if any(part.startswith('.') or part == '__pycache__' for part in relative.parts):
                continue
            checked_path(root, relative)
            if path.is_file() and path.suffix in suffixes:
                files[relative.as_posix()] = (path.read_bytes(), source_mode(path))
    return files


def materialization(source, target, profile):
    source, target = canonical_root(source), canonical_root(target)
    source_identity = checked_path(source, 'profile.json')
    if source_identity.exists() and json.loads(source_identity.read_text(encoding='utf-8')).get('id') != 'codex':
        raise ValueError('Canonical sources must use the codex profile; pass --source with the canonical checkout')
    definition = profile_definition(source, profile)
    if target.exists():
        package = checked_path(target, 'package.json')
        if not package.is_file() or json.loads(package.read_text(encoding='utf-8')).get('name') != 'vids-studio-mcp':
            raise ValueError('Target is not an existing Vids Studio checkout')
        manifest = checked_path(target, 'extension/manifest.json')
        if manifest.exists() and json.loads(manifest.read_text(encoding='utf-8')).get('key') != definition['extensionKey']:
            raise ValueError('Target extension identity differs from the named profile; nothing changed')
        current = checked_path(target, 'profile.json')
        if current.exists() and json.loads(current.read_text(encoding='utf-8')).get('id') != profile:
            raise ValueError('Target already belongs to another profile')
    files = {**source_files(source), **public_files(source)}
    # Start from the complete selected client: fresh Claude installs must not
    # depend on files left over from a previous checkout. Shared creative files
    # have a single source and deliberately override matching wrapper copies.
    selected_skill = skill_files(source, definition['skillName'])
    for relative, value in skill_files(source, 'google-vids').items():
        if relative.startswith(('references/', 'scripts/', 'tests/')):
            selected_skill[relative] = value
    for relative, value in selected_skill.items():
        files[f'skill/{definition["skillName"]}/{relative}'] = value
    digest = hashlib.sha256()
    for name, (content, _) in sorted(files.items()):
        if name.startswith(('native/', 'server/', 'extension/')) and not name.endswith('.test.mjs'):
            if name == 'extension/manifest.json':
                common = json.loads(content)
                for field in ('key', 'name', 'description'):
                    common.pop(field, None)
                common.get('action', {}).pop('default_title', None)
                common['version'] = json.loads((source / 'package.json').read_text(encoding='utf-8'))['version']
                for permission in ('storage', 'downloads'):
                    if permission not in common['permissions']:
                        common['permissions'].append(permission)
                content = json.dumps(common, sort_keys=True).encode()
            digest.update(name.encode() + b'\0' + content + b'\0')
    build = digest.hexdigest()
    version = json.loads((source / 'package.json').read_text(encoding='utf-8'))['version']
    runtime = {**definition, 'version': version, 'buildId': build, 'coreBuildId': build,
               'protocol': 3, 'extensionProtocol': 2}
    files['profile.json'] = (serialized(runtime).encode(), 0o644)
    files['extension/profile.js'] = (('/* Generated by scripts/build_profiles.py; edit profiles/ instead. */\n'
        + 'export const PROFILE = Object.freeze(' + json.dumps(runtime, ensure_ascii=False, indent=2) + ');\n').encode(), 0o644)
    manifest = json.loads(files['extension/manifest.json'][0])
    manifest.update(name=definition['extensionName'], description=definition['extensionDescription'],
                    key=definition['extensionKey'], version=version)
    for permission in ('storage', 'downloads'):
        if permission not in manifest['permissions']:
            manifest['permissions'].append(permission)
    manifest['action']['default_title'] = definition['displayName']
    files['extension/manifest.json'] = (serialized(manifest).encode(), 0o644)
    # These are labels only. All behavior remains in canonical popup.js/driver.js.
    popup = files['extension/popup.html'][0].decode()
    codex = profile_definition(source, 'codex')
    popup = popup.replace(codex['displayName'], definition['displayName']).replace('Codex сможет', definition['clientName'] + ' сможет')
    if profile == 'claude':
        popup = popup.replace('Google Vids · локальный мост', 'Google Vids · мост Claude Code')
    files['extension/popup.html'] = (popup.encode(), 0o644)
    provenance = {'schemaVersion': 1, 'profile': profile, 'version': version, 'coreBuildId': build,
        # A logical source-root reference, not the builder's private filesystem.
        # A materialized Claude tree must receive --source explicitly to rebuild.
        'canonicalSource': '.', 'canonicalSourceScope': 'source-root-relative',
        'files': {name: hashlib.sha256(content).hexdigest() for name, (content, _) in sorted(files.items())}}
    files['build-manifest.json'] = (serialized(provenance).encode(), 0o644)
    changes, before = [], {}
    for name, (content, mode) in sorted(files.items()):
        path = checked_path(target, name)
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError(f'Refusing nonregular target: {path}')
        if not path.exists() or path.read_bytes() != content or (os.name != 'nt' and stat.S_IMODE(path.stat().st_mode) != mode):
            changes.append(name)
            before[name] = (path.read_bytes(), stat.S_IMODE(path.stat().st_mode)) if path.exists() else None
    return {'source': source, 'target': target, 'profile': profile, 'coreBuildId': build,
            'files': files, 'changes': changes, 'before': before}


def write(plan):
    # Prepare every file before replacing any, so invalid paths cannot cause a
    # partial update. Existing checkout files are never deleted by this builder.
    pending = []
    originals = plan['before']
    try:
        for name in plan['changes']:
            path = checked_path(plan['target'], name)
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix='.vids-build-', dir=path.parent)
            content, mode = plan['files'][name]
            with os.fdopen(fd, 'wb') as stream:
                if os.name != 'nt':
                    os.fchmod(stream.fileno(), mode)
                stream.write(content)
            pending.append((name, path, Path(temporary)))
        for name, path, _ in pending:
            checked_path(plan['target'], name)
            current = (path.read_bytes(), stat.S_IMODE(path.stat().st_mode)) if path.exists() and not path.is_symlink() else None
            if path.is_symlink() or current != originals[name]:
                raise ValueError(f'Target changed during build: {path}')
        applied = []
        try:
            for name, path, temporary in pending:
                checked_path(plan['target'], name)
                os.replace(temporary, path)
                applied.append(name)
        except BaseException:
            for name in reversed(applied):
                path = plan['target'] / name
                if originals[name] is None:
                    path.unlink()
                else:
                    content, mode = originals[name]
                    path.write_bytes(content)
                    path.chmod(mode)
            raise
    finally:
        for _, _, temporary in pending:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT)
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--profile', choices=('codex', 'claude'), required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--write', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        plan = materialization(args.source, args.target, args.profile)
        if args.write:
            write(plan)
        print(serialized({'profile': args.profile, 'source': str(plan['source']), 'target': str(plan['target']),
            'coreBuildId': plan['coreBuildId'], 'changedFiles': plan['changes'], 'written': args.write,
            'runtimeActivated': False, 'configChanged': False}), end='')
        return 1 if args.check and plan['changes'] else 0
    except (ValueError, OSError, KeyError) as exc:
        print(f'Build refused: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
