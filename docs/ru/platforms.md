# Windows, macOS и Linux

[Русский](platforms.md) · [English](../en/platforms.md) · [Установка](installation.md)

В версии 0.3 добавлена нативная установка на Windows и macOS для Codex и Claude Code. Выбирайте ZIP по **клиенту**: один пакет определяет операционную систему. Для Windows не требуется WSL. Это предварительная версия: нативный CI проверяет установку, транспорт и локальные медиа; работу с реальным Google Vids нужно принимать отдельно.

| Платформа | Регистрация native host | Локальное подключение | Установка навыка |
| --- | --- | --- | --- |
| Windows | Ключ Chrome текущего пользователя в реестре (HKCU) | Только loopback, взаимная аутентификация свежим секретом из закрытого файла | Управляемая копия, без привилегии создания symlink |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` | Закрытый Unix socket | Symlink |
| Linux | `~/.config/google-chrome/NativeMessagingHosts` | Закрытый Unix socket | Symlink |

Нужны нативные Node.js 22.13+ (рекомендуется Node 24), Python 3.11+, Bun и Google Chrome на совместимой с ними системе. Для медиа-помощников и проверки экспорта установите FFmpeg/ffprobe. Используйте обычную локальную учётную запись и постоянный каталог. Состояние Windows должно храниться внутри локального профиля пользователя на файловой системе с поддержкой ACL. Сетевые диски, reparse points и общие каталоги с правом записи отклоняются.

## Windows — PowerShell

Распакуйте ZIP Codex или Claude внутри своего профиля, например в `C:\Users\you\Apps\vids-studio-codex`. Откройте PowerShell в этом каталоге. Пример выбирает Codex; в пакете Claude замените `codex` на `claude`.

```powershell
bun install --frozen-lockfile
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-windows.txt
.\.venv\Scripts\python.exe scripts/setup.py --profile codex
.\.venv\Scripts\python.exe scripts/setup.py --profile codex --install
```

Активация PowerShell и смена execution policy не нужны. Установщик сохраняет выбранный путь Python для Chrome и MCP-клиента; оставьте `.venv` на месте. Зависимость `pywin32` нужна только Windows: она проверяет владельца и ACL. При отсутствии зависимости или небезопасных правах установка останавливается.

Установщик создаёт launcher и manifest native host, затем регистрирует manifest в `HKCU\Software\Google\Chrome\NativeMessagingHosts`. Предыдущее состояние реестра и настроек записывается для отката; конфликтующие регистрации отклоняются. Права администратора не нужны.

Из исходников сначала соберите клиента: `py -3 scripts/build_profiles.py --profile codex --target ..\vids-studio-codex --write`, затем выполните команды установки внутри полученного каталога. Для проверки архива сравните `Get-FileHash .\vids-studio-0.3.0-codex.zip -Algorithm SHA256` со строкой в `SHA256SUMS`.

## macOS — Терминал

Распакуйте ZIP выбранного клиента в постоянный каталог внутри домашней папки. Выполните в нём:

```sh
bun install --frozen-lockfile
python3 scripts/setup.py --profile codex
python3 scripts/setup.py --profile codex --install
```

Для Claude замените `codex` на `claude`. Установщик создаёт launcher с абсолютным путём Python: Chrome, открытый из Finder, не зависит от PATH терминала. Сохраняйте эту установку Python; при изменении пути Python сначала откатите текущую регистрацию (при нескольких обновлениях — записи от новой к старой), затем установите с новым интерпретатором. Конфликтующий launcher или конфигурация намеренно отклоняются. Системная регистрация Chrome и `sudo` не нужны. Для проверки архивов выполните `shasum -a 256 -c SHA256SUMS` рядом с загруженными файлами.

## Подключение, обновление и откат

На каждой платформе загрузите каталог `extension` через `chrome://extensions`, откройте нужный документ Vids, явно подключите его в расширении и обновите MCP-подключение клиента. Перед изменениями проверьте `vids_diagnostics` и `vids_status`. Идентичности расширений и MCP у клиентов остаются раздельными.

После обновления файлов снова выполните setup, перезагрузите распакованные расширения и переподключите MCP-клиент. На Windows setup обновляет управляемую копию навыка; изменять нужно исходник навыка, а не эту копию.

При изменении настроек setup выводит путь к закрытому `rollbackRecord`. Тем же интерпретатором Python покажите план отката: `scripts/setup.py --rollback RECORD`; для применения добавьте `--install`. Откат проверяет последующие изменения и восстанавливает записанные байты и регистрацию Windows. Файлы Windows получают закрытый ACL текущего пользователя; произвольные прежние ACL не воспроизводятся. На Linux/macOS сохраняются записанные modes. Код и запущенные процессы он не откатывает. [Полная инструкция обновления и отката](installation.md).

## Что проверяется

[CI workflow](https://github.com/Shugar86/vids-studio/blob/main/.github/workflows/ci.yml) сохраняет полные Linux-проверки и добавляет нативные Windows/macOS задания для обоих клиентов: изолированную установку и откат, Unicode в Native Messaging, текстовые и графические MCP-ответы, общее владение документом, сохранность заданий, декодирование MP4 и воспроизводимые архивы. Результат конкретного commit смотрите в [Actions](https://github.com/Shugar86/vids-studio/actions): наличие workflow само по себе не означает успешный запуск.

В этих проверках используются имитация Chrome и созданные локальные медиа. Они не подтверждают живой экспорт Google Vids, качество модели или каждое сочетание ОС и архитектуры. [Границы приёмки](testing.md).

Пути регистрации и бинарный протокол соответствуют [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). Windows API для ACL предоставляет [pywin32](https://github.com/mhammond/pywin32), устанавливаемый отдельно под собственной лицензией.
