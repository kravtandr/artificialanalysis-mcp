# ТЗ: MCP-сервер Artificial Analysis

Версия 1.2 · 2026-07-10 · Статус: утверждено к разработке

## 1. Цель

MCP-сервер, который даёт AI-агентам (Claude Desktop, Claude Code, Cursor и др.)
доступ к данным [Artificial Analysis Data API v2](https://artificialanalysis.ai/data-api/docs)
для **подбора моделей под запрос пользователя**: «найди самую дешёвую модель с
intelligence index выше 40», «сравни gpt-oss-20b и llama-4», «какая лучшая
text-to-image модель», «что быстрее по TTFT среди open-weights».

Ключевая ценность — не проксирование эндпоинтов, а **поиск и фильтрация**:
сервер скачивает и кэширует полные списки моделей, а фильтрацию, сортировку и
сравнение выполняет локально. Это одновременно решает проблему жёсткого
rate limit (Free: 100 запросов/день) и экономит токены клиента.

## 2. Контекст API (из `artificial-analysis-openapi.yaml`)

- База: `https://artificialanalysis.ai`, аутентификация — заголовок `x-api-key`.
- Тарифы: **Free** (только `/free`-эндпоинты, 100 req/день), **Pro** (полные
  model-level эндпоинты, 500 req/день), **Commercial** (провайдеры,
  performance over time, measurements).
- Каждый ответ несёт заголовки `X-AA-Tier`, `X-RateLimit-Limit/-Remaining/-Reset`;
  `429` несёт `Retry-After`. `X-RateLimit-Reset` — Unix timestamp (секунды).
  Исключение: ответ `401` заголовка `X-AA-Tier` не несёт; `403` — несёт
  (тариф можно уточнять и из ответов-ошибок).
- Pro-эндпоинты `/language/models`, `/language/models/{slug}` принимают
  `prompt_type` (default `long` = 10k input-токенов) — от него зависят все
  performance-метрики. **v1 параметр не экспонирует** и живёт на дефолте;
  это зафиксировано, чтобы фильтры по скорости/TTFT сравнивали сравнимое.
  Free-эндпоинты `prompt_type` не принимают — их пресет фиксирован на стороне AA.
- Free-форма записи LLM: name, slug, release_date, creator, три индекса
  (intelligence/coding/agentic), цены input/output/cache за 1M токенов,
  медианные скорость/TTFT/E2E. Pro добавляет: полный набор бенчмарков,
  blended-цены, перцентили производительности, context window, параметры,
  модальности, open weights. Commercial добавляет providers на detail-эндпоинте.
  Pro-поля в OpenAPI могут быть опциональными/отсутствующими, поэтому zod-схемы
  на границе обязаны принимать `undefined` там, где поле не входит в `required`.
- Пагинация (`page`, page_size 200, `pagination.has_more`) есть **только у
  language-эндпоинтов**; все 22 медиа-эндпоинта возвращают полный список одним
  ответом. У части paid media-эндпоинтов есть query-параметры
  `include_categories`/`include_genres`; v1 их не использует.
- `null` в данных означает «не измерено», а не ноль.
- **Лицензия обязывает указывать атрибуцию** — каждый ответ инструмента
  должен содержать ссылку на Artificial Analysis как источник.

Текущий ключ проекта — тариф **Free** (проверено 2026-07-10), но сервер
проектируется tier-aware и автоматически задействует Pro/Commercial-эндпоинты,
если ключ это позволяет.

## 3. Стек и архитектура

| Решение | Выбор |
| --- | --- |
| Язык | TypeScript (strict), Node.js ≥ 20, ESM |
| MCP SDK | `@modelcontextprotocol/sdk` (официальный) |
| Валидация | `zod` — входные схемы инструментов и ответы API на границе |
| HTTP-клиент | встроенный `fetch` (undici), без axios |
| Типы API | генерируются из `artificial-analysis-openapi.yaml` через `openapi-typescript` (`npm run generate:types` → `src/api/types.gen.ts`, коммитится) |
| Сборка | `tsup` → `dist/`, bin `artificialanalysis-mcp` |
| Тесты | `vitest` + `undici` MockAgent, фикстуры из примеров OpenAPI |
| Линт/формат | ESLint (typescript-eslint, flat config) + Prettier |
| Пакет | npm: `artificialanalysis-mcp`; Docker-образ не публикуется — сборка из исходников через `docker compose up -d --build` |

### 3.1 Слои

```
src/
  index.ts            # entry: парсинг env, выбор транспорта, запуск
  server.ts           # создание McpServer, регистрация инструментов, instructions
  transport/
    stdio.ts          # StdioServerTransport
    http.ts           # Streamable HTTP: POST /mcp (stateless), GET /healthz
  api/
    client.ts         # AAClient: auth, ретраи, учёт rate limit, определение тарифа
    types.gen.ts      # сгенерировано из OpenAPI — руками не править
    schemas.ts        # zod-схемы ответов (подмножество нужных полей)
  cache.ts            # in-memory TTL-кэш, ключ = URL, «скачать все страницы»
  catalog.ts          # доменный слой: нормализованный каталог LLM и медиа-моделей
  match.ts            # фильтрация, сортировка, fuzzy-поиск по имени/slug
  tools/
    find-models.ts
    get-model.ts
    compare-models.ts
    list-media-models.ts
    get-api-status.ts
  format.ts           # markdown-таблицы + structuredContent, атрибуция
tests/
  fixtures/           # JSON-ответы API (из примеров OpenAPI или санитизированные вручную)
  *.test.ts
```

### 3.1.1 Нормализованные доменные модели

`catalog.ts` преобразует разные формы AA API в внутренние модели. Инструменты и
`match.ts` работают только с нормализованными типами, а не с сырыми ответами API.

- `NormalizedLlmModel`: `id`, `name`, `slug`, `creator`, `release_date`,
  headline-индексы, цены, performance-медианы и опциональные Pro/Commercial-поля
  (`reasoning_model`, `context_window_tokens`, `modalities`,
  `is_open_weights`, `providers` и т. п.). Отсутствующее Pro-поле и `null` —
  разные состояния: отсутствующее поле значит «не входит в форму ответа/тариф»,
  `null` значит «не измерено/не задано».
- `NormalizedMediaModel`: `id`, `name`, `slug?`, `creator`, `category`,
  `score_kind`, `score_value`, `score_direction`, `ci_95?`, `price_fields`,
  `release_date?`, `is_open_weights?`, `raw_metrics`. `slug` отсутствует у
  `speech-to-text` и music-эндпоинтов по OpenAPI, поэтому он всегда optional.
- `score_kind` фиксирует метрику сортировки/показа: `elo`, `aa_wer_index`,
  `tau_voice_score`, `bba_score` и т. п. `score_direction` = `asc` для WER и
  `desc` для метрик, где больше лучше.
- `price_fields` — словарь доступных ценовых полей без унификации единиц
  (`price_per_1k_images`, `price_per_minute`, `price_per_1m_characters`,
  `price_per_hour_input`, `price_per_1k_minutes` и т. п.). Инструменты
  показывают единицу измерения вместе с полем и не сравнивают цены разных
  категорий между собой.

### 3.2 Клиент API (`AAClient`)

- Все запросы — через единственный метод `get(path, params)`: подставляет
  `x-api-key`, парсит rate-limit-заголовки, обновляет внутренний счётчик бюджета.
- **Таймаут**: каждый запрос — с `AbortSignal.timeout(30_000)`
  (env `AA_REQUEST_TIMEOUT_MS`, по умолчанию 30000). Таймаут = сетевая ошибка
  (ретрай по общему правилу), без него зависший запрос к AA вешает вызов
  инструмента у клиента.
- **Определение тарифа**: лениво, при первом обращении, запросом
  `GET /api/v2/language/models/free?page=1`; тариф берётся из заголовка
  `X-AA-Tier` и кэшируется на всё время жизни процесса. Этот запрос — ровно
  первая страница прогрева каталога LLM, поэтому она передаётся в сборщик
  полного каталога как уже полученная first page; под ключ категории в кэш
  кладётся только полный массив после докачки остальных страниц. Повторного
  запроса page 1 быть не должно. `X-AA-Tier` из любого последующего ответа
  (включая ошибки, кроме `401`) уточняет закэшированный тариф.
  Переопределение для тестов: env `AA_TIER`.
- **Tier-aware маршрутизация**: для каждой категории есть пара путей
  (полный / `/free`). Клиент выбирает по тарифу; если полный путь неожиданно
  вернул `403` — одноразовый фолбэк на `/free` и понижение закэшированного тарифа.
- **Ошибки**:
  - `401` → ошибка инструмента: «неверный/отсутствующий ARTIFICIAL_ANALYSIS_API_KEY».
  - `403` → фолбэк на `/free`; если и он недоступен — ошибка с объяснением тарифа.
  - `429` → типизированная ошибка «дневная квота исчерпана, сброс в <время UTC
    из X-RateLimit-Reset>»; автоматических ретраев нет (квота суточная, ждать
    бессмысленно).
  - `5xx` / сетевые → один ретрай с задержкой 500 мс, затем типизированная
    ошибка.
  - `AAClient` только классифицирует ошибки. Решение «вернуть stale-копию или
    пробросить ошибку инструмента» принимает слой `catalog.ts`/`cache.ts`
    согласно §3.3.
- Ключ **никогда не логируется** и не попадает в тексты ошибок.

### 3.3 Кэш и бюджет запросов

- In-memory TTL-кэш (по умолчанию 21600 с = 6 ч, env `AA_CACHE_TTL_SECONDS`).
  Данные бенчмарков меняются не чаще раза в день; часовой TTL при 12 категориях
  (LLM + 11 медиа) мог бы съедать до ~288 запросов/день у долгоживущего
  HTTP-сервера — втрое больше Free-квоты. 6 часов держат худший случай
  в пределах ~50 запросов/день.
- Кэшируется полный список категории: для language-эндпоинтов клиент проходит
  все страницы (`has_more`, предохранитель — максимум 10 страниц) и складывает
  единый массив; медиа-эндпоинты не пагинируются — один запрос на категорию.
  Если после 10 страниц `pagination.has_more=true`, каталог считается
  неполным: свежий результат не кэшируется как валидный полный снимок, а
  инструмент возвращает ошибку с диагностикой `catalog_truncated`; при наличии
  прежней stale-копии можно вернуть её с предупреждением.
- **Записи по истечении TTL не удаляются, а помечаются устаревшими**
  (stale-while-error). Протухшая запись не отдаётся при живом API — сначала
  попытка обновления; но если API недоступен (`429`/`5xx`/сеть), отдаётся
  stale-копия с пометкой «данные от <время UTC>» в тексте и полем
  `data_as_of` + `stale: true` в structuredContent. Если stale-копии нет,
  ошибка `429`/`5xx`/сеть пробрасывается как ошибка инструмента. Наивный TTL-кэш
  с удалением по expiry это требование молча ломает — поэтому оно инвариант.
- **Дедупликация in-flight**: параллельные промахи по одному ключу кэша
  (два инструмента разом, два HTTP-запроса) коалесцируются в один сетевой
  запрос — в кэше живёт промис загрузки, а не только результат. При квоте
  100/день это обязательное требование, а не оптимизация.
- Один «прогрев» каталога LLM = 2–3 запроса (первый совмещён с определением
  тарифа); все последующие вызовы инструментов в течение TTL не тратят квоту.
- Если `X-RateLimit-Remaining` < 5 — в каждый ответ инструмента добавляется
  предупреждение о почти исчерпанной квоте.

### 3.4 Транспорты

- **stdio** (по умолчанию) — для локальных клиентов. Логи строго в stderr:
  stdout зарезервирован протоколом.
- **Streamable HTTP** (`MCP_TRANSPORT=http`) — stateless-режим SDK,
  `POST /mcp`, порт из `PORT` (3000), хост из `MCP_HTTP_HOST`
  (**по умолчанию `127.0.0.1`** — наружу только осознанно; в Docker-образе
  выставлен `0.0.0.0`). `GET /healthz` → `200 {"status":"ok"}` (без авторизации).
- **Синглтоны уровня процесса**: в stateless-режиме SDK создаёт server/transport
  на каждый POST — поэтому `AAClient` (тариф, счётчик квоты), кэш и каталог
  живут **вне** MCP-обвязки и создаются один раз при старте процесса.
  Request-scoped — только McpServer/transport. Иначе каждый запрос заново
  определял бы тариф и грел каталог, сжигая квоту.
- Защита HTTP:
  - если задан `MCP_AUTH_TOKEN` — на `/mcp` требуется
    `Authorization: Bearer <token>` (сравнение constant-time), иначе `401`;
  - без токена при bind не на loopback сервер пишет в stderr громкое
    предупреждение при старте: анонимный доступ = чужие руки на вашей квоте;
  - защита от DNS rebinding: запросы с заголовком `Origin`, отличным от
    локального, отклоняются `403` (рекомендация спецификации MCP для
    Streamable HTTP).
  - API-ключ AA живёт только на сервере и клиентам не виден.

## 4. Инструменты MCP

Общие требования:

- Входные схемы — zod с `.describe()` на каждом поле (описания видит LLM-клиент).
- Ответ = человекочитаемый markdown в `content` **и** `structuredContent`
  с машиночитаемыми данными (у каждого инструмента объявлен `outputSchema`).
- Каждый ответ завершается строкой атрибуции:
  `Source: Artificial Analysis (https://artificialanalysis.ai)` — требование лицензии.
- Числовые фильтры не пропускают записи с `null` в соответствующем поле.
- Ответы компактны: только запрошенные/значимые поля, без сырых дампов API.

### 4.1 `find_models` — главный инструмент подбора LLM

Вход (все поля опциональны):

| Поле | Тип | Описание |
| --- | --- | --- |
| `query` | string | Подстрока по имени/slug/создателю, без учёта регистра |
| `min_intelligence_index` | number | Порог AA Intelligence Index |
| `min_coding_index` | number | Порог AA Coding Index |
| `min_agentic_index` | number | Порог AA Agentic Index |
| `max_price_input_per_1m` | number | Максимум USD за 1M input-токенов |
| `max_price_output_per_1m` | number | Максимум USD за 1M output-токенов |
| `min_output_tokens_per_second` | number | Минимальная медианная скорость |
| `max_time_to_first_token_seconds` | number | Максимальный медианный TTFT |
| `creators` | string[] | Фильтр по создателям (OpenAI, Meta, …) |
| `released_after` | string (ISO-дата) | Только модели с `release_date` строго позже этой даты |
| `open_weights_only` | boolean | ⚠ Pro-поле; маппится на `licensing.is_open_weights` |
| `reasoning_only` | boolean | ⚠ Pro-поле; маппится на `reasoning_model` |
| `min_context_window_tokens` | number | ⚠ Pro-поле |
| `input_modalities` | ("text"\|"image"\|"video"\|"speech")[] | ⚠ Pro-поле |
| `sort_by` | enum: `intelligence_index` (default) \| `coding_index` \| `agentic_index` \| `price_input` \| `price_output` \| `output_speed` \| `ttft` \| `release_date` \| `best_value` | `best_value` = intelligence_index / цена по правилам ниже |
| `order` | `asc` \| `desc` | По умолчанию осмысленно для метрики (цена — asc, индексы — desc) |
| `limit` | number | По умолчанию 10, максимум 50 |

Правила `best_value`: на Pro+ при наличии `price_1m_blended_3_to_1`
используется он; иначе средняя цена = (price_1m_input + price_1m_output) / 2.
Если нужная цена `null`/отсутствует **или** цена ≤ 0 (данные-артефакт: делить
нельзя) — модель в этой сортировке уходит в конец списка, из результатов не
выбрасывается. Общее правило сортировок: записи с `null`/`undefined` в ключе
сортировки — всегда в конце, независимо от `order`.

Поведение: фильтрация по кэшированному каталогу. Если задан Pro-фильтр, а тариф
Free, — фильтр **не применяется молча**: он попадает в `unsupported_filters`
в structuredContent и в текстовое предупреждение, результаты возвращаются без него.

`structuredContent`: `{ tier, intelligence_index_version, data_as_of, stale, total_matched, unsupported_filters, warnings, models: [{ name, slug, creator, release_date, intelligence_index, coding_index, agentic_index, price_1m_input, price_1m_output, median_output_tps, median_ttft_s, ...pro-поля если есть }] }` (`data_as_of`/`stale` — см. §3.3, присутствуют во всех инструментах, читающих каталог).

### 4.2 `get_model` — карточка модели

Вход: `model: string` (slug или имя, допускается неточное).

- Точный slug + тариф Pro+ → `GET /api/v2/language/models/{slug}` (detail-карточка
  с расширенными бенчмарками и metadata; providers появляются только на
  Commercial, если API их вернул). Free → полная запись из кэша списка.
- Не найдено точно → fuzzy-поиск по каталогу. Правила резолва (общие для
  `get_model` и `compare_models`, реализуются в `match.ts`):
  1. Нормализация: нижний регистр, все символы кроме `[a-z0-9]` → пробел,
     схлопывание пробелов (`GPT-OSS 20B (high)` → `gpt oss 20b high`).
  2. Точное совпадение нормализованного запроса со slug или именем → уверенно.
  3. Ровно **одна** модель, у которой нормализованное имя/slug содержит запрос
     как подстроку либо содержит все токены запроса → уверенно, в ответе
     пометка `resolved_from: "<исходный запрос>"`.
  4. Несколько кандидатов → не уверенно: вернуть список (name + slug),
     отсортированный по intelligence_index desc, максимум 10, с просьбой
     уточнить. Ноль кандидатов → ошибка «модель не найдена» + подсказка
     про `find_models`.

### 4.3 `compare_models` — сравнение

Вход: `models: string[]` (2–5, каждый — slug/имя с тем же fuzzy-резолвом).

Ответ: markdown-таблица «метрика × модель» по индексам, ценам,
производительности (+ context window/модальности на Pro); в structuredContent —
те же данные массивом. Ненайденные имена перечисляются в `warnings`, сравнение
выполняется по найденным, если их ≥ 2. Если уверенно зарезолвлено < 2 —
ошибка инструмента с перечислением: что не найдено вовсе и какие кандидаты
есть у неоднозначных имён (по правилам fuzzy из §4.2).

### 4.4 `list_media_models` — медиа-арены

Вход:

- `category` (обязательно): `text-to-image` | `image-editing` | `text-to-video` |
  `image-to-video` | `text-to-video-audio` | `image-to-video-audio` |
  `text-to-speech` | `speech-to-speech` | `speech-to-text` |
  `music-instrumental` | `music-with-vocals`
- `query?: string` — подстрока по имени/создателю
- `limit?: number` — по умолчанию 10, максимум 50

Поведение: tier-aware выбор пути (`/models` vs `/models/free`), нормализация в
`NormalizedMediaModel`, сортировка по category-specific `score_kind`. Ответ —
топ моделей с метрикой, направлением сортировки, создателем и доступными
ценовыми полями. `slug` в ответе опционален, потому что в OpenAPI его нет у
`speech-to-text` и music.

Особые случаи:

- Категория → путь API — по таблице, а не конкатенацией (у music пути
  вложенные): `music-instrumental` → `/api/v2/media/music/instrumental/models`,
  `music-with-vocals` → `/api/v2/media/music/with-vocals/models`; остальные —
  `/api/v2/media/<category>/models`.
- `text-to-image`, `image-editing`, video-категории, `text-to-speech` и music:
  сортировка по `elo` **desc**.
- У `speech-to-text` Elo нет — сортировка по `aa_wer_index` **asc**
  (это word error rate: меньше = лучше, 0 — идеал; перепутать направление —
  выдать худшие модели за лучшие). `null` — в конец.
- У `speech-to-speech` Elo нет — сортировка по первому доступному score в
  порядке `tau_voice_score` **desc**, `bba_score` **desc**, `fdb_score` **desc**.
  Если у модели все три score `null`, она уходит в конец.

### 4.5 `get_api_status` — диагностика

Без входа. Возвращает: тариф ключа, версию Intelligence Index, остаток и время
сброса rate limit (из последних полученных заголовков), состояние кэша
(какие категории прогреты, возраст). Не тратит квоту, если тариф уже определён.
На холодном старте может потратить один запрос на определение тарифа; это
должно быть явно отражено в markdown-ответе и `warnings`.

### 4.6 Этап 3 (по мере доступа к тарифам, в v1 не реализуются)

- `list_providers`, `get_provider` — Commercial-эндпоинты провайдеров.
- MCP-ресурс `aa://llms/snapshot` — полный снимок каталога.
- `/api/v2/critpt/evaluate` — **вне охвата навсегда** (это сервис грейдинга, не данные).

## 5. Конфигурация (env)

| Переменная | Обязательна | По умолчанию | Назначение |
| --- | --- | --- | --- |
| `ARTIFICIAL_ANALYSIS_API_KEY` | да | — | Ключ AA Data API |
| `AA_BASE_URL` | нет | `https://artificialanalysis.ai` | Переопределение для тестов |
| `AA_CACHE_TTL_SECONDS` | нет | `21600` | TTL кэша каталогов (см. §3.3) |
| `AA_REQUEST_TIMEOUT_MS` | нет | `30000` | Таймаут запроса к AA API |
| `AA_TIER` | нет | автоопределение | Принудительный тариф (тесты) |
| `MCP_TRANSPORT` | нет | `stdio` | `stdio` \| `http` |
| `PORT` | нет | `3000` | Порт HTTP-транспорта |
| `MCP_HTTP_HOST` | нет | `127.0.0.1` | Bind-хост HTTP-транспорта (в Docker — `0.0.0.0`) |
| `MCP_AUTH_TOKEN` | нет | — | Bearer-токен для HTTP-режима |
| `LOG_LEVEL` | нет | `info` | `debug`\|`info`\|`warn`\|`error`, вывод в stderr |

Отсутствие `ARTIFICIAL_ANALYSIS_API_KEY` — немедленный выход при старте с
понятным сообщением (не при первом вызове инструмента).

## 6. Тестирование

- **Unit**: `match.ts` (фильтры, сортировки, fuzzy, null-семантика), `cache.ts`
  (TTL, многостраничная сборка, first-page seed, stale-while-error), `format.ts`.
- **Интеграционные**: инструменты через `InMemoryTransport` SDK против
  замоканного API (undici MockAgent + фикстуры). Обязательные сценарии:
  tier-фолбэк 403→/free; 429 после истечения TTL → отдаётся stale-копия с
  `stale: true`; 429/5xx без stale → ошибка; Pro-фильтр на Free-тарифе;
  неоднозначный fuzzy-резолв; `list_media_models` для `speech-to-speech` без Elo,
  `speech-to-text` без slug, music без slug; language pagination >10 страниц;
  `compare_models` с <2 зарезолвленными; два параллельных вызова при холодном
  кэше → ровно один сетевой запрос (дедупликация in-flight); таймаут запроса.
- **Smoke** (`npm run smoke`): запуск собранного `dist/index.js`, MCP-handshake
  `initialize` + `tools/list` через stdio, проверка списка из 5 инструментов.
  Работает без реального ключа (фиктивный ключ, без сетевых вызовов).
- Реальный API в CI не вызывается никогда (квота 100/день).
- Порог: покрытие `match.ts` и `api/client.ts` ≥ 90 %.

## 7. CI/CD (GitHub Actions)

### 7.1 `ci.yml` — на PR и push в main

1. Node 20 и 22 (matrix): `npm ci` → `lint` → `typecheck` → `test` → `build` → `smoke`.
2. Проверка синхронности типов: `npm run generate:types` не должен давать diff.
3. Сборка Docker-образа без push (валидация Dockerfile).

### 7.2 `release.yml` — на тег `v*`

1. Проверка: тег совпадает с `version` в `package.json`, полный прогон тестов.
2. Публикация в npm с provenance (OIDC; секрет `NPM_TOKEN`).
3. GitHub Release с автогенерированными заметками.

Предсобранный Docker-образ не публикуется: деплой — сборка из исходников на
сервере (`docker compose up -d --build`, см. README). Шаги 2→3 выполняются
**последовательно** (npm — самый «неоткатываемый» шаг, он идёт первым). Шаг 3
идемпотентен: повторный запуск workflow по тому же тегу не падает
(release создаётся только если ещё не существует).

Имя `artificialanalysis-mcp` на npm свободно (проверено 2026-07-10).
Пакет и README обязаны явно называться **unofficial**: проект не аффилирован
с Artificial Analysis, данные — их (атрибуция по лицензии, §2).

Версионирование — SemVer; до 1.0.0 минорные версии могут ломать API инструментов.

## 8. Definition of Done (v0.1.0)

- [ ] Каркас проекта по структуре §3.1, `npm run` скрипты: `build`, `dev`,
      `lint`, `typecheck`, `test`, `smoke`, `generate:types`.
- [ ] `AAClient` с определением тарифа, фолбэком, учётом квоты, ретраем 5xx.
- [ ] Кэш с постраничной сборкой, TTL, stale-while-error и дедупликацией
      in-flight (§3.3).
- [ ] Пять инструментов §4.1–4.5 со схемами, structuredContent и атрибуцией.
- [ ] Оба транспорта; в stdio-режиме stdout чист от логов; HTTP — bind на
      `127.0.0.1` по умолчанию, предупреждение при внешнем bind без токена.
- [ ] Тесты §6 зелёные, покрытие достигнуто.
- [ ] CI зелёный; релиз по тегу публикует npm-пакет и образ в GHCR.
- [ ] `LICENSE` (MIT) в корне + поле `license` в `package.json`
      (без него `npm publish` неполноценен).
- [ ] README: установка (`npx artificialanalysis-mcp`), конфиг для
      Claude Desktop/Claude Code, Docker-запуск, атрибуция AA, ограничения
      тарифов, пометка «unofficial», предупреждение о запуске HTTP-режима
      без `MCP_AUTH_TOKEN`.
- [ ] `.env` в `.gitignore`; `.env*` в `.dockerignore`; в репозитории —
      `.env.example` без значений.

## 9. Вне охвата v1

- Персистентный кэш на диске (только память процесса).
- CritPt evaluate, Commercial-эндпоинты (этап 3).
- Собственный скоринг «подходимости» сверх фильтров/`best_value` — решение о
  выборе модели принимает LLM-клиент на основе выданных данных.
- OAuth для HTTP-транспорта (достаточно Bearer-токена).
