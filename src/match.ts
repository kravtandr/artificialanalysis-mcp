import type { NormalizedLlmModel, NormalizedMediaModel } from './catalog.js';
import type { Tier } from './config.js';

export interface LlmFilters {
  query?: string;
  min_intelligence_index?: number;
  min_coding_index?: number;
  min_agentic_index?: number;
  max_price_input_per_1m?: number;
  max_price_output_per_1m?: number;
  min_output_tokens_per_second?: number;
  max_time_to_first_token_seconds?: number;
  creators?: string[];
  released_after?: string;
  open_weights_only?: boolean;
  reasoning_only?: boolean;
  min_context_window_tokens?: number;
  input_modalities?: string[];
}

export type SortKey =
  | 'intelligence_index'
  | 'coding_index'
  | 'agentic_index'
  | 'price_input'
  | 'price_output'
  | 'output_speed'
  | 'ttft'
  | 'release_date'
  | 'best_value';

const PRO_FILTERS = [
  'open_weights_only',
  'reasoning_only',
  'min_context_window_tokens',
  'input_modalities',
] as const;

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// null = «не измерено»: числовой фильтр такие записи не пропускает.
function passesMin(value: number | null | undefined, threshold: number | undefined): boolean {
  if (threshold === undefined) return true;
  return value !== null && value !== undefined && value >= threshold;
}

function passesMax(value: number | null | undefined, threshold: number | undefined): boolean {
  if (threshold === undefined) return true;
  return value !== null && value !== undefined && value <= threshold;
}

export function filterLlm(
  models: NormalizedLlmModel[],
  filters: LlmFilters,
  tier: Tier,
): { matched: NormalizedLlmModel[]; unsupportedFilters: string[] } {
  // Pro-фильтр на Free-тарифе не применяется молча — он объявляется unsupported.
  const unsupportedFilters =
    tier === 'free' ? PRO_FILTERS.filter((name) => filters[name] !== undefined) : [];
  const unsupported = new Set<string>(unsupportedFilters);

  const query = filters.query !== undefined ? normalizeText(filters.query) : undefined;
  const creators = filters.creators?.map((c) => c.toLowerCase());

  const matched = models.filter((m) => {
    if (query !== undefined) {
      const haystack = [m.name, m.slug, m.creator ?? ''].map(normalizeText).join(' ');
      if (!haystack.includes(query)) return false;
    }
    if (!passesMin(m.intelligence_index, filters.min_intelligence_index)) return false;
    if (!passesMin(m.coding_index, filters.min_coding_index)) return false;
    if (!passesMin(m.agentic_index, filters.min_agentic_index)) return false;
    if (!passesMax(m.price_1m_input, filters.max_price_input_per_1m)) return false;
    if (!passesMax(m.price_1m_output, filters.max_price_output_per_1m)) return false;
    if (!passesMin(m.median_output_tps, filters.min_output_tokens_per_second)) return false;
    if (!passesMax(m.median_ttft_s, filters.max_time_to_first_token_seconds)) return false;
    if (creators !== undefined && !creators.includes((m.creator ?? '').toLowerCase())) return false;
    if (filters.released_after !== undefined) {
      if (m.release_date === null || m.release_date <= filters.released_after) return false;
    }
    if (filters.open_weights_only === true && !unsupported.has('open_weights_only')) {
      if (m.is_open_weights !== true) return false;
    }
    if (filters.reasoning_only === true && !unsupported.has('reasoning_only')) {
      if (m.reasoning_model !== true) return false;
    }
    if (
      filters.min_context_window_tokens !== undefined &&
      !unsupported.has('min_context_window_tokens')
    ) {
      if (!passesMin(m.context_window_tokens, filters.min_context_window_tokens)) return false;
    }
    if (filters.input_modalities !== undefined && !unsupported.has('input_modalities')) {
      const supported = m.input_modalities;
      if (supported === undefined) return false;
      if (!filters.input_modalities.every((wanted) => supported.includes(wanted))) return false;
    }
    return true;
  });

  return { matched, unsupportedFilters: [...unsupportedFilters] };
}

/**
 * best_value = intelligence_index / цена: на Pro+ берётся price_1m_blended_3_to_1,
 * иначе средняя (input+output)/2. Цена null/отсутствует или ≤ 0 (артефакт данных —
 * делить нельзя) → null: модель уходит в конец сортировки, но не выбрасывается.
 */
