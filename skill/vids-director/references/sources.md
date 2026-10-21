# Источники и граница знания

Это карта официальных страниц для проверки текущих функций, а не гарантия доступа или качества в конкретном аккаунте. Интерфейс, языки, модели, тарифы и лимиты меняются: перед использованием проверь отдельную страницу функции и доступные контролы. Автоматические тесты этого репозитория проверяют runtime и helpers; они не доказывают пригодность сгенерированного видео, произношение или текущую доступность Google Vids. Личная история производства и закрытые артефакты не входят в публичный пакет.

| Область | Что подтверждает источник | Ссылка |
| --- | --- | --- |
| Общий редактор | Старт проекта, медиа и доступные способы работы; для актуальных лимитов проверять текущую страницу и UI | [Get started with Google Vids](https://support.google.com/docs/answer/15082958?hl=en) |
| Стили и шаблоны | Шаблоны сцен, общие цвета/шрифты, фон; в шаблонах могут оставаться английские тексты | [Use a template & add a background](https://support.google.com/docs/answer/15082957?hl=en) |
| Время объектов | Отдельные дорожки объектов, показ времени и корректировка их начала/конца | [Adjust timing of elements](https://support.google.com/docs/answer/14960797?hl=en) |
| Анимация | Анимации объектов, сцены и фото; эффекты фото могут повторяться | [Animate objects, scenes & photos](https://support.google.com/docs/answer/14999375?hl=en) |
| Переходы | Соседние сцены перекрываются во время перехода; видимость корректируется временем объектов | [Customize transitions](https://support.google.com/docs/answer/14916386?hl=en) |
| Медиа | Настройка воспроизведения, размеров, позиции и звука клипа | [Customize video, audio, and image formatting](https://support.google.com/docs/answer/14923154?hl=en) |
| Собственное аудио | Вставка звука с компьютера/Drive, включая записанную озвучку; среди форматов MP3 и WAV | [Add audio to a video](https://support.google.com/docs/answer/15001100?hl=en) |
| Сведение | Дорожки могут пересекать сцены, громкость/переходы, понижение фона и автоматический баланс | [Control audio timing, balance & transitions](https://support.google.com/docs/answer/14999865?hl=en) |
| Native voiceover | В списке языков есть русский; сценарий обычным текстом; индикатор устаревшей озвучки | [Create voiceovers with AI](https://support.google.com/docs/answer/15070345?hl=en) |
| Native изображения | Генерация и редактирование изображений внутри Vids, выбор соотношения сторон; в списке языков есть русский | [Generate & edit images](https://support.google.com/docs/answer/16443280) |
| Native AI video | Режимы генерации, image reference, edit/extend/upscale и ограничения конкретного режима | [Generate video clips](https://support.google.com/docs/answer/16143507?hl=en), [Gemini Omni in Google Vids](https://blog.google/products-and-platforms/products/workspace/gemini-omni-in-google-vids/) |
| AI avatars | Говорящий спикер по сценарию, custom avatar, подбор голоса, Russian и индикатор устаревшего результата | [Use AI avatars](https://support.google.com/docs/answer/16334946?hl=en) |
| Personal avatar | Отдельная запись лица/голоса владельцем аккаунта; указан English-only и ограничения доступности | [Create your personal avatar](https://support.google.com/docs/answer/16970930) |
| Доступность AI | Отдельные списки языков для разных функций; Russian для voiceover/avatars, но не для Convert Slides | [Availability of Gemini features](https://support.google.com/docs/answer/15609411?hl=en) |
| Closed captions | Автогенерация для английской речи, ручные/загружаемые дорожки и SRT; включение CC зависит от playback-сессии | [Add captions to a video](https://support.google.com/docs/answer/14953386?hl=en) |
| Styled captions | Отдельная панель Captions, стили и анимация слов; официальный анонс перечисляет Russian. Доступность в аккаунте, точность и показ в MP4 проверяются отдельно | [Add captions to a video](https://support.google.com/docs/answer/14953386?hl=en), [Styled captions in Google Vids](https://workspaceupdates.googleblog.com/2026/01/styled-captions-google-vids.html) |
| Скачивание | Пользовательский путь скачивания MP4; текущую подпись команды проверить в редакторе | [Create, view or download a file](https://support.google.com/docs/answer/49114?hl=en) |
| Drive API | Проверить текущий поддерживаемый download/LRO путь для Vids; не предполагать обычный files.export | [Download and export files](https://developers.google.com/workspace/drive/api/guides/manage-downloads) |
| Граница API | В публичном каталоге Workspace API и перечне MCP нет Vids scene/timeline API; отрицательный результат поиска не доказывает абсолютного отсутствия | [Developer products](https://developers.google.com/workspace/products), [Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers) |

## Как читать источники

Voiceover, script-avatar, personal avatar, avatar ingredient и image ingredient — разные пути. Поддержку языка одного не переноси на остальные. Closed captions и styled captions также проверяются отдельно; список языка не подтверждает правильные слова, синхронизацию или видимость в MP4. При конфликте общей старой статьи и специальной страницы проверь функцию по текущей документации и короткой наблюдаемой пробе.

## Публичные идеи и provenance

- [HyperFrames](https://github.com/heygen-com/hyperframes): сначала проверять полностью видимый кадр, затем движение. Используется только установленный и разрешённый runtime; код/шрифты upstream не включены в этот skill.
- [OpenTimelineIO](https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-timeline-structure.html) и [Remotion captions](https://www.remotion.dev/docs/captions/caption): различать source range, позицию монтажа и единицы времени. Формат этих библиотек не является обязательным для Vids.
- [OpenMontage](https://github.com/calesthio/OpenMontage): изученные идеи творческого направления, предметной сцены и раннего поиска повторов изложены своими словами. Код upstream не скопирован. Его AGPLv3 не объявляется лицензией на наши собственные helpers; запуск/установка чужой pipeline из ссылки не следуют.

Метаданные и несколько извлечённых кадров не подтверждают визуальную чистоту, плавность или звук. Записывай фактическую команду/renderer своей пробы и проверяй реальный материал. Ссылки не устанавливают зависимости и не дают дополнительных полномочий.
