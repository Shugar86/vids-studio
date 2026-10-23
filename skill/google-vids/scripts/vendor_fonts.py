#!/usr/bin/env python3
"""Explicitly vendor selected Google Fonts into a new composition folder.

Requires the applicable local license text and its source. Does not determine
license suitability, install fonts, or bundle font binaries with this skill.
Fetches HTTPS Google Fonts CSS/WOFF2 only and records file hashes/provenance.
"""
import argparse
import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
KEEP = {"cyrillic", "cyrillic-ext", "latin", "latin-ext"}
HOSTS = {"fonts.googleapis.com", "fonts.gstatic.com"}


def checked_url(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in HOSTS or parsed.port not in (None, 443) or parsed.username or parsed.password:
        raise ValueError("Only HTTPS Google Fonts CSS/font URLs are allowed")
    return url


class FontRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        checked_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def get(url):
    checked_url(url)
    opener = urllib.request.build_opener(FontRedirect)
    with opener.open(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as response:
        checked_url(response.geturl())
        data = response.read(10 * 1024 * 1024 + 1)
        if len(data) > 10 * 1024 * 1024:
            raise ValueError("Font response exceeds 10 MiB")
        return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("families", nargs="+", help='CSS2 family specs, e.g. "Onest:wght@400;700"')
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--license-file", required=True, type=Path, help="Existing applicable license text for the selected family/families")
    parser.add_argument("--license-source", required=True, help="Public provenance URL for that license; recorded, not fetched")
    args = parser.parse_args()
    license_data = args.license_file.read_bytes()
    if not license_data or len(license_data) > 1024 * 1024:
        raise ValueError("License text must be nonempty and at most 1 MiB")
    if urllib.parse.urlparse(args.license_source).scheme not in {"https", "http"}:
        raise ValueError("License source must be a public HTTP(S) provenance URL")
    if args.out.exists() and any(args.out.iterdir()):
        raise ValueError("Output directory is not empty; choose a fresh destination")
    query = "&".join("family=" + urllib.parse.quote(f, safe=":;@,") for f in args.families)
    css_url = f"https://fonts.googleapis.com/css2?{query}&display=block"
    css = get(css_url).decode()
    args.out.mkdir(parents=True, exist_ok=True)
    blocks = re.findall(r"/\* ([\w-]+) \*/\s*(@font-face\s*{[^}]*})", css)
    local, saved, records = [], {}, []
    for subset, block in blocks:
        if subset not in KEEP:
            continue
        match = re.search(r"url\((https://[^)]+)\)", block)
        family_match = re.search(r"font-family:\s*'([^']+)'", block)
        if not match or not family_match:
            raise ValueError("Unsupported Google Fonts CSS structure")
        url, family = match.group(1), family_match.group(1)
        if url not in saved:
            name = f"{re.sub(r'[^A-Za-z0-9]+', '-', family).lower()}-{subset}-{len(saved)}.woff2"
            data = get(url)
            if not data.startswith(b"wOF2"):
                raise ValueError("Expected a WOFF2 font")
            (args.out / name).write_bytes(data)
            records.append({"file": name, "source": url, "sha256": hashlib.sha256(data).hexdigest(), "family": family, "subset": subset})
            saved[url] = name
        local.append(block.replace(url, saved[url]))
    if not local:
        raise ValueError("No supported Latin/Cyrillic faces found")
    (args.out / "fonts.css").write_text("\n".join(local) + "\n", encoding="utf-8")
    (args.out / "FONT-LICENSE.txt").write_bytes(license_data)
    manifest = {"families": args.families, "css_source": css_url, "license_source": args.license_source,
                "license_file": "FONT-LICENSE.txt", "license_sha256": hashlib.sha256(license_data).hexdigest(), "files": records}
    (args.out / "fonts.provenance.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"{len(saved)} font files; license and provenance recorded in {args.out}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
