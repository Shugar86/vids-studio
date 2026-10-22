# Changelog · История изменений

## 0.4.0 — parallel preview / параллельная работа

### English

- Independent attachments, native endpoints and driver queues; an exact document binding belongs to one chat across Codex and Claude. One-time pairing and fenced resume replace implicit current-tab selection.
- Shared adaptive operation limits, retained capacity for unsettled work and a separate bounded queue for local MP4 verification.
- Local RU/EN monitor for both profiles: current operations, resource allowance, pause controls, recovery and actual export stages. No screenshot polling or invented completion percentages.
- Separate export runners continue after an MCP client exits; missing heartbeat does not replay an export.
- Ten-tab Chrome and ten-client MCP/native integration coverage. An opt-in Codex model acceptance script uses isolated fixture pages and existing account authorization.

This is a preview. Fixture acceptance does not establish live Google Vids behavior, generation quota or video quality. Updating files does not reload an installed client.

### Русский

- Независимые подключения, native endpoints и очереди driver; точный документ закреплён за одним чатом между Codex и Claude. Одноразовый pairing и восстановление после подтверждённого отключения заменяют неявный выбор текущей вкладки.
- Общий адаптивный допуск команд, сохранение занятых слотов при неизвестном исходе и отдельная очередь локальной проверки MP4.
- Локальная панель RU/EN для обоих профилей: текущие операции, доступная нагрузка, паузы, восстановление и реальные этапы экспорта. Без опроса снимками и выдуманных процентов готовности.
- Отдельные export runners продолжают работу после выхода MCP; отсутствие heartbeat не запускает повторный экспорт.
- Интеграционные проверки десяти Chrome-вкладок и десяти MCP/native-клиентов. Добровольный прогон настоящих Codex-моделей использует изолированные страницы и существующую авторизацию аккаунта.

Предварительная версия. Фикстуры не доказывают поведение живого Google Vids, квоту генерации и качество видео. Замена файлов не перезагружает установленный клиент.

## 0.3.0 — Windows and macOS preview / Windows и macOS

### English

- Native Windows and macOS installation for Codex and Claude Code, with platform-specific Chrome registration, explicit Python launchers and guarded rollback.
- Windows uses private ACL-protected storage, handle-based document locks and a mutually authenticated loopback transport. Client commands are sent only after the native host proves its identity. Linux/macOS retain private Unix sockets and document fencing.
- Managed Windows skill copies avoid symlink privileges; media paths, persistent jobs and take-manifest locking support Windows.
- Windows launchers support Unicode installation paths; Windows/macOS setup records available media-tool paths for clients launched outside a terminal.
- Native Windows/macOS CI complements the full Linux suites with both profiles, real local processes, isolated installation/rollback, private-state checks, media verification and reproducible packaging.
- MIT license included in all packages. English/Russian platform guides cover PowerShell, Terminal, updates and verification boundaries.

Live Google Vids acceptance and editorial review remain separate from simulated-peer CI. Existing 0.2.0 archives and checksums are preserved.

### Русский

- Нативная установка на Windows и macOS для Codex и Claude Code: штатная регистрация Chrome, явный путь Python и откат с проверкой последующих изменений.
- На Windows используются закрытые ACL, блокировки владения документом и loopback с взаимной аутентификацией. Команды передаются только после проверки native host. На Linux/macOS сохраняются закрытые Unix sockets и правила восстановления неизвестных исходов.
- Управляемые копии навыков Windows не требуют права на symlink; адаптированы пути медиа, постоянные задания и блокировка манифеста дублей.
- Windows-launcher поддерживает Unicode в пути установки; setup Windows/macOS сохраняет найденные пути медиа-инструментов для клиентов, запущенных вне терминала.
- Нативный CI Windows/macOS дополняет полные Linux-проверки: оба клиента, реальные локальные процессы, изолированные установка и откат, права, медиа и воспроизводимость упаковки.
- MIT включена во все пакеты. Инструкции RU/EN описывают PowerShell, Terminal, обновление и границы подтверждения.

Живая приёмка Google Vids и редакторская оценка остаются отдельными от CI с имитацией браузера. Архивы и контрольные суммы 0.2.0 сохранены.

## 0.2.0 — public preview / публичная предварительная версия

### English

First public distribution of the shared Vids Studio source for Codex and Claude Code.

- Separate extension, MCP, Native Messaging, and skill identities built from one runtime core.
- Complete client bundles, portable build manifests, deterministic source/Codex/Claude ZIP archives, and SHA-256 checksums.
- English and Russian guides, creative skill references, and a language switch in the extension popup.
- Document arbitration shared by both profiles; durable mutation fences and explicit reconciliation after an unknown outcome.
- Experimental `export_mp4` jobs with recovery, download correlation, media decoding, and artifact hashes.
- Synthetic unit/process/browser coverage and CI for both client profiles. Browser fixtures do not replace live acceptance.

**Known limits:** live acceptance of the 0.2 export against the current Google Vids UI is pending. Download correlation requires a full matching referrer; ambiguous or absent evidence must fail closed. Same-document manual exports can be indistinguishable. Pointer dragging can be affected by rendering load; re-observe and verify the result. Linux is the supported installation target.

### Русский

Первая публичная поставка общих исходников Vids Studio для Codex и Claude Code.

- Отдельные идентичности расширений, MCP, Native Messaging и навыков, собранные из одного ядра.
- Полные клиентские пакеты, переносимые манифесты сборки, воспроизводимые ZIP исходников/Codex/Claude и контрольные суммы SHA-256.
- Русские и английские руководства, творческие справочники навыка и переключатель языка в расширении.
- Общая блокировка документа для двух профилей, устойчивые записи об изменениях и явная сверка неизвестного исхода.
- Экспериментальные задания `export_mp4` с восстановлением, сопоставлением загрузки, декодированием и хешированием файла.
- Изолированные unit/process/browser-проверки и CI для двух профилей. Браузерные fixtures не заменяют живую приёмку.

**Ограничения:** живая приёмка экспорта 0.2 на актуальном Google Vids ещё не выполнена. Сопоставление загрузки требует полного совпадающего referrer; при недостаточных или неоднозначных данных операция должна завершаться отказом. Одновременный ручной экспорт того же документа может быть неотличим. Перетаскивание зависит от нагрузки отрисовки: результат нужно наблюдать и проверять. Поддерживаемая система установки — Linux.
