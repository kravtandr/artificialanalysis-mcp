import type { MediaCategory } from './api/client.js';
import { AAApiError, isStaleEligible } from './api/errors.js';
import {
  imageVideoItemSchema,
  llmDetailResponseSchema,
  llmListResponseSchema,
  mediaListResponseSchema,
  musicItemSchema,
  stsItemSchema,
  sttItemSchema,
  ttsItemSchema,
  type RawImageVideoItem,
  type RawLlmModel,
  type RawMusicItem,
  type RawStsItem,
  type RawSttItem,
  type RawTtsItem,
} from './api/schemas.js';
import type { TtlCache } from './cache.js';
import type { Tier } from './config.js';

export type { MediaCategory };

export const MEDIA_CATEGORIES: readonly MediaCategory[] = [
  'text-to-image',
  'image-editing',
  'text-to-video',
  'image-to-video',
  'text-to-video-audio',
  'image-to-video-audio',
  'text-to-speech',
  'speech-to-speech',
  'speech-to-text',
  'music-instrumental',
  'music-with-vocals',
];

/**
 * Нормализованные доменные модели (SPEC.md §3.1.1). Отсутствующее поле (undefined)
 * значит «не входит в форму ответа/тариф», null — «не измерено/не задано».
 */
export interface NormalizedLlmModel {
  id: string;
  name: string;
  slug: string;
  creator: string | null;
  release_date: string | null;
  intelligence_index: number | null;
  coding_index: number | null;
  agentic_index: number | null;
  price_1m_input: number | null;
  price_1m_output: number | null;
  price_1m_blended_3_to_1?: number | null;
  median_output_tps: number | null;
  median_ttft_s: number | null;
  median_e2e_s: number | null;
  reasoning_model?: boolean;
  context_window_tokens?: number | null;
  parameters_b?: number | null;
  input_modalities?: string[];
  output_modalities?: string[];
  is_open_weights?: boolean;
  providers?: Array<{ name: string; slug: string }>;
}

export type MediaScoreKind = 'elo' | 'aa_wer_index' | 'tau_voice_score' | 'bba_score' | 'fdb_score';

export interface NormalizedMediaModel {
  id: string;
  name: string;
  slug?: string;
  creator: string | null;
  category: MediaCategory;
  score_kind: MediaScoreKind;
  score_value: number | null;
  score_direction: 'asc' | 'desc';
  ci_95?: number | null;
  release_date?: string | null;
  is_open_weights?: boolean | null;
  price_fields: Record<string, number>;
}

export interface LlmCatalogResult {
  models: NormalizedLlmModel[];
  tier: Tier;
  intelligenceIndexVersion: number;
  dataAsOf: Date;
  stale: boolean;
}

export interface MediaCatalogResult {
  models: NormalizedMediaModel[];
  tier: Tier;
  dataAsOf: Date;
  stale: boolean;
}

/** Подмножество AAClient, нужное каталогу (упрощает тестирование). */
export interface CatalogClient {
  getTier(): Promise<Tier>;
  getCategoryPage(category: 'llm' | MediaCategory, page?: number): Promise<unknown>;
  getJson(path: string, params?: Record<string, string | number>): Promise<unknown>;
}

const MAX_LLM_PAGES = 10;

export class Catalog {
  constructor(
    private readonly client: CatalogClient,
    private readonly cache: TtlCache,
  ) {}

  async getLlm(): Promise<LlmCatalogResult> {
    const result = await this.cache.getOrLoad('llm', () => this.loadLlm(), isStaleEligible);
    return { ...result.value, dataAsOf: result.dataAsOf, stale: result.stale };
  }

  private async loadLlm(): Promise<Omit<LlmCatalogResult, 'dataAsOf' | 'stale'>> {
    const models: NormalizedLlmModel[] = [];
    let tier: Tier = 'free';
    let version = 0;
    for (let page = 1; ; page += 1) {
      const parsed = llmListResponseSchema.parse(await this.client.getCategoryPage('llm', page));
      tier = parsed.tier;
      version = parsed.intelligence_index_version;
      models.push(...parsed.data.map(normalizeLlm));
      if (!parsed.pagination.has_more) break;
      if (page >= MAX_LLM_PAGES) {
        // Неполный снимок не кэшируется как валидный; при наличии stale-копии
        // кэш отдаст её (catalog_truncated входит в stale-eligible).
        throw new AAApiError(
          'catalog_truncated',
          `LLM catalog still has more pages after ${MAX_LLM_PAGES}; refusing to serve a truncated snapshot.`,
        );
      }
    }
    return { models, tier, intelligenceIndexVersion: version };
  }

