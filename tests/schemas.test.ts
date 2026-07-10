import { describe, expect, it } from 'vitest';
import { fixture } from './helpers.js';
import {
  llmDetailResponseSchema,
  llmListResponseSchema,
  mediaListResponseSchema,
  musicItemSchema,
  imageVideoItemSchema,
  stsItemSchema,
  sttItemSchema,
  ttsItemSchema,
} from '../src/api/schemas.js';

describe('llmListResponseSchema', () => {
  it('parses the free shape, preserving null vs value', () => {
    const parsed = llmListResponseSchema.parse(fixture('llm-free-page1'));
    expect(parsed.data).toHaveLength(3);
    expect(parsed.pagination.has_more).toBe(true);
    const kimi = parsed.data[2]!;
    expect(kimi.pricing.price_1m_input_tokens).toBeNull();
    expect(kimi.release_date).toBeNull();
    // Pro-поля отсутствуют в free-форме — undefined, не null
    expect(kimi.reasoning_model).toBeUndefined();
    expect(kimi.context_window_tokens).toBeUndefined();
    expect(kimi.pricing.price_1m_blended_3_to_1).toBeUndefined();
  });

  it('parses the pro shape with pro-only fields present', () => {
    const parsed = llmListResponseSchema.parse(fixture('llm-pro-page1'));
    const gpt = parsed.data[0]!;
    expect(gpt.reasoning_model).toBe(true);
    expect(gpt.context_window_tokens).toBe(131072);
    expect(gpt.licensing?.is_open_weights).toBe(true);
    expect(gpt.modalities?.input.text).toBe(true);
    expect(gpt.pricing.price_1m_blended_3_to_1).toBe(0.09);
  });

  it('rejects garbage', () => {
    expect(() => llmListResponseSchema.parse({ data: 'nope' })).toThrow();
  });
});

describe('llmDetailResponseSchema', () => {
  it('parses a commercial detail response with providers', () => {
    const parsed = llmDetailResponseSchema.parse(fixture('llm-detail'));
    expect(parsed.data.providers).toHaveLength(1);
    expect(parsed.data.providers?.[0]?.name).toBe('Groq');
  });
});

describe('media schemas', () => {
  it('parses image arena items (free and paid)', () => {
    const free = mediaListResponseSchema(imageVideoItemSchema).parse(
      fixture('media-text-to-image-free'),
    );
    expect(free.data[0]!.elo).toBe(1152.3);
    expect(free.data[0]!.slug).toBe('imagen-4-ultra');
    const paid = mediaListResponseSchema(imageVideoItemSchema).parse(
      fixture('media-text-to-image-paid'),
    );
    expect(paid.data[0]!.price_per_1k_images).toBe(60);
    expect(paid.data[1]!.open_weights_url).toContain('huggingface');
  });

  it('parses speech-to-speech items without elo', () => {
    const parsed = mediaListResponseSchema(stsItemSchema).parse(
      fixture('media-speech-to-speech-free'),
    );
    expect(parsed.data[0]!.tau_voice_score).toBe(0.44);
    expect(parsed.data[2]!.bba_score).toBeNull();
  });

  it('parses speech-to-text and music items which have no slug', () => {
    const stt = mediaListResponseSchema(sttItemSchema).parse(fixture('media-speech-to-text-free'));
    expect(stt.data[0]!.aa_wer_index).toBe(8.4);
    expect('slug' in stt.data[0]!).toBe(false);
    const music = mediaListResponseSchema(musicItemSchema).parse(
      fixture('media-music-instrumental-free'),
    );
    expect(music.data[0]!.elo).toBe(1201.5);
  });

  it('parses text-to-speech items', () => {
    const parsed = mediaListResponseSchema(ttsItemSchema).parse(
      fixture('media-text-to-speech-free'),
    );
    expect(parsed.data[1]!.elo).toBe(1121.9);
  });
});
