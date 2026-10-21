#!/usr/bin/env python3
"""Build portable, deterministic source/Codex/Claude ZIPs using an allowlist."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import zipfile

import build_profiles as profiles

ROOT = Path(__file__).resolve().parents[1]


def validate_profile(files, profile):
    definition = json.loads(files['profile.json'][0])
    skill = definition['skillName']
    required = ('package.json', 'bun.lock', 'server/index.mjs', 'native/bridge.py',
                'extension/manifest.json', 'extension/profile.js', 'scripts/setup.py',
                'scripts/build_profiles.py', f'skill/{skill}/SKILL.md',
                f'skill/{skill}/references/workflow.md', f'skill/{skill}/scripts/take_manifest.py')
    missing = [name for name in required if name not in files]
    if missing:
        raise ValueError(f'Incomplete {profile} package: {", ".join(missing)}')
    if not files['native/bridge.py'][1] & 0o111:
        raise ValueError('Native host source is not executable; restore its executable bit')
    if definition['id'] != profile:
        raise ValueError(f'Incorrect packaged profile: {profile}')
    manifest = json.loads(files['extension/manifest.json'][0])
    if manifest['key'] != definition['extensionKey'] or manifest['version'] != definition['version']:
        raise ValueError(f'Extension identity/version does not match {profile}')
    provenance = json.loads(files['build-manifest.json'][0])
    if Path(provenance['canonicalSource']).is_absolute():
        raise ValueError('Release provenance must not contain the build machine path')
    for name, digest in provenance['files'].items():
        if name not in files or hashlib.sha256(files[name][0]).hexdigest() != digest:
            raise ValueError(f'Generated package hash mismatch: {name}')
    return definition


def archive_bytes(prefix, files):
    stream = io.BytesIO()
    # ZIP_STORED avoids timestamps and platform-specific compressor differences.
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, (content, mode) in sorted(files.items()):
            relative = Path(name)
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError(f'Unsafe archive path: {name}')
            info = zipfile.ZipInfo(f'{prefix}/{name}', date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if mode & 0o111 else 0o644)) << 16
            archive.writestr(info, content)
    return stream.getvalue()


def artifacts(source):
    source = profiles.canonical_root(source)
    package = json.loads(profiles.checked_path(source, 'package.json').read_text(encoding='utf-8'))
    version = package['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', version):
        raise ValueError('Package version is not safe for release filenames')
    source_metadata = profiles.public_files(source, source_metadata=True)
    output, metadata = {}, {}
    # Plans read/validate sources without writing a materialized checkout.
    with tempfile.TemporaryDirectory(prefix='vids-release-plan-') as temporary:
        plans = {profile: profiles.materialization(source, Path(temporary) / profile, profile)
                 for profile in ('codex', 'claude')}
        core_ids = {plan['coreBuildId'] for plan in plans.values()}
        if len(core_ids) != 1:
            raise ValueError('Profiles do not share a single core build')
        for kind in ('source', 'codex', 'claude'):
            selected = plans['codex' if kind == 'source' else kind]
            files = dict(selected['files'])
            if kind == 'source':
                # Canonical checkout contracts and CI describe development, not
                # an installed profile. Keep them only in the complete source.
                files.update(source_metadata)
                # Complete source is able to build either client from scratch.
                for skill in ('google-vids', 'vids-director'):
                    for name, value in profiles.skill_files(source, skill).items():
                        files[f'skill/{skill}/{name}'] = value
            definition = validate_profile(files, 'codex' if kind == 'source' else kind)
            prefix = f'vids-studio-{version}-{kind}'
            filename = f'{prefix}.zip'
            output[filename] = archive_bytes(prefix, files)
            metadata[kind] = {'filename': filename, 'sha256': hashlib.sha256(output[filename]).hexdigest(),
                              'fileCount': len(files), 'profile': definition['id'] if kind != 'source' else None}
    manifest = {'schemaVersion': 1, 'version': version, 'coreBuildId': next(iter(core_ids)),
                'dependenciesIncluded': False, 'runtimeDataIncluded': False, 'artifacts': metadata}
    output['release-manifest.json'] = profiles.serialized(manifest).encode()
    output['SHA256SUMS'] = ''.join(f'{hashlib.sha256(content).hexdigest()}  {name}\n'
                                   for name, content in sorted(output.items())).encode()
    return output, manifest


def write_artifacts(output, files):
    output = Path(output).absolute()
    profiles.checked_path(Path(output.anchor), output.relative_to(output.anchor))
    output.mkdir(parents=True, exist_ok=True)
    temporary = []
    try:
        for name, content in files.items():
            target = profiles.checked_path(output, name)
            if target.exists() and not target.is_file():
                raise ValueError(f'Release destination must be a regular file: {target}')
            fd, path = tempfile.mkstemp(prefix='.vids-release-', dir=output)
            with os.fdopen(fd, 'wb') as stream:
                if os.name != 'nt':
                    os.fchmod(stream.fileno(), 0o644)
                stream.write(content)
            temporary.append((Path(path), target))
        for path, target in temporary:
            profiles.checked_path(output, target.name)
            os.replace(path, target)
    finally:
        for path, _ in temporary:
            path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        files, manifest = artifacts(args.source)
        write_artifacts(args.output, files)
        print(profiles.serialized(manifest), end='')
        return 0
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as exc:
        print(f'Release refused: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
