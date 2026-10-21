# Contributing as an agent / Работа агента

This is the canonical, publishable source for Vids Studio. The installed user checkouts are separate. Read the relevant code and docs before changing behavior. Keep edits scoped, preserve unrelated changes, run relevant checks, and report what was actually verified.

## Source boundaries

- `native/`, `server/`, and `extension/` implement the common runtime. `profiles/` defines the two public extension identities. Preserve those identities when updating an existing installation.
- `skill/google-vids/references` and `scripts` are the shared skill corpus. Claude's wrapper and additional local helpers live in `skill/vids-director`. Use the profile builder to materialize a complete client installation.
- Keep the Russian and English public guides consistent. Describe isolated tests and live Vids acceptance separately; do not claim an export or client model was verified without evidence.
- Generated build metadata must not contain a developer's absolute local paths. Do not include credentials, user configuration, tokens, registries, logs, real document IDs, personal media, or browser profiles in commits or releases.

## Runtime invariants

Use only an explicitly attached Google Vids document. Preserve profile/session/document binding, fresh snapshots, own capabilities, and shared document arbitration. No OS input, foreground activation, clipboard, cookies, arbitrary browser execution, or automatic attachment. An unknown mutation is not permission to retry. Process death or a timer is not proof of fencing. Never weaken guards or tests merely to obtain a successful result.

## Verification and changes

Run the documented tests for changed behavior. For packaging, test a new Codex and Claude target, including their skill wrappers and setup dry-runs. Browser tests use disposable profiles and local fixtures. Never run release checks against a user's live Vids tab. For full profile tests set `VIDS_STUDIO_CANONICAL_SOURCE` to this checkout when running in a materialized copy.

Make a focused commit after reviewing the staged diff. Publishing, creating remote releases, and modifying a live installation require explicit user scope. Do not force-push or alter Git configuration without specific authorization.

Русский: общая основа и навыки поддерживаются в этом репозитории. Сохраняйте отдельные профили, проверяйте фактический результат и не смешивайте тесты на фикстурах с живой приёмкой. Не публикуйте пользовательские данные. Не обходите занятое управление, неизвестный исход или запрет системного ввода.
