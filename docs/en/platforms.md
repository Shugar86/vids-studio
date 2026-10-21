# Windows, macOS and Linux

[English](platforms.md) · [Русский](../ru/platforms.md) · [Installation](installation.md)

Version 0.3 adds native Windows and macOS installation for both Codex and Claude Code. Choose the **client** ZIP; the same source package detects the operating system. Windows does not require WSL. This remains a preview: native CI exercises installation, transport and local media, while a real Google Vids session needs its own acceptance check.

| Platform | Native host registration | Local connection | Skill installation |
| --- | --- | --- | --- |
| Windows | Current user's Chrome registry key (HKCU) | Loopback only, mutually authenticated with a fresh secret kept in a private file | Managed copy; no symlink privilege needed |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` | Private Unix socket | Symlink |
| Linux | `~/.config/google-chrome/NativeMessagingHosts` | Private Unix socket | Symlink |

Use native Node.js 22.13+ (Node 24 recommended), Python 3.11+, Bun and Google Chrome on a system supported by those dependencies. Install FFmpeg/ffprobe for media helpers and export verification. Use a normal local account and a permanent directory; Windows runtime state must remain beneath that user's local profile, with Windows ACL support. Network shares, reparse points and shared writable state directories are rejected.

## Windows — PowerShell

Extract the Codex or Claude ZIP beneath your user profile, for example `C:\Users\you\Apps\vids-studio-codex`. Open PowerShell in that directory. The example selects Codex; replace `codex` with `claude` inside the Claude package.

```powershell
bun install --frozen-lockfile
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-windows.txt
.\.venv\Scripts\python.exe scripts/setup.py --profile codex
.\.venv\Scripts\python.exe scripts/setup.py --profile codex --install
```

No PowerShell activation or execution-policy change is needed. Setup records the selected Python interpreter for Chrome and the MCP client; retain `.venv` in place. The Windows-only `pywin32` dependency provides ownership and ACL checks. Missing dependencies or unsafe permissions cause an error instead of a weaker connection.

Setup creates a native-host launcher and manifest, then registers the manifest under `HKCU\Software\Google\Chrome\NativeMessagingHosts`. It records the previous registry/configuration state for rollback and refuses collisions. Administrator privileges are not required.

For a source checkout, build the client first using `py -3 scripts/build_profiles.py --profile codex --target ..\vids-studio-codex --write`; then run the installation commands in that target. For checksums, compare `Get-FileHash .\vids-studio-0.3.0-codex.zip -Algorithm SHA256` with the matching line in `SHA256SUMS`.

## macOS — Terminal

Extract the selected client ZIP into a permanent directory beneath your home. From that directory:

```sh
bun install --frozen-lockfile
python3 scripts/setup.py --profile codex
python3 scripts/setup.py --profile codex --install
```

Replace `codex` with `claude` for the Claude package. Setup creates a launcher with the absolute Python path, so Chrome opened from Finder does not depend on your terminal's PATH. Keep that Python installation available; if the interpreter path changes, first roll back the current registration (newest rollback record first if there are multiple updates), then install with the new interpreter. A conflicting existing launcher/configuration is deliberately rejected. No system-wide Chrome registration or `sudo` is needed. Use `shasum -a 256 -c SHA256SUMS` beside the downloaded archives to verify checksums.

## Connect, update and recover

On every platform, load the package's `extension` directory at `chrome://extensions`, open the intended Vids document, explicitly connect it in the extension and refresh the client's MCP connection. Verify `vids_diagnostics` and `vids_status` before editing. Each client retains its separate extension and MCP identity.

After updating package files, rerun setup, reload each unpacked extension and reconnect the MCP client. On Windows, setup refreshes the managed skill copy; do not edit that installed copy. Use the source skill instead.

Setup prints a private `rollbackRecord` when it changes configuration. Preview rollback with the same Python interpreter: `scripts/setup.py --rollback RECORD`; add `--install` to apply it. Rollback checks for later edits and restores the recorded bytes and Windows registration. Windows files receive the current user’s private ACL; arbitrary previous ACLs are not reproduced. Linux/macOS retain recorded file modes. It does not revert code or reload running processes. See the [full update and rollback instructions](installation.md).

## What is verified

The [CI workflow](https://github.com/Shugar86/vids-studio/blob/main/.github/workflows/ci.yml) retains the full Linux suites and adds native Windows/macOS jobs for both client profiles: isolated installation/rollback, Unicode Native Messaging, MCP text/image responses, shared document control, persistent job storage, MP4 decoding and reproducible archives. Read the result for the exact commit under [Actions](https://github.com/Shugar86/vids-studio/actions); a workflow definition alone is not a passing run.

These checks use a simulated Chrome peer and generated local media. They do not establish live Google Vids export behavior, model quality or support for every OS/architecture combination. [Acceptance boundary](testing.md).

Registration paths and binary framing follow [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). Windows ACL APIs come from [pywin32](https://github.com/mhammond/pywin32), installed separately under its own license.
