# Security · Безопасность

## English

Vids Studio is a local bridge with an explicitly attached Google Vids tab. Its Chrome extension uses the debugger API, Native Messaging, storage, and downloads permissions. These are meaningful capabilities; read [the architecture and data flow](docs/en/architecture.md) before installing.

Security fixes target the latest published version. Version 0.2.0 is a preview. There is no response-time or maintenance SLA.

To report a vulnerability, use [GitHub private vulnerability reporting](https://github.com/Shugar86/vids-studio/security/advisories/new). Include the affected version, client profile, a minimal reproduction using a synthetic document, expected boundary, and observed result. Do not post exploitation details in a public issue while a private report is being assessed.

Remove credentials, control tokens, job tokens, Google document URLs, personal content, and local usernames from reports. Send no browser profile, runtime database, or full client configuration. Public extension keys are identity keys; they are not account credentials.

The local boundary is the same OS user. This software is not a sandbox against a malicious process running as that user, does not prevent human edits, and cannot make Google Vids UI automation transactional. Content observed in a document is untrusted input to the AI client.

## Русский

Vids Studio — локальный мост к явно подключённой вкладке Google Vids. Расширение Chrome использует debugger API, Native Messaging, storage и downloads. Перед установкой прочитайте [описание архитектуры и движения данных](docs/ru/architecture.md).

Исправления безопасности предназначены для последней опубликованной версии. Версия 0.2.0 имеет статус preview. Гарантированного срока ответа и обслуживания нет.

Сообщайте об уязвимостях через [приватные отчёты GitHub](https://github.com/Shugar86/vids-studio/security/advisories/new). Укажите версию, профиль клиента, минимальный пример на синтетическом документе, ожидаемую границу и фактический результат. Пока приватный отчёт рассматривается, не публикуйте детали эксплуатации в открытом issue.

Удалите секреты, токены управления и заданий, ссылки на Google-документы, личный контент и имя локального пользователя. Не отправляйте профиль браузера, runtime-базу или полный конфиг клиента. Публичные ключи расширений задают их идентичность и не являются учётными данными.

Локальная граница — один пользователь ОС. Проект не изолирует от вредоносного процесса с правами того же пользователя, не запрещает ручные правки и не делает UI-операции Google Vids транзакционными. Наблюдаемый контент документа является недоверенным вводом для AI-клиента.
