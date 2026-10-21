# Установка и обновление

[English](../en/installation.md) · [Русский](installation.md) · [Главная](../../README.ru.md)

Для каждого клиента нужен отдельный постоянный каталог установки. Репозиторий — общий источник; сборка профиля задаёт идентификатор расширения, имя MCP и входной навык. Сборка не активирует Chrome и не меняет настройки клиента.

## Требования

| Зависимость | Требование |
| --- | --- |
| ОС | Linux, macOS или нативная Windows; [инструкции по платформам](platforms.md) |
| Node.js | 22.13.0+ для встроенного `node:sqlite`; основной записанный прогон выполнен на Node 24 |
| Python | 3.11+ |
| Bun | Установка зависимостей из `bun.lock` с `--frozen-lockfile` |
| Браузер | Google Chrome 118+; записанные браузерные проверки выполнены на Chrome 148 |
| Клиент | Codex или Claude Code; Claude Desktop этот установщик не настраивает |
| Аккаунт Google | Доступ к Google Vids; доступность AI-функций зависит от аккаунта |
| Медиа | FFmpeg и ffprobe для заданий экспорта и анализа медиа |

Минимальные версии Node/Chrome не означают, что проверена каждая комбинация. Коннектору не нужны ключ модели, OAuth-клиент Google, экспорт cookie или публичный сервис. AI-клиент и Google Vids сохраняют собственные требования к авторизации и доступу.

