# artificialanalysis-mcp v0.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP-сервер (TypeScript/Node ≥ 20, ESM) для подбора AI-моделей через Artificial Analysis Data API v2 — 5 инструментов, кэш с stale-while-error, tier-aware клиент, stdio + Streamable HTTP.

**Architecture:** Слои `tools/*` → `catalog.ts` (нормализация) → `api/client.ts` (HTTP, тариф, квота) поверх `cache.ts` (TTL + stale + дедупликация). Фильтры/сортировки/fuzzy — в `match.ts`, форматирование — в `format.ts`. Синглтоны уровня процесса; MCP-обвязка request-scoped в HTTP-режиме.

**Tech Stack:** `@modelcontextprotocol/sdk`, `zod` (v3 API), встроенный `fetch` (инъекция `fetchImpl` для тестов), `tsup`, `vitest` + undici MockAgent, `openapi-typescript`, ESLint flat + Prettier.

## Global Constraints (из SPEC.md/AGENTS.md — действуют в каждой задаче)

- TypeScript strict, ESM, Node ≥ 20; `any` запрещён; на границах — zod.
- stdout в stdio-режиме принадлежит MCP; все логи — stderr.
- Реальный API в тестах не вызывается никогда.
- `null` = «не измерено» ≠ 0: числовые фильтры не пропускают null; в сортировках null/undefined в конце независимо от order.
- Каждый ответ инструмента заканчивается `Source: Artificial Analysis (https://artificialanalysis.ai)`.
- Ключ API не логируется и не попадает в тексты ошибок.
- Кэш не удаляет протухшие записи (stale-while-error), in-flight дедупликация обязательна.
- Каждый fetch — с `AbortSignal.timeout(AA_REQUEST_TIMEOUT_MS default 30000)`.
- `src/api/types.gen.ts` только генерируется (`npm run generate:types`), коммитится.
- Conventional Commits; перед каждым коммитом зелёные lint/typecheck/test/build.
- Отсутствие `ARTIFICIAL_ANALYSIS_API_KEY` — немедленный выход при старте.
- Дефолты env: TTL 21600 c, timeout 30000 мс, transport stdio, PORT 3000, host 127.0.0.1 (Docker — 0.0.0.0), LOG_LEVEL info.

---

### Task 0: Git-инициализация

- [ ] Initial commit на `main` с уже существующими файлами (SPEC.md, AGENTS.md, OpenAPI, CI, Dockerfile, LICENSE, .env.example, .gitignore, .dockerignore, план).
- [ ] Ветка `feat/mcp-server-v1` — вся работа в ней, PR в main в конце.

### Task 1: Каркас проекта

