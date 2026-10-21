# Vids Studio · руководство для агентов / agent guide

[Русский](#русский) · [English](#english) · [Команды / Commands](#commands)

## Русский

### Назначение и границы

Vids Studio связывает Codex или Claude Code с одной явно подключённой вкладкой Google Vids. Локальный MCP-сервер, native host и Chrome-расширение выполняют действия; навык задаёт процесс создания и проверки видео. Это канонический публичный исходный код. Установленные профили и процессы пользователя — отдельное состояние.

Сначала прочитайте затронутый код и соответствующие [руководства](docs/ru/architecture.md). Правьте исходник, затем собирайте профиль. Не исправляйте установку пользователя вместо исходника и не обновляйте её в рамках обычных тестов. Сохраняйте чужие изменения и ограничивайте diff задачей.

### Где менять

| Путь | Ответственность и источник истины |
| --- | --- |
| `server/` | MCP-инструменты, локальный транспорт, задания экспорта |
| `native/` | Native messaging, владение документом, координация и восстановление |
| `extension/` | MV3-расширение, работа с выбранной вкладкой, popup RU/EN |
| `profiles/codex.json`, `profiles/claude.json` | Раздельные идентичности клиентов; сохраняйте extension key, native host, MCP name и namespace |
| `skill/google-vids/` | Навык Codex; общие `references/`, `scripts/` и `tests/` для обоих клиентов |
| `skill/vids-director/` | Обёртка Claude, его дополнительные локальные helpers и assets; сборщик добавляет общий корпус |
| `scripts/build_profiles.py`, `scripts/setup.py`, `scripts/build_release.py` | Сборка профилей, установка/rollback конфигурации, релизные архивы |
| `tests/`, `.github/workflows/ci.yml` | Изолированные проверки и CI обоих профилей |
| `README.md`, `README.ru.md`, `docs/en/`, `docs/ru/` | Публичные инструкции с одинаковым смыслом на двух языках |

`profile.json`, `extension/profile.js` и `build-manifest.json` генерируются сборщиком. Не правьте их вручную. Общие изменения навыка вносите в `skill/google-vids`; копия внутри Claude-профиля не становится новым источником. Новые публичные файлы должны попасть в явные allowlist сборщика, чтобы ссылки работали и в ZIP.

### Что нельзя нарушать

- Только явно подключённый документ; без автоматического подключения, системного ввода, активации окна, clipboard, cookies или произвольного исполнения в браузере.
- Сохраняйте привязку к профилю, сессии и документу, свежесть snapshots, проверку capabilities и общее владение документом. Используйте собственный control token; не обходите `CONTROL_BUSY`.
- Не повторяйте мутацию с неизвестным исходом. Смерть процесса или истечение таймера не доказывают fencing. Восстановление требует предусмотренной протоколом проверки и новых полномочий управления.
- Не ослабляйте guards или assertions ради зелёного теста. Проверки браузера запускаются с временными профилями и локальными фикстурами; живой Chrome пользователя не является тестовым стендом.
- Не публикуйте секреты, конфигурацию пользователя, rollback-записи, runtime stores, логи, реальные document IDs, персональные медиа или browser profiles. Генерируемые метаданные не должны содержать абсолютные пути разработчика.

### Проверка по характеру изменения

| Изменение | Достаточное свидетельство |
| --- | --- |
| Документация, графика | Ссылки и наличие assets, визуальная проверка страницы, согласованность RU/EN; обновление и `--check` manifest для управляемых файлов |
| Навык или helper | Тесты затронутого helper, проверки обоих wrappers и полноты свежих профилей; примеры без обращения к живым сервисам |
| Runtime, протокол, extension | Полный `bun run test` в исходнике и свежем Claude-профиле с явным canonical source; профильные skill-тесты и релевантный regression case; `python tests/platform_smoke.py` на Windows/macOS при изменении переносимого runtime |
| Сборщик, setup, релиз | Свежие Codex **и** Claude; `--check`, setup в изолированных каталогах, тесты профилей/setup/архивов; состав ZIP, контрольные суммы и повторяемость сборки |

Команды ниже запускаются из корня исходника. Подробности и границы проверок — в [testing](docs/ru/testing.md). Отдельно сообщайте: проверенный исходник, фактически загруженный runtime и живую приёмку. Ни сборка, ни замена файлов не доказывают загрузку нового кода клиентом. Экспорт 0.2 остаётся preview до проверки текущей сборки в реальном Vids; локальная фикстура не доказывает наличие полного referrer у Google. Качество видео и работа конкретной модели требуют собственных свидетельств.

Перед завершением просмотрите staged diff, создайте focused commit и сообщите результат проверок, commit и оставшиеся ограничения. Публикация, релизы и изменение живой установки требуют scope пользователя; уже данное разрешение на названный репозиторий/действие не запрашивается повторно. Не делайте force push и не меняйте Git config без отдельного точного разрешения. Выбор лицензии не входит в оформление документации.

## English

### Purpose and scope

Vids Studio connects Codex or Claude Code to one explicitly attached Google Vids tab. A local MCP server, native host and Chrome extension perform actions; the skill guides video creation and review. This repository is the canonical public source. Installed profiles and running user processes are separate states.

Read the affected code and relevant [guides](docs/en/architecture.md) first. Edit the source, then materialize a profile. Do not patch a user's installation instead of the source or update it as part of routine tests. Preserve unrelated edits and keep the diff scoped to the task.

### Where changes belong

| Path | Responsibility and source of truth |
| --- | --- |
| `server/` | MCP tools, local transport and export jobs |
| `native/` | Native messaging, document ownership, coordination and recovery |
| `extension/` | MV3 extension, attached-tab operations and EN/RU popup |
| `profiles/codex.json`, `profiles/claude.json` | Distinct client identities; preserve extension keys, native host names, MCP names and namespaces |
| `skill/google-vids/` | Codex skill; shared `references/`, `scripts/` and `tests/` for both clients |
| `skill/vids-director/` | Claude wrapper, additional local helpers and assets; the builder adds the shared corpus |
| `scripts/build_profiles.py`, `scripts/setup.py`, `scripts/build_release.py` | Profile materialization, configuration install/rollback and release archives |
| `tests/`, `.github/workflows/ci.yml` | Isolated checks and CI for both profiles |
| `README.md`, `README.ru.md`, `docs/en/`, `docs/ru/` | Public instructions with equivalent meaning in both languages |

The builder generates `profile.json`, `extension/profile.js` and `build-manifest.json`; do not edit them manually. Change shared skill content in `skill/google-vids`; a copy in a Claude profile is not another source of truth. Add new public files to the builder's explicit allowlists so links also work in ZIP distributions.

### Required invariants

- Use only an explicitly attached document. No automatic attachment, OS input, window activation, clipboard, cookies or arbitrary browser execution.
- Preserve profile/session/document binding, fresh snapshots, capability checks and shared document ownership. Use your own control token; do not bypass `CONTROL_BUSY`.
- Never replay a mutation with an unknown outcome. Process death or a timer is not proof of fencing. Recovery requires protocol-defined reconciliation and fresh control authority.
- Never weaken guards or assertions to pass a check. Browser tests use disposable profiles and local fixtures; the user's live Chrome is not a test environment.
- Never publish credentials, user configuration, rollback records, runtime stores, logs, real document IDs, personal media or browser profiles. Generated metadata must not contain developer-specific absolute paths.

### Match verification to the change

| Change | Required evidence |
| --- | --- |
| Docs and graphics | Valid links and assets, visual page review, EN/RU parity; regenerate and `--check` the manifest for managed files |
| Skill or helper | Affected helper tests, both wrappers and complete fresh profiles; examples without live service calls |
| Runtime, protocol or extension | Full `bun run test` in source and a fresh Claude profile with explicit canonical source; profile skill tests and a relevant regression case; `python tests/platform_smoke.py` on Windows/macOS when changing portable runtime |
| Builder, setup or release | Fresh Codex **and** Claude targets; `--check`, isolated setup, profile/setup/archive tests; ZIP contents, checksums and repeatable builds |

Run the commands below from the source root. See [testing](docs/en/testing.md) for detail. Report source checks, loaded runtime and live acceptance separately. Building or replacing files does not prove a client loaded them. Export 0.2 remains preview until the current build is verified in real Vids; a local fixture does not establish Google's full-referrer behavior. Video quality and actual client-model behavior need their own evidence.

Before finishing, review the staged diff, make a focused commit, and report checks, commit and remaining limits. Publication, releases and live-install changes require user scope; do not request authorization again for the repository/action already authorized. No force push or Git configuration changes without specific permission. Documentation work does not authorize choosing a license.

<a id="commands"></a>
## Команды / Commands

Полный regression suite / Full regression suite — Linux, Node 22.13+, Python 3.11+, Bun, FFmpeg/ffprobe. Нативные Windows/macOS checks / Native Windows/macOS checks: `python tests/platform_smoke.py`; [платформы / platforms](docs/en/platforms.md).

```sh
bun install --frozen-lockfile
bunx playwright install chromium
python3 scripts/build_profiles.py --profile codex --target . --write
python3 scripts/build_profiles.py --profile codex --target . --check
bun run test
python3 -I -m unittest discover -s skill/google-vids/tests
python3 -I -m unittest discover -s skill/vids-director/tests
```

Свежие профили и изолированный setup dry-run / Fresh profiles and isolated setup dry-runs:

```sh
VIDS_SOURCE_DIR="$(pwd -P)"
VIDS_CHECK_DIR="$(mktemp -d)"
for profile in codex claude; do
  python3 scripts/build_profiles.py --profile "$profile" --target "$VIDS_CHECK_DIR/$profile" --write
  python3 scripts/build_profiles.py --profile "$profile" --target "$VIDS_CHECK_DIR/$profile" --check
  (
    cd "$VIDS_CHECK_DIR/$profile"
    bun install --frozen-lockfile
    python3 scripts/setup.py --profile "$profile" \
      --codex-dir "$VIDS_CHECK_DIR/config/codex" --claude-dir "$VIDS_CHECK_DIR/config/claude" \
      --claude-config "$VIDS_CHECK_DIR/config/claude.json" --chrome-dir "$VIDS_CHECK_DIR/config/chrome"
    VIDS_STUDIO_CANONICAL_SOURCE="$VIDS_SOURCE_DIR" bun run test
    for skill_dir in skill/*/tests; do python3 -I -m unittest discover -s "$skill_dir"; done
  )
done
```

Без `VIDS_STUDIO_CANONICAL_SOURCE` профильный архив может пропустить cross-profile source test; это не полная приёмка. `setup.py` без `--install` только показывает план. / Without `VIDS_STUDIO_CANONICAL_SOURCE`, a profile archive may skip the cross-profile source test; that is not full acceptance. `setup.py` without `--install` only prints a plan.

Релиз / Release: `python3 scripts/build_release.py --output dist`; повторите в другом пустом каталоге, сравните файлы и выполните `sha256sum --check SHA256SUMS` внутри `dist`. / Repeat in another empty directory, compare the files, and run `sha256sum --check SHA256SUMS` inside `dist`.
