import { describe, expect, it } from 'vitest';
import type { NormalizedLlmModel, NormalizedMediaModel } from '../src/catalog.js';
import {
  bestValueScore,
  defaultOrder,
  filterLlm,
  filterMedia,
  normalizeText,
  resolveModel,
  sortLlm,
  sortMedia,
} from '../src/match.js';

function model(overrides: Partial<NormalizedLlmModel> & { slug: string }): NormalizedLlmModel {
  return {
    id: overrides.slug,
    name: overrides.slug,
    creator: 'Acme',
    release_date: '2025-01-01',
    intelligence_index: 50,
    coding_index: 40,
    agentic_index: 45,
    price_1m_input: 1,
    price_1m_output: 2,
    median_output_tps: 100,
    median_ttft_s: 0.5,
    median_e2e_s: 10,
    ...overrides,
  };
}

const models: NormalizedLlmModel[] = [
  model({
    slug: 'gpt-oss-20b',
    name: 'gpt-oss-20B (high)',
    creator: 'OpenAI',
    intelligence_index: 24.5,
    coding_index: 18.5,
    agentic_index: 27.6,
    price_1m_input: 0.06,
    price_1m_output: 0.2,
    median_output_tps: 296.47,
    median_ttft_s: 0.65,
    release_date: '2025-08-05',
  }),
  model({
    slug: 'gpt-oss-120b',
    name: 'gpt-oss-120B (high)',
    creator: 'OpenAI',
    intelligence_index: 38.7,
    price_1m_input: 0.15,
    price_1m_output: 0.6,
    median_ttft_s: 0.51,
    release_date: '2025-08-05',
  }),
  model({
    slug: 'kimi-k2',
    name: 'Kimi K2',
    creator: 'Moonshot AI',
    intelligence_index: 45.2,
    coding_index: null,
    price_1m_input: null,
    price_1m_output: null,
    median_output_tps: null,
    median_ttft_s: null,
    release_date: null,
  }),
  model({
    slug: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    creator: 'Anthropic',
    intelligence_index: 63.1,
    price_1m_input: 3,
    price_1m_output: 15,
    median_output_tps: 82.3,
    median_ttft_s: 1.42,
    release_date: '2025-09-29',
    reasoning_model: true,
    is_open_weights: false,
    context_window_tokens: 200000,
    input_modalities: ['text', 'image'],
    price_1m_blended_3_to_1: 6,
  }),
];

describe('normalizeText', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeText('GPT-OSS 20B (high)')).toBe('gpt oss 20b high');
    expect(normalizeText('  Claude   Sonnet-5 ')).toBe('claude sonnet 5');
  });
});

describe('filterLlm', () => {
  it('filters by numeric thresholds and never passes null through', () => {
    const { matched } = filterLlm(models, { max_price_input_per_1m: 1 }, 'free');
    // kimi-k2 с price null не проходит
    expect(matched.map((m) => m.slug)).toEqual(['gpt-oss-20b', 'gpt-oss-120b']);
    const speed = filterLlm(models, { min_output_tokens_per_second: 82 }, 'free').matched;
    expect(speed.map((m) => m.slug)).toEqual(['gpt-oss-20b', 'gpt-oss-120b', 'claude-sonnet-5']);
  });

  it('filters by query across name, slug and creator', () => {
    expect(filterLlm(models, { query: 'moonshot' }, 'free').matched[0]!.slug).toBe('kimi-k2');
    expect(filterLlm(models, { query: 'GPT-OSS' }, 'free').matched).toHaveLength(2);
  });

  it('filters by creators case-insensitively and released_after strictly', () => {
    const { matched } = filterLlm(models, { creators: ['openai', 'Anthropic'] }, 'free');
    expect(matched).toHaveLength(3);
    const after = filterLlm(models, { released_after: '2025-08-05' }, 'free').matched;
    // строго позже: gpt-oss-* (равно) и kimi (null) не проходят
    expect(after.map((m) => m.slug)).toEqual(['claude-sonnet-5']);
  });

  it('reports pro filters as unsupported on free tier without applying them', () => {
    const { matched, unsupportedFilters } = filterLlm(
      models,
      { reasoning_only: true, min_context_window_tokens: 100000, open_weights_only: true },
      'free',
    );
    expect(matched).toHaveLength(4);
    expect(unsupportedFilters.sort()).toEqual([
      'min_context_window_tokens',
      'open_weights_only',
      'reasoning_only',
    ]);
  });

  it('applies pro filters on pro tier', () => {
    const { matched, unsupportedFilters } = filterLlm(
      models,
      { reasoning_only: true, input_modalities: ['text', 'image'] },
      'pro',
    );
    expect(unsupportedFilters).toEqual([]);
    expect(matched.map((m) => m.slug)).toEqual(['claude-sonnet-5']);
  });
});