**Windows:** используйте [команды PowerShell](platforms.md#windows--powershell), включая отдельную Python-зависимость. Примеры shell ниже рассчитаны на Linux/macOS; для тех же скриптов в Windows используйте выбранный интерпретатор Python. Регистрация Chrome и размещение состояния различаются по платформам.

## Сборка из исходников

```sh
git clone https://github.com/Shugar86/vids-studio.git
cd vids-studio
```

Проверьте план и соберите Codex:

```sh
python3 scripts/build_profiles.py --profile codex --target ../vids-studio-codex
python3 scripts/build_profiles.py --profile codex --target ../vids-studio-codex --write
```

Из того же источника проверьте план и соберите Claude Code:

```sh
python3 scripts/build_profiles.py --profile claude --target ../vids-studio-claude
python3 scripts/build_profiles.py --profile claude --target ../vids-studio-claude --write
```

Каталоги могут быть новыми. Существующий target должен принадлежать соответствующему профилю Vids Studio. Другой профиль, иной ключ расширения, symlink в управляемом пути или параллельная правка файла останавливают сборку. Посторонние файлы target не удаляются. Не указывайте каталог другого проекта.

Выполните команды внутри **каждого используемого профиля**, указав его имя:

```sh
bun install --frozen-lockfile
python3 scripts/setup.py --profile codex
python3 scripts/setup.py --profile codex --install
```

В каталоге Claude замените `codex` на `claude`. Setup берёт `node` из PATH; для другого исполняемого файла укажите `--node /absolute/path/to/node`. Первый вызов показывает план. Второй проверяет все назначения, регистрирует host, добавляет запись клиента и ссылку на навык. Модель, браузер и вкладка не запускаются.

## Установка из архива релиза

Если на [странице Releases](https://github.com/Shugar86/vids-studio/releases) доступны архивы профилей, выберите `vids-studio-<version>-codex.zip` или `vids-studio-<version>-claude.zip`. Сверьте архив с приложенным `SHA256SUMS` и распакуйте в постоянный каталог. Зависимости в архив не включены: внутри профиля выполните `bun install --frozen-lockfile`, затем команды проверки плана и установки выше.

Архив `source` предназначен для разработки и сборки профилей; он не заменяет выбор нужного клиента. Контрольная сумма обнаруживает изменение файла, но не является отдельной криптографической подписью автора.

## Загрузка и подключение расширения

1. В Chrome-профиле, где вы работаете с Vids, откройте `chrome://extensions` и включите **Режим разработчика**.
2. Нажмите **Загрузить распакованное расширение** и выберите каталог `extension` нужной установки.
3. Откройте нужный документ `https://docs.google.com/videos/d/...`.
4. Откройте **Vids Studio** для Codex или **Vids Studio · Claude** для Claude Code и нажмите кнопку подключения.
5. Обновите MCP-подключение клиента либо начните новую сессию клиента, которая перечитает конфигурацию.
6. Попросите выполнить `vids_diagnostics` и `vids_status`. Нужны совпадающие build metadata MCP/host/extension, `compatibility.ready: true`, `attached: true` и правильный документ.

Разрешение Chrome `debugger` широкое. Код ограничивает себя явно подключённым документом Vids и повторно проверяет его перед вводом. Перед работой с чувствительным содержимым прочитайте [модель разрешений и данных](architecture.md). Не открывайте DevTools управляемой вкладки: Chrome может отключить debugger расширения.

## Что меняет setup

| Профиль | Настройки клиента | Ссылка на навык | Native host |
| --- | --- | --- | --- |
| Codex | `$CODEX_HOME/config.toml` или `~/.codex/config.toml` | `skills/google-vids` внутри каталога Codex | `com.vids_studio.bridge` |
| Claude Code | `~/.claude.json` | `~/.claude/skills/vids-director` | `com.vids_studio.claude_bridge` |

Путь manifests зависит от ОС: Linux — `~/.config/google-chrome/NativeMessagingHosts`, macOS — `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`; Windows также регистрирует manifest в HKCU. [Различия платформ](platforms.md). Для явно выбранных других расположений есть `--codex-dir`, `--claude-dir`, `--claude-config`, `--chrome-dir`. `--chrome-dir` — корень пользовательских данных Chrome с каталогом `NativeMessagingHosts`, не каталог вкладочного профиля `Default`.

Setup сохраняет посторонние настройки и останавливается при конфликте регистраций. Существующая установка не переносится незаметно. Сохраняйте постоянный путь; при миграции сначала осознанно сверьте старые регистрации, затем устанавливайте новый путь.

## Обновление обоих профилей

Сначала завершите активные запросы и освободите управление. Получите нужную версию исходников и пересоберите существующие установки из этого источника:

```sh
python3 scripts/build_profiles.py --profile codex --target ../vids-studio-codex --write
python3 scripts/build_profiles.py --profile claude --target ../vids-studio-claude --write
python3 scripts/build_profiles.py --profile codex --target ../vids-studio-codex --check
python3 scripts/build_profiles.py --profile claude --target ../vids-studio-claude --check
```

При изменении lockfile выполните `bun install --frozen-lockfile` в каждом target. Запустите setup без `--install`; если настройки требуют изменения, примените проверенный план. `build-manifest.json` хранит hashes управляемых файлов; `--check` возвращает 1 при расхождении. Общее поведение редактируется в исходниках, затем сборка повторяется.

**Активируйте файлы:** нажмите **↻ на карточке каждого расширения** в `chrome://extensions`, подключите его нужный Vids и обновите соответствующий MCP-клиент. Общая кнопка **Обновить** не заменяет reload распакованного расширения. Отключение/подключение вкладки не перечитывает изменённые файлы расширения. Host и MCP-процесс также могут продолжать работать со старым кодом.

Версии 0.2 и 0.3 используют локальный протокол 3 и протокол расширения 2. В 0.3 добавлена Windows-аутентификация транспорта. Старые host 0.1 не участвуют в общем координаторе документов. Обновление одного профиля не защищает его от второго старого профиля. После активации старые session/control/snapshot недействительны; повторите диагностику. Исходники, установленная сборка и работающий процесс — разные состояния.

## Откат локальной конфигурации

При изменениях setup печатает `rollbackRecord`. Закрытый файл в `.runtime/install-backups/` содержит точные прежние байты настроек и может включать приватные значения. Не публикуйте его.

```sh
python3 scripts/setup.py --rollback /absolute/path/to/rollback-record.json
python3 scripts/setup.py --rollback /absolute/path/to/rollback-record.json --install
```

Первый вызов показывает план; второй восстанавливает управляемые файлы, режимы и ссылку на навык. Откат не перезаписывает последующие правки пользователя. Он не откатывает код и не активирует старый runtime. Для отката кода материализуйте нужную версию источника и выполните тот же reload/reconnect.

Для Windows setup также обновляет управляемую копию навыка и сохраняет HKCU-регистрацию для отката. Для macOS создаётся launcher с абсолютным Python. [Пути, команды и различия платформ](platforms.md).

Откат Windows восстанавливает байты файлов, управляемую копию навыка и HKCU-регистрацию. ACL нормализуется до закрытого доступа текущего пользователя; произвольные прежние ACL не воспроизводятся. Linux/macOS восстанавливают записанные modes и symlink.