export function bestValueScore(m: NormalizedLlmModel): number | null {
  if (m.intelligence_index === null) return null;
  let price: number | null | undefined = m.price_1m_blended_3_to_1;
  if (price === null || price === undefined) {
    if (m.price_1m_input === null || m.price_1m_output === null) return null;
    price = (m.price_1m_input + m.price_1m_output) / 2;
  }
  if (price <= 0) return null;
  return m.intelligence_index / price;
}

export function defaultOrder(sortBy: SortKey): 'asc' | 'desc' {
  return sortBy === 'price_input' || sortBy === 'price_output' || sortBy === 'ttft'
    ? 'asc'
    : 'desc';
}

type SortValue = number | string | null;

function sortValue(m: NormalizedLlmModel, sortBy: SortKey): SortValue {
  switch (sortBy) {
    case 'intelligence_index':
      return m.intelligence_index;
    case 'coding_index':
      return m.coding_index;
    case 'agentic_index':
      return m.agentic_index;
    case 'price_input':
      return m.price_1m_input;
    case 'price_output':
      return m.price_1m_output;
    case 'output_speed':
      return m.median_output_tps;
    case 'ttft':
      return m.median_ttft_s;
    case 'release_date':
      return m.release_date;
    case 'best_value':
      return bestValueScore(m);
  }
}

// Записи с null/undefined в ключе сортировки — всегда в конце, независимо от order.
function compareNullsLast(a: SortValue, b: SortValue, order: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const cmp = a < b ? -1 : a > b ? 1 : 0;
  return order === 'asc' ? cmp : -cmp;
}

export function sortLlm(
  models: NormalizedLlmModel[],
  sortBy: SortKey,
  order?: 'asc' | 'desc',
): NormalizedLlmModel[] {
  const effectiveOrder = order ?? defaultOrder(sortBy);
  return [...models].sort((a, b) =>
    compareNullsLast(sortValue(a, sortBy), sortValue(b, sortBy), effectiveOrder),
  );
}

export type ResolveResult =
  | { kind: 'resolved'; model: NormalizedLlmModel; resolvedFrom?: string }
  | { kind: 'ambiguous'; candidates: NormalizedLlmModel[] }
  | { kind: 'not_found' };

function byIntelligenceDesc(a: NormalizedLlmModel, b: NormalizedLlmModel): number {
  return compareNullsLast(a.intelligence_index, b.intelligence_index, 'desc');
}

/** Fuzzy-резолв имени/slug (SPEC.md §4.2), общий для get_model и compare_models. */
export function resolveModel(query: string, models: NormalizedLlmModel[]): ResolveResult {
  const normalized = normalizeText(query);
  if (normalized === '') return { kind: 'not_found' };

  const exact = models
    .filter((m) => normalizeText(m.slug) === normalized || normalizeText(m.name) === normalized)
    .sort(byIntelligenceDesc);
  if (exact.length > 0) return { kind: 'resolved', model: exact[0]! };

  const tokens = normalized.split(' ');
  const partial = models.filter((m) => {
    const name = normalizeText(m.name);
    const slug = normalizeText(m.slug);
    if (name.includes(normalized) || slug.includes(normalized)) return true;
    const nameTokens = new Set([...name.split(' '), ...slug.split(' ')]);
    return tokens.every((token) => nameTokens.has(token));
  });

  if (partial.length === 1) {
    return { kind: 'resolved', model: partial[0]!, resolvedFrom: query };
  }
  if (partial.length > 1) {
    return { kind: 'ambiguous', candidates: partial.sort(byIntelligenceDesc).slice(0, 10) };
  }
  return { kind: 'not_found' };
}

export function filterMedia(
  models: NormalizedMediaModel[],
  query?: string,
): NormalizedMediaModel[] {
  if (query === undefined) return models;
  const normalized = normalizeText(query);
  return models.filter((m) =>
    [m.name, m.creator ?? '', m.slug ?? ''].map(normalizeText).join(' ').includes(normalized),
  );
}

/** Сортировка по category-specific score: направление из модели, null в конец. */
export function sortMedia(models: NormalizedMediaModel[]): NormalizedMediaModel[] {
  return [...models].sort((a, b) =>
    compareNullsLast(a.score_value, b.score_value, a.score_direction),
  );
}