**Files:** `package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `tsup.config.ts`, `vitest.config.ts`, `src/api/types.gen.ts` (генерат).

- `package.json`: name `artificialanalysis-mcp`, version `0.1.0`, `"type":"module"`, `bin: {"artificialanalysis-mcp":"dist/index.js"}`, `engines.node >=20`, `license: MIT`, `files: ["dist"]`, ключевые слова + описание с пометкой unofficial.
- Скрипты: `build` (tsup), `dev` (tsx watch src/index.ts), `lint` (eslint . && prettier --check .), `typecheck` (tsc --noEmit), `test` (vitest run), `smoke` (node scripts/smoke.mjs), `generate:types` (openapi-typescript artificial-analysis-openapi.yaml -o src/api/types.gen.ts).
- Deps: `@modelcontextprotocol/sdk`, `zod@^3`. DevDeps: typescript, tsup, tsx, vitest, @vitest/coverage-v8, openapi-typescript, eslint, typescript-eslint, prettier, eslint-config-prettier, undici, @types/node.
- tsup: entry `src/index.ts`, format esm, target node20, `banner: { js: '#!/usr/bin/env node' }`.
- vitest: coverage v8, thresholds per-file ≥90 % для `src/match.ts` и `src/api/client.ts`.
- [ ] `npm run generate:types` → закоммитить `types.gen.ts`.
- [ ] Проверка: lint, typecheck, build зелёные (test — `--passWithNoTests` не включать; тесты появятся в Task 2). Commit `chore: project scaffolding`.

### Task 2: config + logger

**Files:** `src/config.ts`, `src/logger.ts`, `tests/config.test.ts`.

**Produces:** `loadConfig(env: NodeJS.ProcessEnv): AppConfig` — бросает `ConfigError` без ключа; `AppConfig = { apiKey, baseUrl, cacheTtlSeconds, requestTimeoutMs, tierOverride?, transport: 'stdio'|'http', port, httpHost, authToken?, logLevel }`. `createLogger(level): Logger` — `debug/info/warn/error`, всё в `process.stderr`, ключ никогда не подставляется.

- [ ] TDD: тесты на дефолты, переопределения, ошибку без ключа, невалидные числа → дефолт или ошибка (числа: невалидное значение = ConfigError, явно). Commit `feat: env config and stderr logger`.

### Task 3: zod-схемы ответов API + фикстуры

**Files:** `src/api/schemas.ts`, `tests/fixtures/*.json`, `tests/schemas.test.ts`.

Схемы (подмножество нужных полей, `.passthrough()` не нужен — `.strip()` по умолчанию):
- `llmModelSchema`: id, name, slug, release_date (string|null), model_creator ({id,name}|null), evaluations (3 индекса number|null), pricing (input/output/cache_hit/cache_write number|null + **optional** blended_3_to_1/blended_7_to_2_to_1), performance (медианы number|null, остальное игнорируем), **optional** Pro-поля: reasoning_model (boolean), context_window_tokens (number|null), parameters ({total, active}|null), modalities ({input,output} из boolean|null), licensing ({is_open_weights}), providers (array, optional — Commercial detail). Pro-поля не в `required` OpenAPI → `.optional()`.
- `llmListResponseSchema`: { tier, intelligence_index_version: number, pagination: {page,page_size,total_pages,has_more}, data: llmModel[] }.
- `llmDetailResponseSchema`: { tier, intelligence_index_version, data: llmModel }.
- Медиа: `mediaImageVideoItemSchema` (elo обязателен; slug обязателен; optional rank/samples/release_date/price_per_1k_images/price_per_minute/open_weights_url), `ttsItemSchema` (slug, elo, optional price_per_1m_characters), `stsItemSchema` (slug, bba_score/fdb_score/tau_voice_score number|null, optional providers), `sttItemSchema` (**без slug**, aa_wer_index number|null, optional open_weights boolean|null, providers), `musicItemSchema` (**без slug**, elo). Обёртка `mediaListResponseSchema(item)`: { tier, data: item[] }.
- Фикстуры: свободная страница LLM (из примера OpenAPI, 3–4 модели с разными null), pro-страница, детальная карточка, по фикстуре на каждый тип медиа.
- [ ] TDD: parse фикстур; отклонение мусора. Commit `feat: zod schemas for AA API responses`.

### Task 4: cache.ts

**Files:** `src/cache.ts`, `tests/cache.test.ts`.

**Produces:**
```ts
class TtlCache {
  constructor(ttlSeconds: number, now: () => number = Date.now)
  // loader выбрасывает AAApiError; staleEligible решает, можно ли отдать stale при этой ошибке
  async getOrLoad<T>(key: string, loader: () => Promise<T>, staleEligible: (e: unknown) => boolean):
    Promise<{ value: T; dataAsOf: Date; stale: boolean }>
  inspect(): Array<{ key: string; ageSeconds: number; stale: boolean }>
}
```
Алгоритм: fresh → вернуть. Иначе если есть in-flight промис — await его (дедупликация; промис кладётся в Map ДО первого await). Иначе запустить loader: успех → записать entry {value, fetchedAt}, вернуть fresh; ошибка → in-flight убрать; если `staleEligible(e)` и есть старая запись → вернуть её со `stale: true`, иначе rethrow. Записи никогда не удаляются по TTL. Результат in-flight промиса разделяется всеми ожидающими; ошибка in-flight у каждого ожидающего проходит свой stale-фолбэк.

- [ ] TDD (fake now + deferred-промисы): hit fresh; истёкший TTL + живой loader → обновление; истёкший TTL + ошибка eligible → stale-копия `stale:true`; ошибка not-eligible → rethrow; промах без stale + ошибка → rethrow; два параллельных вызова → loader один раз; inspect(). Commit `feat: TTL cache with stale-while-error and in-flight dedup`.

### Task 5: api/errors.ts + api/client.ts

**Files:** `src/api/errors.ts`, `src/api/client.ts`, `tests/client.test.ts`.

**Produces:**
```ts
type Tier = 'free' | 'pro' | 'commercial';
class AAApiError extends Error {
  kind: 'auth'|'forbidden'|'rate_limited'|'server_error'|'network'|'not_found'|'catalog_truncated';
  resetAt?: Date;      // для rate_limited из X-RateLimit-Reset (unix сек) либо Retry-After
}
class AAClient {
  constructor(opts: { apiKey; baseUrl; timeoutMs; tierOverride?: Tier; logger; fetchImpl?: typeof fetch })
  async getTier(): Promise<Tier>                       // лениво; GET /language/models/free?page=1; кэш на процесс
  get tierIfKnown(): Tier | undefined
  takeLlmFreeSeedPage(): unknown | undefined            // тело page1 из детекции тарифа, потребляется один раз
  async getJson(path: string, params?: Record<string,string|number>): Promise<unknown> // низкий уровень
  async getCategoryPage(category: CatalogCategory, page?: number): Promise<unknown>    // tier-aware маршрутизация
  rateLimit(): { limit?: number; remaining?: number; resetAt?: Date }
}
```
- `getJson`: `AbortSignal.timeout(timeoutMs)`; таймаут/сетевые = network; 5xx/network → один ретрай через 500 мс; 429 → rate_limited (+resetAt); 401 → auth (текст про ARTIFICIAL_ANALYSIS_API_KEY, без самого ключа); 403 → forbidden; 404 → not_found. Из каждого ответа (включая ошибки, кроме 401) парсятся `X-RateLimit-*` и `X-AA-Tier` (уточняет тариф).
- `getTier`: `tierOverride` (AA_TIER) → сразу. Иначе одноразовый промис: GET free page1, тариф из X-AA-Tier (нет заголовка → предположить free + warn), тело сложить в seed. Повторного запроса page1 не делается: `getCategoryPage('llm', 1)` при маршрутизации на `/free`-путь потребляет seed.
- `getCategoryPage`: таблица путей `{ full, free }` для `llm` + 11 медиа-категорий (music — вложенные пути!); тариф free → free-путь; иначе full; full вернул 403 → warn, понизить кэшированный тариф до free, одноразово повторить с free-путём; если и free 403 → forbidden с объяснением тарифа.
- [ ] TDD (инъекция fetchImpl через undici MockAgent/mock fetch): детекция тарифа + seed потребляется один раз (page1 не запрашивается повторно); AA_TIER override; 403→/free фолбэк с понижением; 401/403/429(resetAt)/404 классификация; 5xx ретрай успешный и неуспешный; таймаут → network (fake fetch, AbortSignal); rate-limit заголовки трекаются; ключ не встречается в message ни одной ошибки. Commit `feat: tier-aware AA API client`.

### Task 6: catalog.ts

**Files:** `src/catalog.ts`, `tests/catalog.test.ts`.

**Produces:**
```ts
type MediaCategory = 'text-to-image'|'image-editing'|'text-to-video'|'image-to-video'|'text-to-video-audio'|'image-to-video-audio'|'text-to-speech'|'speech-to-speech'|'speech-to-text'|'music-instrumental'|'music-with-vocals';
interface NormalizedLlmModel { id; name; slug; creator: string|null; release_date: string|null;
  intelligence_index/coding_index/agentic_index: number|null;
  price_1m_input/price_1m_output: number|null; price_1m_blended_3_to_1?: number|null;
  median_output_tps/median_ttft_s/median_e2e_s: number|null;
  reasoning_model?: boolean; context_window_tokens?: number|null; parameters_b?: number|null;
  input_modalities?: string[]; output_modalities?: string[]; is_open_weights?: boolean;
  providers?: Array<{name: string; slug: string}> }
interface NormalizedMediaModel { id; name; slug?: string; creator: string|null; category: MediaCategory;
  score_kind: 'elo'|'aa_wer_index'|'tau_voice_score'|'bba_score'|'fdb_score'; score_value: number|null;
  score_direction: 'asc'|'desc'; ci_95?: number|null; release_date?: string|null;
  is_open_weights?: boolean|null; price_fields: Record<string, number> }
class Catalog {
  constructor(client: AAClient, cache: TtlCache)
  async getLlm(): Promise<{ models: NormalizedLlmModel[]; tier: Tier; intelligenceIndexVersion: number|null; dataAsOf: Date; stale: boolean }>
  async getLlmDetail(slug: string): Promise<NormalizedLlmModel | undefined>  // Pro+ detail endpoint; Free → undefined (не тратить квоту)
  async getMedia(category: MediaCategory): Promise<{ models: NormalizedMediaModel[]; tier: Tier; dataAsOf: Date; stale: boolean }>
}
```
- LLM-loader: цикл страниц (page=1..10, `pagination.has_more`), zod-parse каждой, конкатенация `data`. Если после 10 страниц has_more → `AAApiError('catalog_truncated')` — не кэшируется, но staleEligible. staleEligible = kind ∈ {rate_limited, server_error, network, catalog_truncated}.
- Ключ кэша = категория (`llm`, `media:text-to-image`, …); в кэш кладётся только полный массив (+tier, версия индекса).
- Медиа: один запрос; `score_kind` по категории: elo desc для image/editing/video×4/tts/music×2; `speech-to-text` → aa_wer_index **asc**; `speech-to-speech` → первый не-null из tau_voice_score → bba_score → fdb_score (desc; все null → score_value null). `price_fields` собирается из присутствующих не-null ценовых полей записи (`price_per_1k_images`, `price_per_minute`, `price_per_1m_characters`; для sts/stt провайдерские цены не агрегируем в v1 — только поля верхнего уровня записи). `is_open_weights` для арен: `open_weights_url != null` если поле есть; у stt — `open_weights`.
- `getLlmDetail`: если тариф free → undefined; иначе `getJson('/api/v2/language/models/'+slug)` через кэш (ключ `llm-detail:<slug>`), 404 → undefined.
- [ ] TDD: сборка 2 страниц; seed-страница не перезапрашивается (счётчик вызовов клиента); >10 страниц → catalog_truncated, а при наличии stale — stale-копия; нормализация каждой медиа-категории (elo, wer asc, sts-фолбэк score, отсутствие slug у stt/music); null-семантика сохранена; detail на free → undefined без сетевого вызова. Commit `feat: normalized model catalog with paginated LLM assembly`.

### Task 7: match.ts

**Files:** `src/match.ts`, `tests/match.test.ts`.

**Produces:**
```ts
interface LlmFilters { query?; min_intelligence_index?; min_coding_index?; min_agentic_index?;
  max_price_input_per_1m?; max_price_output_per_1m?; min_output_tokens_per_second?;
  max_time_to_first_token_seconds?; creators?: string[]; released_after?: string;
  open_weights_only?: boolean; reasoning_only?: boolean; min_context_window_tokens?; input_modalities?: string[] }
type SortKey = 'intelligence_index'|'coding_index'|'agentic_index'|'price_input'|'price_output'|'output_speed'|'ttft'|'release_date'|'best_value';
function filterLlm(models, filters, tier): { matched: NormalizedLlmModel[]; unsupportedFilters: string[] }
function sortLlm(models, sortBy: SortKey, order?: 'asc'|'desc'): NormalizedLlmModel[]
function defaultOrder(sortBy): 'asc'|'desc'   // price_*, ttft → asc; остальные desc
function bestValueScore(m): number | null      // ii / price; price = blended_3_to_1 ?? (input+output)/2; null/≤0 → null
function normalizeText(s): string              // lower, [^a-z0-9]→' ', collapse
function resolveModel(query, models): { kind:'resolved'; model; resolvedFrom?: string } | { kind:'ambiguous'; candidates: models[] (ii desc, ≤10) } | { kind:'not_found' }
function filterMedia(models, query?): NormalizedMediaModel[]
function sortMedia(models): NormalizedMediaModel[]  // по score_kind/direction, null в конец
```
- Числовой фильтр: `v => v !== null && v !== undefined && v <op> порог`. Pro-фильтры (open_weights_only, reasoning_only, min_context_window_tokens, input_modalities) при tier='free' не применяются и попадают в `unsupportedFilters`. `creators` — case-insensitive точное совпадение имени создателя. `released_after` — `release_date !== null && release_date > date` (строго позже). `query` — подстрока normalizeText по name/slug/creator. `input_modalities` — модель принимает ВСЕ перечисленные.
- Сортировка: компаратор с извлечением ключа; null/undefined ключ — всегда в конец независимо от order (стабильно). best_value: ключ = bestValueScore, null → конец, из выдачи не выбрасывается.
- resolveModel: (1) normalizeText(query) === normalizeText(slug|name) любой модели → resolved (при нескольких точных — первое по ii desc… точный дубль маловероятен; берём ii desc первый); (2) ровно одна модель, где нормализованное name|slug содержит запрос как подстроку ИЛИ содержит все токены запроса → resolved с resolvedFrom; (3) >1 → ambiguous (ii desc, max 10); (4) 0 → not_found.
- [ ] TDD: все фильтры + null не проходит; Pro-фильтр на free → unsupported; каждая сортировка + null в конец при обоих order; best_value (blended приоритет, ≤0 → конец); resolve: точный slug, точное имя с пунктуацией (`GPT-OSS 20B (high)`), однозначная подстрока, все-токены, неоднозначный, не найден. Commit `feat: filtering, sorting and fuzzy model resolution`.

### Task 8: format.ts

**Files:** `src/format.ts`, `tests/format.test.ts`.

**Produces:** `ATTRIBUTION = 'Source: Artificial Analysis (https://artificialanalysis.ai)'`; `mdTable(headers, rows)` (экранирование `|`); `fmtNum(v, digits?)` → `'—'` для null/undefined; `fmtUsd`; `finishText(bodyLines, warnings, footer?)` — предупреждения (⚠), затем пустая строка + ATTRIBUTION последней строкой; `staleNotice(dataAsOf)`; `quotaWarning(remaining)`.
- [ ] TDD: таблица, null → «—», атрибуция последней строкой, stale-пометка с UTC-временем. Commit `feat: markdown formatting helpers with attribution`.

### Task 9: инструменты + server.ts

**Files:** `src/tools/find-models.ts`, `get-model.ts`, `compare-models.ts`, `list-media-models.ts`, `get-api-status.ts`, `src/server.ts`, `src/context.ts`, `tests/tools.test.ts`.

**Consumes:** Catalog, match, format. **Produces:** `createMcpServer(ctx: AppContext): McpServer`; `AppContext = { config; logger; client; cache; catalog }` (синглтоны создаются в index.ts один раз).

Каждый инструмент: `server.registerTool(name, { title, description, inputSchema (zod raw shape, `.describe()` на каждом поле, по-английски), outputSchema }, handler)`. Ответ: `content:[{type:'text', text: markdown+attribution}]` + `structuredContent`. Ошибки → `isError: true` с человекочитаемым текстом (+attribution). Общие поля structuredContent при чтении каталога: `tier`, `data_as_of`, `stale`, `warnings`; LLM — ещё `intelligence_index_version`. Если `client.rateLimit().remaining < 5` → warning о квоте.

- `find_models` (§4.1): вход по таблице спеки (limit default 10 max 50; sort_by default intelligence_index; order default = defaultOrder). unsupported_filters → warning + structuredContent. structuredContent: `{ tier, intelligence_index_version, data_as_of, stale, total_matched, unsupported_filters, warnings, models: [...] }` (модели: name, slug, creator, release_date, 3 индекса, цены, median_output_tps, median_ttft_s + pro-поля если есть).
- `get_model` (§4.2): resolveModel; resolved + slug точный + тариф pro+ → detail-эндпоинт (фолбэк на запись каталога, если detail undefined); free → запись каталога. ambiguous → isError=false? Нет: вернуть список кандидатов (name+slug, ii desc, ≤10) с просьбой уточнить — это нормальный ответ, не ошибка. not_found → ошибка инструмента + подсказка find_models. resolvedFrom → пометка `resolved_from`.
- `compare_models` (§4.3): вход models: string[] (min 2 max 5). Резолв каждого; уверенно найденных ≥2 → таблица «метрика × модель» (индексы, цены, median tps/ttft/e2e, + context window/modalities/open weights при наличии), ненайденные/неоднозначные → warnings. <2 → ошибка с перечислением not_found и кандидатов ambiguous.
- `list_media_models` (§4.4): category (enum, required), query?, limit? (10/50). Ответ: топ по score с направлением, создателем, price_fields с единицами (имя поля = единица). structuredContent: `{ tier, category, score_kind, score_direction, data_as_of, stale, total_matched, warnings, models }`.
- `get_api_status` (§4.5): без входа; тариф (если не определён — определить, потратив 1 запрос, и отразить это в markdown и warnings), версия II (из кэша LLM, если прогрет; иначе null), rateLimit(), `cache.inspect()`. Не читает каталог по сети.
- `server.ts`: `new McpServer({name:'artificialanalysis-mcp', version}, { instructions })` — instructions описывают назначение и подсказку начинать с find_models.
- [ ] TDD интеграционно через `InMemoryTransport.createLinkedPair()` + mock fetch: happy path каждого инструмента; пустой результат find_models; Pro-фильтр на free; неоднозначный резолв get_model; compare с 1 найденной → ошибка; list_media speech-to-speech (без elo), speech-to-text (без slug), music (без slug); 429 без stale → isError; 429 при протухшем кэше → stale:true + пометка; 401 → понятная ошибка; параллельные два вызова find_models на холодном кэше → ровно 2–3 сетевых запроса (по числу страниц), не вдвое больше. Commit `feat: five MCP tools with structuredContent and attribution`.

### Task 10: транспорты + index.ts + smoke

**Files:** `src/transport/stdio.ts`, `src/transport/http.ts`, `src/index.ts`, `scripts/smoke.mjs`, `tests/http.test.ts`.

- stdio: `StdioServerTransport` + один McpServer.
- http: `node:http`. `POST /mcp` → на каждый запрос новый McpServer + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`, `res.on('close') → transport.close(); server.close()`. `GET /healthz` → `200 {"status":"ok"}` без авторизации. `MCP_AUTH_TOKEN` задан → Bearer, сравнение `timingSafeEqual` (по длине — сначала выравнивание/отказ), иначе 401. `Origin` задан и не localhost/127.0.0.1/[::1] → 403 (DNS rebinding). Bind не на loopback без токена → громкое stderr-предупреждение при старте.
- index.ts: loadConfig (нет ключа → stderr + exit 1), createLogger, синглтоны AAClient/TtlCache/Catalog, выбор транспорта; SIGINT/SIGTERM → graceful close.
- smoke.mjs: spawn `node dist/index.js` с фиктивным ключом, JSON-RPC `initialize` + `tools/list` по stdio (raw, без SDK: newline-delimited), assert ровно 5 инструментов с ожидаемыми именами, exit 0/1, таймаут 10 с.
- [ ] Тесты http: healthz; 401 без/с неверным токеном; 200 с верным; 403 при чужом Origin. Прогон `npm run build && npm run smoke`. Commit `feat: stdio and streamable HTTP transports, smoke test`.

### Task 11: README + финальная верификация

**Files:** `README.md`.

README (по-английски): пометка **unofficial** + атрибуция AA; установка `npx artificialanalysis-mcp`; конфиг Claude Desktop (`mcpServers` JSON) и Claude Code (`claude mcp add`); Docker-запуск (ghcr.io, `-e ARTIFICIAL_ANALYSIS_API_KEY`, предупреждение про HTTP без `MCP_AUTH_TOKEN`); таблица env; описание 5 инструментов; тарифы AA и ограничения (Free 100 req/день, Pro-поля); лицензия MIT.

- [ ] Полный прогон: `npm run lint && npm run typecheck && npm test && npm run build && npm run smoke`; coverage match.ts и api/client.ts ≥ 90 %; `npm run generate:types` без diff; Docker-сборка локально (если docker доступен). DoD §8 чек-лист по пунктам.
- [ ] Commit `docs: README`, push ветки, PR в main.

## Обязательные интеграционные сценарии (§6) — сводный чек-лист

- [ ] tier-фолбэк 403→/free (Task 5, 9)
- [ ] 429 после TTL → stale-копия `stale:true` (Task 4, 9)
- [ ] 429/5xx без stale → ошибка (Task 4, 9)
- [ ] Pro-фильтр на Free (Task 7, 9)
- [ ] неоднозначный fuzzy (Task 7, 9)
- [ ] media: sts без Elo, stt без slug, music без slug (Task 6, 9)
- [ ] pagination >10 страниц → catalog_truncated (Task 6)
- [ ] compare_models <2 (Task 9)
- [ ] параллельные вызовы холодный кэш → один сетевой запрос на ключ (Task 4, 9)
- [ ] таймаут запроса (Task 5)
