#!/usr/bin/env python3
"""List bounded local MP4 candidates; never infer export provenance or choose a file."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import stat
import unicodedata


def normalized(value):
    return unicodedata.normalize('NFC', value).casefold()


def default_directories():
    home = Path.home()
    result = [home / 'Downloads', home / 'Загрузки']
    config = Path(os.environ.get('XDG_CONFIG_HOME', home / '.config')) / 'user-dirs.dirs'
    if config.is_file() and config.stat().st_size <= 65536:
        match = re.search(r'^XDG_DOWNLOAD_DIR="([^"\n]+)"$', config.read_text(), re.M)
        if match:
            value = match[1].replace('$HOME', str(home))
            if '$' not in value and Path(value).is_absolute():
                result.insert(0, Path(value))
    return list(dict.fromkeys(result))


def discover(directories, name, since, limit=50, scan_limit=10000):
    result, scanned, truncated, missing = [], 0, False, []
    for directory in dict.fromkeys(Path(p).absolute() for p in directories):
        if directory.is_symlink() or not directory.is_dir():
            missing.append(str(directory)); continue
        with os.scandir(directory) as entries:
            for item in entries:
                scanned += 1
                if scanned > scan_limit:
                    truncated = True; break
                if not item.name.lower().endswith('.mp4') or normalized(name) not in normalized(item.name):
                    continue
                info = item.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_size == 0 or info.st_mtime < since:
                    continue
                if hasattr(os, 'getuid') and info.st_uid != os.getuid():
                    continue
                result.append({'path':str(directory / item.name), 'bytes':info.st_size,
                               'modifiedAt':dt.datetime.fromtimestamp(info.st_mtime, dt.timezone.utc).isoformat()})
        if truncated: break
    result.sort(key=lambda item:(item['modifiedAt'], item['path']), reverse=True)
    return {'candidates':result[:limit], 'truncated':truncated or len(result)>limit,
            'scanned':min(scanned,scan_limit), 'unavailableDirectories':missing,
            'provenance':'unverified_candidates', 'selected':None,
            'nextStep':'Compare content, duration and scene/version against your assigned video. Filename and modification time do not prove an export match. Never trigger another export merely because no candidate was found.'}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', action='append', type=Path, help='Explicit download directory; may be repeated. No recursive scan.')
    parser.add_argument('--name', required=True, help='Case-insensitive substring of the assigned project name')
    parser.add_argument('--since', required=True, help='Earliest modification time, ISO8601 with timezone')
    parser.add_argument('--limit', type=int, default=50)
    args=parser.parse_args()
    try:
        since=dt.datetime.fromisoformat(args.since.replace('Z','+00:00'))
        if since.tzinfo is None or not args.name.strip() or not 1 <= args.limit <= 200:
            raise ValueError('Use a nonempty project name, timestamp with timezone, and limit1..200')
        print(json.dumps(discover(args.directory or default_directories(),args.name,since.timestamp(),args.limit),ensure_ascii=False,indent=2))
    except (ValueError,OSError) as error:
        parser.exit(2,f'Download discovery failed: {error}\n')


if __name__=='__main__': main()
