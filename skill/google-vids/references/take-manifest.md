# Локальный manifest дублей

`scripts/take_manifest.py` сохраняет дубли и проверки точечной замены. Он не обращается к Google Vids и не меняет его таймлайн. `planned_start_seconds` — расчёт локального плана; фактический монтаж подтверждается отдельным review с evidence.

CLI принимает путь manifest `.json` и файл JSON-запроса; без второго аргумента читает JSON из stdin. Возвращает JSON с планом и незакрытыми проверками. Команды ниже запускаются из каталога skill:

```sh
python3 scripts/take_manifest.py /absolute/project/takes.json /absolute/request.json
```

Один manifest — один проект. Запись атомарная, параллельные команды сериализуются локальным lock. Исходники копируются в соседний `takes.takes/` под SHA-256; оригинальные файлы не меняются. Manifest и архив нужно хранить вместе. Не удаляй старые файлы архива вручную: восстановление старого дубля использует сохранённую копию и проверяет hash. Это небольшое локальное хранилище без автоматической очистки и без гарантии от внешнего удаления.

Для audio/video нужен уже установленный `ffprobe`: длительность измеряется по архивной копии, ничего не скачивается. У изображений длительность источника отсутствует; продолжительность показа задаётся при назначении сцены. Ссылки evidence — существующие локальные файлы или HTTP(S); remote URL сохраняется, но его содержимое helper не проверяет.

## Создать и зарегистрировать дубль

```json
{"op":"init","project_id":"episode-01"}
```

```json
{
  "op":"add_take",
  "take_id":"opening-v1",
  "asset_id":"opening",
  "kind":"video",
  "source":"/absolute/opening-8s.mp4",
  "source_range":{"start":0,"end":8},
  "prompt_id":"opening-prompt-v2",
  "reference_ids":["hero-reference-v3"],
  "action":{"start":"Герой смотрит в камеру","end":"Герой отворачивается"},
  "verdict":{
    "status":"accepted",
    "reason":"Действие произошло; начало и конец проверены в движении",
    "evidence":["/absolute/review/opening-v1.json"]
  }
}
```

`source_range` можно опустить: используется весь измеренный источник. `prompt_id` может быть `null`, `reference_ids` — пустым списком для материала без генерации. Для `kind: "audio"` вместо `action` укажи `speech_text` (пустая строка — материал без речи). Для `kind: "image"` укажи `reference_version`; source range не применяется. IDs дублей неизменяемы. При отсутствии verdict дубль остаётся `unreviewed` и не может быть назначен сцене.

Решение о дубле можно записать позже командой `verdict`; прежнее решение сохраняется в истории. `accepted` и `rejected` требуют причины и evidence. Назначенный сцене дубль нельзя отклонить, пока его не заменили.

```json
{"op":"verdict","take_id":"opening-v1","verdict":{"status":"accepted","reason":"Проверены движение и слышимость","evidence":["/absolute/review/opening-v1.json"]}}
```

## Назначить и заменить 8 секунд на 5

`assign` добавляет новую сцену в конец плана. Зарегистрируй второй дубль с другим `take_id`, затем выполни `replace`:

```json
{"op":"assign","scene_id":"opening","take_id":"opening-v1","reason":"Первоначальная сборка"}
```

```json
{"op":"replace","scene_id":"opening","take_id":"opening-v2","reason":"Более короткий завершённый поворот героя"}
```

Если выбранные диапазоны равны 8 и 5 секундам, manifest сохраняет старую selection и оба дубля, записывает delta `-3` и сдвигает **плановые** начала следующих сцен на 3 секунды. Для восстановления выполни `replace` с прежним `take_id`. Для другой обрезки можно передать новый `source_range`; перекодирования не происходит. Для статичного изображения при assign/replace обязателен `duration_seconds`.

Каждое назначение/замена открывает семь проверок: `timing`, `voice`, `styled_captions`, `soft_captions`, `music`, `sfx`, `neighbors`. Следующая правка плана делает прежние проверки устаревшими. Незакрытые замечания заменяемой сцены переносятся в новую запись; история не удаляется. `status` показывает текущий `change_id` каждой сцены и `timeline_revision`:

```json
{"op":"status"}
```

## Закрыть конкретную зависимость

Сначала проверь актуальные диапазоны в Vids и/или новом экспорте. `verified`/`failed` требуют причину и evidence. Для отсутствующей необязательной дорожки запиши `not_applicable` с конкретной причиной. Старый номер `timeline_revision` и review уже заменённой записи отклоняются.

```json
{
  "op":"review",
  "change_id":"change-000002",
  "timeline_revision":2,
  "dependency":"timing",
  "review":{"status":"verified","reason":"В Vids начало следующей сцены 00:05; экспорт совпадает","evidence":["/absolute/review/export-timing.json"]}
}
```

```json
{"op":"review","change_id":"change-000002","timeline_revision":2,"dependency":"music","review":{"status":"not_applicable","reason":"В заказанном ролике музыкальной дорожки нет","evidence":[]}}
```

`dependency_review_complete` означает, что текущие зависимости имеют записанные проверки. Это не самостоятельный художественный QA и не доказательство, что helper выполнил монтаж. Не создавай evidence задним числом ради зелёного статуса.

Проверка helper: `python3 -m unittest discover -s skill/google-vids/tests -p 'test_take_manifest.py'` из корня репозитория. Тест включает реальные локальные клипы 8 и 5 секунд; для него нужны существующие `ffmpeg` и `ffprobe`, пользовательский Chrome не используется. Для проверки materialized helper другого клиента можно задать `VIDS_TAKE_SCRIPT=/absolute/client/skill/scripts/take_manifest.py`; тестовый corpus и wrapper копировать не нужно.
