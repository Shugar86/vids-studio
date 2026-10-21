# Verification / Проверка

This public record distinguishes source tests, loaded runtime and live Google Vids acceptance. See the reproducible [English testing guide](docs/en/testing.md) or [русское руководство](docs/ru/testing.md).

## Evidence boundary — 0.2.0

| Layer | Scope |
| --- | --- |
| Automated source checks | Python and Node tests cover profiles/setup, MCP/native transport, document arbitration, driver recovery, uploads, jobs and local helpers. Real browser fixtures run in disposable profiles. |
| Installed files | `build_profiles.py --check` compares managed files. It does not activate Chrome or a client. |
| Loaded runtime | `vids_diagnostics` verifies MCP/host/extension metadata. `live_smoke.mjs` can verify one explicit document read-only after activation. |
| Live Google Vids | Current typed MP4 export acceptance remains pending. Account-specific generation and every new video require their own review. |

The export fixture supplies a full document referrer and uses local HTTP, redirect and blob downloads. This is not a claim that Google Vids currently supplies the same events/referrer. The job rejects unsupported attribution. [Export behavior and limits](docs/en/jobs.md).

Public tests contain no private film assets or user-profile state. Test counts and environment-specific results belong to the corresponding CI run or release notes; the presence of this file does not claim that a future checkout passed.

## Граница свидетельств — 0.2.0

Автоматические проверки подтверждают локальные механизмы в описанных условиях. Они не означают, что пользователь перезагрузил расширения, текущий Google Vids сохранил интерфейс или качество нового ролика уже проверено. `--check` проверяет файлы; diagnostics — загруженные версии; live smoke — чтение явно указанного документа.

Живое принятие typed-экспорта MP4 ещё ожидается. Fixture с полным referrer не выдаётся за поведение Google. Проверка генерации, звука, движения, субтитров и зрительской ясности нужна для каждого нового результата. [Поведение и ограничения экспорта](docs/ru/jobs.md).
