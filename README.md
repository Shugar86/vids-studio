<p align="center">
  <img src="docs/assets/hero.svg" alt="Vids Studio — creative skills and a local bridge for Google Vids" width="100%">
</p>

<p align="center"><a href="https://github.com/Shugar86/vids-studio/actions/workflows/ci.yml"><img src="https://github.com/Shugar86/vids-studio/actions/workflows/ci.yml/badge.svg" alt="Verify both profiles"></a> · <a href="https://github.com/Shugar86/vids-studio/releases">v0.2.0 preview · Download / Скачать</a></p>

<p align="center"><strong>Make videos in Google Vids with Codex or Claude Code.</strong><br>Creative direction, a local MCP connector, and two Chrome extension profiles.</p>

<p align="center"><strong>English</strong> · <a href="README.ru.md">Русский</a><br><a href="docs/en/installation.md">Install</a> · <a href="docs/en/usage.md">Create a video</a> · <a href="docs/en/architecture.md">How it works</a> · <a href="docs/en/testing.md">What is verified</a></p>

## From an idea to an editable video

Vids Studio pairs a filmmaking skill with tools that operate the **Google Vids tab you explicitly connect**. The skill helps with the story, shots, voice, pacing, sound and review. The connector observes the editor and performs tab-local actions. Your project stays editable in Vids.

- **A creative workflow:** build a scene around an event; separate speech timing from shot timing; review picture, speech, sound and viewer clarity.
- **Two clients, one core:** distinct Codex and Claude Code identities, with shared runtime code and coordination for the same document.
- **Your desktop remains yours:** no system mouse, keyboard, clipboard or foreground-window automation.
- **Evidence before retry:** fresh UI snapshots, action receipts and explicit recovery when an action's outcome is unknown.
- **Local production helpers:** graphics, frame sheets, media inspection and a take manifest that retains previous versions.

This is an independent, unofficial UI automation project. It does not provide a Google Vids scene API, bypass account restrictions, or include Google AI access. **Linux is the supported and tested installation target.** The `export_mp4` job is experimental: its isolated browser tests pass, but live acceptance against the current Google Vids export remains pending. [Scope and evidence →](docs/en/testing.md)

## One repository, two profiles

| | Codex | Claude Code |
| --- | --- | --- |
| MCP server | `google-vids` | `vids-claude` |
| Skill | `google-vids` | `vids-director` |
| Chrome extension | Vids Studio | Vids Studio · Claude |
| Native host | `com.vids_studio.bridge` | `com.vids_studio.claude_bridge` |
| Installation | A materialized `codex` directory | A materialized `claude` directory |

Both profiles can work on different documents independently. For the same document, one task holds control and another receives `CONTROL_BUSY`. Both profiles must run the updated host and extension for this coordination to apply. It does not lock out a human editing the document.

## Start here

You need **Node.js 22.13+**, **Python 3.11+**, **Bun**, and **Google Chrome 118+** on Linux. The recorded test environment uses Node 24 and Chrome 148; minimum versions have not each been separately validated. FFmpeg/ffprobe are needed for export verification and media helpers. You also need your own Codex or Claude Code installation and access to Google Vids.

Clone the source and create a permanent Codex installation:

```sh
git clone https://github.com/Shugar86/vids-studio.git
cd vids-studio
python3 scripts/build_profiles.py --profile codex --target ../vids-studio-codex --write
cd ../vids-studio-codex
bun install --frozen-lockfile
python3 scripts/setup.py --profile codex
python3 scripts/setup.py --profile codex --install
```

For **Claude Code**, use `--profile claude` and a separate target such as `../vids-studio-claude`. The first setup call is a dry run; `--install` registers the native host, MCP configuration and skill link. It preserves unrelated settings and stops on conflicting registrations. It does not load the extension or attach a tab.

1. Open `chrome://extensions`, enable **Developer mode**, then **Load unpacked** and select the installation's `extension` directory.
2. Open the intended Google Vids document. Click the corresponding extension and connect that tab.
3. Refresh the client's MCP connection. Ask it to run `vids_diagnostics` and `vids_status`; require `compatibility.ready: true`, `attached: true`, and the intended document.

Keep the installation directory in place: the registered paths point to it. For both clients, downloads, updates and rollback, follow the [complete installation guide](docs/en/installation.md).

## Give the agent a brief

> Use the google-vids skill in the connected Google Vids document. Make a 35-second product explainer for first-time users, in English. Show the problem, one concrete action and its result. Use a calm voice and readable captions. Build and review a representative opening before completing the video, then check the export if available.

In Claude Code, name **vids-director** instead. You can also ask for a precise edit: shorten the opening, replace a shot, repair captions or improve the audio. [Workflow, prompts and review criteria →](docs/en/usage.md)

## Inside the repository

| Component | Purpose |
| --- | --- |
| [`skill/`](skill/) | Client entry points, shared creative guidance and local media helpers |
| [`server/`](server/) | MCP tools, argument validation and durable export jobs |
| [`native/`](native/) | Native Messaging host, private Unix socket and document coordinator |
| [`extension/`](extension/) | Chrome debugger driver, popup and download watcher |
| [`profiles/`](profiles/) | Separate public identities for the two clients |
| [`scripts/`](scripts/) | Profile builds, local setup, release packaging and live read-only smoke |
| [`tests/`](tests/) | Unit, process-isolation and real disposable-Chromium checks |

The connector does not read cookies or passwords, discover other tabs, or open a public TCP listener. Google Vids still sends normal editor and uploaded-media traffic to Google; observations and screenshots are delivered to your AI client. [Permissions, data and recovery →](docs/en/architecture.md)

## Documentation

| English | Русский |
| --- | --- |
| [Installation and updates](docs/en/installation.md) | [Установка и обновление](docs/ru/installation.md) |
| [Creative workflow and tools](docs/en/usage.md) | [Творческий процесс и инструменты](docs/ru/usage.md) |
| [Architecture and permissions](docs/en/architecture.md) | [Архитектура и разрешения](docs/ru/architecture.md) |
| [Troubleshooting](docs/en/troubleshooting.md) | [Решение проблем](docs/ru/troubleshooting.md) |
| [Testing and verified limits](docs/en/testing.md) | [Проверки и границы подтверждения](docs/ru/testing.md) |
| [Experimental export jobs](docs/en/jobs.md) | [Экспериментальные задания экспорта](docs/ru/jobs.md) |

Contributions should include a focused change and evidence appropriate to the behavior. Start with the [testing guide](docs/en/testing.md). Report reproducible problems through [GitHub Issues](https://github.com/Shugar86/vids-studio/issues), keeping document content, capabilities and private configuration out of reports.

## License

The license for this preview has not been selected yet. No license file is included.