describe('sortLlm', () => {
  it('sorts with sensible default order per metric', () => {
    expect(defaultOrder('price_input')).toBe('asc');
    expect(defaultOrder('ttft')).toBe('asc');
    expect(defaultOrder('intelligence_index')).toBe('desc');
    const byIi = sortLlm(models, 'intelligence_index');
    expect(byIi[0]!.slug).toBe('claude-sonnet-5');
  });

  it('always puts null keys last regardless of order', () => {
    const asc = sortLlm(models, 'price_input', 'asc');
    expect(asc.map((m) => m.slug)).toEqual([
      'gpt-oss-20b',
      'gpt-oss-120b',
      'claude-sonnet-5',
      'kimi-k2',
    ]);
    const desc = sortLlm(models, 'price_input', 'desc');
    expect(desc.map((m) => m.slug)).toEqual([
      'claude-sonnet-5',
      'gpt-oss-120b',
      'gpt-oss-20b',
      'kimi-k2',
    ]);
  });

  it('sorts by release_date with nulls last', () => {
    const sorted = sortLlm(models, 'release_date');
    expect(sorted[0]!.slug).toBe('claude-sonnet-5');
    expect(sorted.at(-1)!.slug).toBe('kimi-k2');
  });
});

describe('bestValueScore', () => {
  it('prefers the blended price when present', () => {
    const sonnet = models.find((m) => m.slug === 'claude-sonnet-5')!;
    expect(bestValueScore(sonnet)).toBeCloseTo(63.1 / 6);
  });

  it('falls back to the input/output average', () => {
    const gpt = models.find((m) => m.slug === 'gpt-oss-20b')!;
    expect(bestValueScore(gpt)).toBeCloseTo(24.5 / 0.13);
  });

  it('returns null for missing or non-positive prices', () => {
    expect(bestValueScore(models.find((m) => m.slug === 'kimi-k2')!)).toBeNull();
    expect(bestValueScore(model({ slug: 'x', price_1m_input: 0, price_1m_output: 0 }))).toBeNull();
    expect(bestValueScore(model({ slug: 'x', intelligence_index: null }))).toBeNull();
  });

  it('keeps unpriceable models at the end of best_value sorting, not dropped', () => {
    const sorted = sortLlm(models, 'best_value');
    expect(sorted).toHaveLength(4);
    expect(sorted[0]!.slug).toBe('gpt-oss-20b');
    expect(sorted.at(-1)!.slug).toBe('kimi-k2');
  });
});

describe('resolveModel', () => {
  it('resolves an exact slug or a punctuated exact name confidently', () => {
    const bySlug = resolveModel('gpt-oss-20b', models);
    expect(bySlug).toMatchObject({ kind: 'resolved', model: { slug: 'gpt-oss-20b' } });
    expect('resolvedFrom' in bySlug && bySlug.resolvedFrom).toBeFalsy();
    const byName = resolveModel('GPT-OSS 20B (high)', models);
    expect(byName).toMatchObject({ kind: 'resolved', model: { slug: 'gpt-oss-20b' } });
  });

  it('resolves a unique substring with resolvedFrom marker', () => {
    const result = resolveModel('sonnet', models);
    expect(result).toMatchObject({
      kind: 'resolved',
      model: { slug: 'claude-sonnet-5' },
      resolvedFrom: 'sonnet',
    });
  });

  it('resolves when all query tokens match even out of order', () => {
    const result = resolveModel('k2 kimi', models);
    expect(result).toMatchObject({ kind: 'resolved', model: { slug: 'kimi-k2' } });
  });

  it('returns candidates sorted by intelligence for ambiguous queries', () => {
    const result = resolveModel('gpt oss', models);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((c) => c.slug)).toEqual(['gpt-oss-120b', 'gpt-oss-20b']);
    }
  });

  it('returns not_found for unknown and empty queries', () => {
    expect(resolveModel('grok-17', models).kind).toBe('not_found');
    expect(resolveModel('  --  ', models).kind).toBe('not_found');
  });
});

describe('media filtering and sorting', () => {
  const media: NormalizedMediaModel[] = [
    {
      id: '1',
      name: 'Whisper Large v4',
      creator: 'OpenAI',
      category: 'speech-to-text',
      score_kind: 'aa_wer_index',
      score_value: 8.4,
      score_direction: 'asc',
      price_fields: {},
    },
    {
      id: '2',
      name: 'Universal-3',
      creator: 'AssemblyAI',
      category: 'speech-to-text',
      score_kind: 'aa_wer_index',
      score_value: 6.9,
      score_direction: 'asc',
      price_fields: {},
    },
    {
      id: '3',
      name: 'Scribe Unmeasured',
      creator: 'Acme AI',
      category: 'speech-to-text',
      score_kind: 'aa_wer_index',
      score_value: null,
      score_direction: 'asc',
      price_fields: {},
    },
  ];

  it('sorts WER ascending (lower is better) with nulls last', () => {
    expect(sortMedia(media).map((m) => m.id)).toEqual(['2', '1', '3']);
  });

  it('filters by name or creator substring', () => {
    expect(filterMedia(media, 'assembly')).toHaveLength(1);
    expect(filterMedia(media, 'whisper')[0]!.id).toBe('1');
    expect(filterMedia(media)).toHaveLength(3);
  });
});
