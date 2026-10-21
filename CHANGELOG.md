# Changelog · История изменений

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
