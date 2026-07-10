import { z } from 'zod';

// Zod-схемы — подмножество полей OpenAPI, которые реально использует сервер.
// Инвариант границы: null = «не измерено», отсутствие поля = «не входит в тариф/форму».
// Pro-поля вне `required` OpenAPI обязаны быть .optional().

const nnum = z.number().nullable();
const nstr = z.string().nullable();

const creatorSchema = z.object({ id: z.string(), name: z.string() });

const modalitySetSchema = z.object({
  text: z.boolean().nullable(),
  image: z.boolean().nullable(),
  video: z.boolean().nullable(),
  speech: z.boolean().nullable(),
});

const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

export const llmModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  release_date: nstr,
  model_creator: creatorSchema.nullable(),
  evaluations: z.object({
    artificial_analysis_intelligence_index: nnum,
    artificial_analysis_coding_index: nnum,
    artificial_analysis_agentic_index: nnum,
  }),
  pricing: z.object({
    price_1m_input_tokens: nnum,
    price_1m_output_tokens: nnum,
    price_1m_cache_hit_tokens: nnum.optional(),
    price_1m_cache_write_tokens: nnum.optional(),
    price_1m_blended_3_to_1: nnum.optional(),
    price_1m_blended_7_to_2_to_1: nnum.optional(),
  }),
  performance: z.object({
    median_output_tokens_per_second: nnum,
    median_time_to_first_token_seconds: nnum,
    median_time_to_first_answer_token_seconds: nnum.optional(),
    median_end_to_end_response_time_seconds: nnum,
  }),
  reasoning_model: z.boolean().optional(),
  context_window_tokens: z.number().nullable().optional(),
  parameters: z.object({ total: z.number(), active: nnum }).nullable().optional(),
  modalities: z.object({ input: modalitySetSchema, output: modalitySetSchema }).optional(),
  licensing: z.object({ is_open_weights: z.boolean() }).optional(),
  providers: z.array(providerSchema).optional(),
});
export type RawLlmModel = z.infer<typeof llmModelSchema>;

const tierFieldSchema = z.enum(['free', 'pro', 'commercial']);

export const llmListResponseSchema = z.object({
  tier: tierFieldSchema,
  intelligence_index_version: z.number(),
  pagination: z.object({
    page: z.number(),
    page_size: z.number(),
    total_pages: z.number(),
    has_more: z.boolean(),
  }),
  data: z.array(llmModelSchema),
});
export type LlmListResponse = z.infer<typeof llmListResponseSchema>;

export const llmDetailResponseSchema = z.object({
  tier: tierFieldSchema,
  intelligence_index_version: z.number(),
  data: llmModelSchema,
});

// Медиа-арены. Free-форма — подмножество paid-формы, поэтому paid-поля .optional().
export const imageVideoItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  model_creator: creatorSchema,
  elo: z.number(),
  ci_95: nnum,
  release_date: nstr.optional(),
  price_per_1k_images: nnum.optional(),
  price_per_minute: nnum.optional(),
  open_weights_url: nstr.optional(),
});
export type RawImageVideoItem = z.infer<typeof imageVideoItemSchema>;

export const ttsItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  model_creator: creatorSchema,
  elo: z.number(),
  ci_95: nnum,
  release_date: nstr.optional(),
  price_per_1m_characters: nnum.optional(),
});
export type RawTtsItem = z.infer<typeof ttsItemSchema>;

export const stsItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  model_creator: creatorSchema,
  bba_score: nnum,
  fdb_score: nnum,
  tau_voice_score: nnum,
});
export type RawStsItem = z.infer<typeof stsItemSchema>;

// По OpenAPI у speech-to-text и music-моделей поля slug нет вовсе.
export const sttItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  model_creator: creatorSchema,
  aa_wer_index: nnum,
  open_weights: z.boolean().nullable().optional(),
});
export type RawSttItem = z.infer<typeof sttItemSchema>;

export const musicItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  model_creator: creatorSchema,
  elo: z.number(),
  ci_95: nnum,
});
export type RawMusicItem = z.infer<typeof musicItemSchema>;

export function mediaListResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ tier: tierFieldSchema, data: z.array(item) });
}