  /**
   * Detail-карточка доступна только на Pro+; на Free возвращается undefined,
   * не тратя квоту — инструмент использует запись из кэша списка.
   */
  async getLlmDetail(
    slug: string,
  ): Promise<{ model: NormalizedLlmModel; dataAsOf: Date; stale: boolean } | undefined> {
    const tier = await this.client.getTier();
    if (tier === 'free') return undefined;
    try {
      const result = await this.cache.getOrLoad(
        `llm-detail:${slug}`,
        async () => {
          const raw = await this.client.getJson(
            `/api/v2/language/models/${encodeURIComponent(slug)}`,
          );
          return llmDetailResponseSchema.parse(raw).data;
        },
        isStaleEligible,
      );
      return { model: normalizeLlm(result.value), dataAsOf: result.dataAsOf, stale: result.stale };
    } catch (error) {
      if (
        error instanceof AAApiError &&
        (error.kind === 'not_found' || error.kind === 'forbidden')
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async getMedia(category: MediaCategory): Promise<MediaCatalogResult> {
    const result = await this.cache.getOrLoad(
      `media:${category}`,
      async () => {
        const raw = await this.client.getCategoryPage(category);
        return parseAndNormalizeMedia(category, raw);
      },
      isStaleEligible,
    );
    return { ...result.value, dataAsOf: result.dataAsOf, stale: result.stale };
  }
}

export function normalizeLlm(raw: RawLlmModel): NormalizedLlmModel {
  const model: NormalizedLlmModel = {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    creator: raw.model_creator?.name ?? null,
    release_date: raw.release_date,
    intelligence_index: raw.evaluations.artificial_analysis_intelligence_index,
    coding_index: raw.evaluations.artificial_analysis_coding_index,
    agentic_index: raw.evaluations.artificial_analysis_agentic_index,
    price_1m_input: raw.pricing.price_1m_input_tokens,
    price_1m_output: raw.pricing.price_1m_output_tokens,
    median_output_tps: raw.performance.median_output_tokens_per_second,
    median_ttft_s: raw.performance.median_time_to_first_token_seconds,
    median_e2e_s: raw.performance.median_end_to_end_response_time_seconds,
  };
  if (raw.pricing.price_1m_blended_3_to_1 !== undefined) {
    model.price_1m_blended_3_to_1 = raw.pricing.price_1m_blended_3_to_1;
  }
  if (raw.reasoning_model !== undefined) model.reasoning_model = raw.reasoning_model;
  if (raw.context_window_tokens !== undefined) {
    model.context_window_tokens = raw.context_window_tokens;
  }
  if (raw.parameters !== undefined) model.parameters_b = raw.parameters?.total ?? null;
  if (raw.modalities !== undefined) {
    model.input_modalities = enabledModalities(raw.modalities.input);
    model.output_modalities = enabledModalities(raw.modalities.output);
  }
  if (raw.licensing !== undefined) model.is_open_weights = raw.licensing.is_open_weights;
  if (raw.providers !== undefined) {
    model.providers = raw.providers.map((p) => ({ name: p.name, slug: p.slug }));
  }
  return model;
}

function enabledModalities(set: Record<string, boolean | null>): string[] {
  return Object.entries(set)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);
}

function parseAndNormalizeMedia(
  category: MediaCategory,
  raw: unknown,
): Omit<MediaCatalogResult, 'dataAsOf' | 'stale'> {
  switch (category) {
    case 'text-to-image':
    case 'image-editing':
    case 'text-to-video':
    case 'image-to-video':
    case 'text-to-video-audio':
    case 'image-to-video-audio': {
      const parsed = mediaListResponseSchema(imageVideoItemSchema).parse(raw);
      return { tier: parsed.tier, models: parsed.data.map((i) => normalizeArenaItem(category, i)) };
    }
    case 'text-to-speech': {
      const parsed = mediaListResponseSchema(ttsItemSchema).parse(raw);
      return { tier: parsed.tier, models: parsed.data.map((i) => normalizeTts(category, i)) };
    }
    case 'speech-to-speech': {
      const parsed = mediaListResponseSchema(stsItemSchema).parse(raw);
      return { tier: parsed.tier, models: parsed.data.map((i) => normalizeSts(category, i)) };
    }
    case 'speech-to-text': {
      const parsed = mediaListResponseSchema(sttItemSchema).parse(raw);
      return { tier: parsed.tier, models: parsed.data.map((i) => normalizeStt(category, i)) };
    }
    case 'music-instrumental':
    case 'music-with-vocals': {
      const parsed = mediaListResponseSchema(musicItemSchema).parse(raw);
      return { tier: parsed.tier, models: parsed.data.map((i) => normalizeMusic(category, i)) };
    }
  }
}

function priceFields(source: Record<string, unknown>, names: string[]): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'number') fields[name] = value;
  }
  return fields;
}

