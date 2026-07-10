import { describe, expect, it } from 'vitest';
import { AAApiError } from '../src/api/errors.js';
import { Catalog, type CatalogClient } from '../src/catalog.js';
import { TtlCache } from '../src/cache.js';
import type { Tier } from '../src/config.js';
import { fixture } from './helpers.js';

class FakeClient implements CatalogClient {
  calls: Array<{ category?: string; page?: number; path?: string }> = [];
  constructor(
    private readonly tier: Tier,
    private readonly pages: Record<string, unknown[]>,
    private readonly detail?: unknown,
  ) {}

  getTier(): Promise<Tier> {
    return Promise.resolve(this.tier);
  }

  getCategoryPage(category: string, page?: number): Promise<unknown> {
    this.calls.push({ category, ...(page !== undefined ? { page } : {}) });
    const list = this.pages[category];
    if (!list) throw new Error(`no fixture for ${category}`);
    const body = list[(page ?? 1) - 1] ?? list[list.length - 1];
    return Promise.resolve(body);
  }

  getJson(path: string): Promise<unknown> {
    this.calls.push({ path });
    if (this.detail === undefined) throw new AAApiError('not_found', `Not found: ${path}`);
    return Promise.resolve(this.detail);
  }
}

const freePages = [fixture('llm-free-page1'), fixture('llm-free-page2')];

describe('Catalog.getLlm', () => {
  it('assembles all pages into one normalized snapshot and caches it', async () => {
    const client = new FakeClient('free', { llm: freePages });
    const catalog = new Catalog(client, new TtlCache(60));

    const result = await catalog.getLlm();
    expect(result.models).toHaveLength(6);
    expect(result.tier).toBe('free');
    expect(result.intelligenceIndexVersion).toBe(4.1);
    expect(result.stale).toBe(false);
    expect(client.calls).toEqual([
      { category: 'llm', page: 1 },
      { category: 'llm', page: 2 },
    ]);

    await catalog.getLlm();
    expect(client.calls).toHaveLength(2); // из кэша, без сети
  });

  it('preserves null vs absent through normalization', async () => {
    const client = new FakeClient('free', { llm: freePages });
    const catalog = new Catalog(client, new TtlCache(60));
    const { models } = await catalog.getLlm();
    const kimi = models.find((m) => m.slug === 'kimi-k2')!;
    expect(kimi.price_1m_input).toBeNull();
    expect(kimi.release_date).toBeNull();
    expect(kimi.reasoning_model).toBeUndefined();
    expect(kimi.is_open_weights).toBeUndefined();
    expect(kimi.price_1m_blended_3_to_1).toBeUndefined();
  });

  it('normalizes pro-only fields when present', async () => {
    const client = new FakeClient('pro', { llm: [fixture('llm-pro-page1')] });
    const catalog = new Catalog(client, new TtlCache(60));
    const { models } = await catalog.getLlm();
    const gpt = models.find((m) => m.slug === 'gpt-oss-20b')!;
    expect(gpt.reasoning_model).toBe(true);
    expect(gpt.is_open_weights).toBe(true);
    expect(gpt.context_window_tokens).toBe(131072);
    expect(gpt.parameters_b).toBe(21);
    expect(gpt.input_modalities).toEqual(['text']);
    expect(gpt.price_1m_blended_3_to_1).toBe(0.09);
  });

  it('throws catalog_truncated after 10 pages with has_more still true', async () => {
    const endless = { ...(fixture('llm-free-page1') as Record<string, unknown>) };
    const client = new FakeClient('free', { llm: Array<unknown>(12).fill(endless) });
    const catalog = new Catalog(client, new TtlCache(60));
    const error = (await catalog.getLlm().catch((e: unknown) => e)) as AAApiError;
    expect(error).toBeInstanceOf(AAApiError);
    expect(error.kind).toBe('catalog_truncated');
    expect(client.calls).toHaveLength(10);
  });

  it('serves a stale snapshot when a later refresh hits catalog truncation', async () => {
    let now = 0;
    const cache = new TtlCache(60, () => now);
    const good = new FakeClient('free', { llm: freePages });
    const catalog = new Catalog(good, cache);
    await catalog.getLlm();

    now = 100_000;
    const endless = fixture('llm-free-page1');
    good.getCategoryPage = () => Promise.resolve(endless); // все страницы с has_more=true
    const result = await catalog.getLlm();
    expect(result.stale).toBe(true);
    expect(result.models).toHaveLength(6);
  });
});

