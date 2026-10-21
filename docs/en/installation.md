# Installation and updates

[English](installation.md) · [Русский](../ru/installation.md) · [Home](../../README.md)

Use a separate permanent installation directory for each client. The repository is the common source; profile builds add the right extension identity, MCP name and skill entry point. A build never activates Chrome or edits client configuration.

## Requirements

| Dependency | Requirement |
| --- | --- |
| OS | Linux, macOS or native Windows; [platform instructions](platforms.md) |
| Node.js | 22.13.0+ for built-in `node:sqlite`; Node 24 is the primary recorded test runtime |
| Python | 3.11+ |
| Bun | Install dependencies from `bun.lock` with `--frozen-lockfile` |
| Browser | Google Chrome 118+; Chrome 148 was used for recorded browser tests |
| Client | Codex or Claude Code; Claude Desktop configuration is not installed by this script |
| Google account | Access to Google Vids; AI feature availability depends on the account |
| Media tools | FFmpeg and ffprobe for export jobs and media inspection |

The declared minimum Node/Chrome versions are not a claim that every combination has been tested. The connector needs no model API key, Google OAuth client, cookie export or public service. Your AI client and Google Vids retain their own sign-in and service requirements.

For **Windows**, use the [PowerShell installation](platforms.md#windows--powershell), including the Windows-only Python dependency. Shell examples below target Linux/macOS; use the selected Windows Python executable for the same scripts.

## Build from source

```sh
git clone https://github.com/Shugar86/vids-studio.git
cd vids-studio
```

Preview and build Codex:

```sh
python3 scripts/build_profiles.py --profile codex --target ../vids-studio-codex
python3 scripts/build_profiles.py --profile codex --target ../vids-studio-codex --write
```

Preview and build Claude Code from the same source:

```sh
python3 scripts/build_profiles.py --profile claude --target ../vids-studio-claude
python3 scripts/build_profiles.py --profile claude --target ../vids-studio-claude --write
```

Targets may be new directories. An existing target must be a matching Vids Studio profile. The builder stops on another profile, a different extension key, symlinks in managed paths or a concurrent file change. It does not delete unrelated target files. Do not point it at an unrelated directory.

Run the following inside **each profile you will use**; choose its profile name:

```sh
bun install --frozen-lockfile
python3 scripts/setup.py --profile codex
python3 scripts/setup.py --profile codex --install
```

For the Claude directory, replace `codex` with `claude`. Setup selects `node` from PATH; use `--node /absolute/path/to/node` to pin a different executable. The first invocation prints a plan. The second validates all destinations, registers the host, adds the client entry and installs the skill (a managed copy on Windows, a symlink on Linux/macOS). It does not start a model, browser or tab.

## Install from a release archive

If profile archives are available on the [Releases page](https://github.com/Shugar86/vids-studio/releases), choose `vids-studio-<version>-codex.zip` or `vids-studio-<version>-claude.zip`. Verify it against the accompanying `SHA256SUMS`, then extract into a permanent directory. Dependencies are intentionally excluded: run `bun install --frozen-lockfile`, then the dry-run and install commands above inside the extracted profile.

A `source` archive is for development and materializing profiles; it is not a substitute for selecting the correct client. A checksum detects a changed download, but is not a separate cryptographic author signature.

## Load and connect the extension

1. In the Chrome profile you use for Vids, open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the installation's `extension` directory.
3. Open the intended `https://docs.google.com/videos/d/...` document.
4. Open **Vids Studio** for Codex or **Vids Studio · Claude** for Claude Code, then use its connect button.
5. Refresh that client's MCP connection or start a new client session that reads the updated configuration.
6. Ask for `vids_diagnostics` and `vids_status`. Confirm matching MCP/host/extension build metadata, `compatibility.ready: true`, `attached: true`, and the right document.

Chrome's `debugger` permission is broad. The implementation restricts itself to the explicitly attached Vids document and revalidates it before input. Read the [permission and data model](architecture.md) before using it with sensitive content. Do not open DevTools on the controlled tab: Chrome can detach the extension's debugger.

## What setup changes

| Profile | Client configuration | Skill link | Native host name |
| --- | --- | --- | --- |
| Codex | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | `skills/google-vids` within the Codex directory | `com.vids_studio.bridge` |
| Claude Code | `~/.claude.json` | `~/.claude/skills/vids-director` | `com.vids_studio.claude_bridge` |

Native host manifests use the [platform-specific Chrome location](platforms.md). Windows also registers the manifest in HKCU; macOS uses an explicit Python launcher. For explicit nondefault locations, use `--codex-dir`, `--claude-dir`, `--claude-config` or `--chrome-dir`; `--chrome-dir` is the Chrome user-data root containing `NativeMessagingHosts`, not a `Default` tab-profile directory.

Setup preserves unrelated settings and refuses conflicting registrations. It does not silently move an existing installation. Keep the installation path stable. If you are migrating a previously registered path, inspect and reconcile those registrations deliberately before installing the new location.

## Update both profiles

Finish active work and release control first. Pull the intended source revision, then rebuild each existing installation from that source:

```sh
python3 scripts/build_profiles.py --profile codex --target ../vids-studio-codex --write
python3 scripts/build_profiles.py --profile claude --target ../vids-studio-claude --write
python3 scripts/build_profiles.py --profile codex --target ../vids-studio-codex --check
python3 scripts/build_profiles.py --profile claude --target ../vids-studio-claude --check
```

Run `bun install --frozen-lockfile` inside each target if the lockfile changed. Run its setup dry-run and apply the plan. Windows setup refreshes the managed skill copy; retain the selected Python environment and update `requirements-windows.txt` dependencies when it changes. A generated `build-manifest.json` records managed-file hashes; `--check` returns 1 on drift. Edit shared behavior in the source, then build again.

**Activate the files:** click **↻ on each extension's card** in `chrome://extensions`, reconnect its intended Vids tab, and refresh the corresponding MCP client. The page-wide **Update** button is not the reload control for an unpacked extension. Disconnect/reconnect alone does not reload changed extension files. A host or MCP process can also keep old code loaded.

Versions 0.2 and 0.3 use local protocol 3 and extension protocol 2. Version 0.3 adds a Windows transport handshake without weakening document ownership. Old 0.1 hosts do not participate in the new shared document coordinator. Updating one profile does not protect it from an old second profile. After activation, discard old session/control/snapshot values and repeat diagnostics. Source files, installed files and running processes are different states.

## Roll back local configuration

When setup changes files, it prints `rollbackRecord`. The private record in `.runtime/install-backups/` contains exact previous configuration bytes and can include private values. Do not publish it.

```sh
python3 scripts/setup.py --rollback /absolute/path/to/rollback-record.json
python3 scripts/setup.py --rollback /absolute/path/to/rollback-record.json --install
```

The first command previews; the second restores managed file bytes and the skill installation. Linux/macOS restore recorded modes and symlinks. Windows restores the managed skill copy and HKCU registration, with private current-user ACLs rather than arbitrary previous ACLs. Rollback refuses to overwrite subsequent user edits. It does not revert source code or activate an older runtime. For code rollback, materialize the intended source version and complete the same reload/reconnect procedure.