function normalizeArenaItem(
  category: MediaCategory,
  item: RawImageVideoItem,
): NormalizedMediaModel {
  const model: NormalizedMediaModel = {
    id: item.id,
    name: item.name,
    slug: item.slug,
    creator: item.model_creator.name,
    category,
    score_kind: 'elo',
    score_value: item.elo,
    score_direction: 'desc',
    ci_95: item.ci_95,
    price_fields: priceFields(item, ['price_per_1k_images', 'price_per_minute']),
  };
  if (item.release_date !== undefined) model.release_date = item.release_date;
  if (item.open_weights_url !== undefined) model.is_open_weights = item.open_weights_url !== null;
  return model;
}

function normalizeTts(category: MediaCategory, item: RawTtsItem): NormalizedMediaModel {
  const model: NormalizedMediaModel = {
    id: item.id,
    name: item.name,
    slug: item.slug,
    creator: item.model_creator.name,
    category,
    score_kind: 'elo',
    score_value: item.elo,
    score_direction: 'desc',
    ci_95: item.ci_95,
    price_fields: priceFields(item, ['price_per_1m_characters']),
  };
  if (item.release_date !== undefined) model.release_date = item.release_date;
  return model;
}

// У speech-to-speech нет Elo: берётся первый доступный score в порядке
// tau_voice → bba → fdb (SPEC.md §4.4); все null → модель уходит в конец сортировки.
function normalizeSts(category: MediaCategory, item: RawStsItem): NormalizedMediaModel {
  let kind: MediaScoreKind = 'tau_voice_score';
  let value: number | null = item.tau_voice_score;
  if (value === null && item.bba_score !== null) {
    kind = 'bba_score';
    value = item.bba_score;
  }
  if (value === null && item.fdb_score !== null) {
    kind = 'fdb_score';
    value = item.fdb_score;
  }
  return {
    id: item.id,
    name: item.name,
    slug: item.slug,
    creator: item.model_creator.name,
    category,
    score_kind: kind,
    score_value: value,
    score_direction: 'desc',
    price_fields: {},
  };
}

// aa_wer_index — word error rate: меньше = лучше, направление asc. slug в OpenAPI нет.
function normalizeStt(category: MediaCategory, item: RawSttItem): NormalizedMediaModel {
  const model: NormalizedMediaModel = {
    id: item.id,
    name: item.name,
    creator: item.model_creator.name,
    category,
    score_kind: 'aa_wer_index',
    score_value: item.aa_wer_index,
    score_direction: 'asc',
    price_fields: {},
  };
  if (item.open_weights !== undefined) model.is_open_weights = item.open_weights;
  return model;
}

function normalizeMusic(category: MediaCategory, item: RawMusicItem): NormalizedMediaModel {
  return {
    id: item.id,
    name: item.name,
    creator: item.model_creator.name,
    category,
    score_kind: 'elo',
    score_value: item.elo,
    score_direction: 'desc',
    ci_95: item.ci_95,
    price_fields: {},
  };
}