describe('Catalog.getLlmDetail', () => {
  it('returns undefined on free tier without any network call', async () => {
    const client = new FakeClient('free', { llm: freePages }, fixture('llm-detail'));
    const catalog = new Catalog(client, new TtlCache(60));
    await expect(catalog.getLlmDetail('gpt-oss-20b')).resolves.toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  it('fetches, parses and normalizes the detail card on pro+', async () => {
    const client = new FakeClient('pro', { llm: [] }, fixture('llm-detail'));
    const catalog = new Catalog(client, new TtlCache(60));
    const detail = await catalog.getLlmDetail('gpt-oss-20b');
    expect(detail?.model.providers).toEqual([{ name: 'Groq', slug: 'groq' }]);
    expect(client.calls).toEqual([{ path: '/api/v2/language/models/gpt-oss-20b' }]);
  });

  it('returns undefined for an unknown slug (404)', async () => {
    const client = new FakeClient('pro', { llm: [] });
    const catalog = new Catalog(client, new TtlCache(60));
    await expect(catalog.getLlmDetail('nope')).resolves.toBeUndefined();
  });
});

describe('Catalog.getMedia', () => {
  const client = new FakeClient('free', {
    'text-to-image': [fixture('media-text-to-image-paid')],
    'speech-to-speech': [fixture('media-speech-to-speech-free')],
    'speech-to-text': [fixture('media-speech-to-text-free')],
    'music-instrumental': [fixture('media-music-instrumental-free')],
    'text-to-speech': [fixture('media-text-to-speech-free')],
  });
  const catalog = new Catalog(client, new TtlCache(60));

  it('normalizes image arena items with elo desc and price fields', async () => {
    const { models } = await catalog.getMedia('text-to-image');
    const imagen = models.find((m) => m.slug === 'imagen-4-ultra')!;
    expect(imagen.score_kind).toBe('elo');
    expect(imagen.score_direction).toBe('desc');
    expect(imagen.score_value).toBe(1152.3);
    expect(imagen.price_fields).toEqual({ price_per_1k_images: 60 });
    expect(imagen.is_open_weights).toBe(false);
    const flux = models.find((m) => m.slug === 'flux-2-pro')!;
    expect(flux.is_open_weights).toBe(true);
  });

  it('picks the first available score for speech-to-speech', async () => {
    const { models } = await catalog.getMedia('speech-to-speech');
    expect(models[0]).toMatchObject({ score_kind: 'tau_voice_score', score_value: 0.44 });
    expect(models[1]).toMatchObject({ score_kind: 'bba_score', score_value: 0.79 });
    expect(models[2]!.score_value).toBeNull();
  });

  it('uses aa_wer_index ascending for speech-to-text and has no slug', async () => {
    const { models } = await catalog.getMedia('speech-to-text');
    expect(models[0]).toMatchObject({
      score_kind: 'aa_wer_index',
      score_direction: 'asc',
      score_value: 8.4,
    });
    expect(models[0]!.slug).toBeUndefined();
  });

  it('normalizes music without slug and tts with elo', async () => {
    const music = await catalog.getMedia('music-instrumental');
    expect(music.models[0]!.slug).toBeUndefined();
    expect(music.models[0]!.score_kind).toBe('elo');
    const tts = await catalog.getMedia('text-to-speech');
    expect(tts.models[0]!.slug).toBe('eleven-v4');
  });
});
