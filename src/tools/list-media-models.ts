import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MEDIA_CATEGORIES, type MediaCategory, type NormalizedMediaModel } from '../catalog.js';
import type { AppContext } from '../context.js';
import { finishText, fmtNum, mdTable } from '../format.js';
import { filterMedia, sortMedia } from '../match.js';
import { catalogWarnings, guardToolErrors } from './common.js';

const inputSchema = {
  category: z
    .enum(MEDIA_CATEGORIES as [MediaCategory, ...MediaCategory[]])
    .describe('Media arena category, e.g. text-to-image or speech-to-text.'),
  query: z
    .string()
    .optional()
    .describe('Case-insensitive substring matched against model name and creator.'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum models to return (1-50).'),
};

const outputSchema = {
  tier: z.string(),
  category: z.string(),
  score_kind: z.string().describe('Primary ranking metric for this category.'),
  score_direction: z
    .enum(['asc', 'desc'])
    .describe('asc = lower is better (e.g. word error rate), desc = higher is better (e.g. Elo).'),
  data_as_of: z.string(),
  stale: z.boolean(),
  total_matched: z.number(),
  warnings: z.array(z.string()),
  models: z.array(
    z.object({
      name: z.string(),
      slug: z.string().optional(),
      creator: z.string().nullable(),
      score_kind: z.string(),
      score_value: z.number().nullable(),
      ci_95: z.number().nullable().optional(),
      release_date: z.string().nullable().optional(),
      is_open_weights: z.boolean().nullable().optional(),
      price_fields: z.record(z.number()),
    }),
  ),
};

// Категория-уровневая метрика (у speech-to-speech per-model kind может отличаться —
// он показан в каждой записи).
const CATEGORY_SCORE_KIND: Record<MediaCategory, string> = {
  'text-to-image': 'elo',
  'image-editing': 'elo',
  'text-to-video': 'elo',
  'image-to-video': 'elo',
  'text-to-video-audio': 'elo',
  'image-to-video-audio': 'elo',
  'text-to-speech': 'elo',
  'speech-to-speech': 'tau_voice_score',
  'speech-to-text': 'aa_wer_index',
  'music-instrumental': 'elo',
  'music-with-vocals': 'elo',
};

function priceCell(m: NormalizedMediaModel): string {
  const entries = Object.entries(m.price_fields);
  if (entries.length === 0) return '—';
  return entries.map(([field, value]) => `${field}=$${value}`).join('; ');
}

export function registerListMediaModels(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_media_models',
    {
      title: 'List media models',
      description:
        'Top models of a media arena (image, video, speech, music) ranked by the category metric: Elo where available, word error rate (lower is better) for speech-to-text, tau-voice/BBA/FDB for speech-to-speech. Prices keep their native units (per 1k images, per minute, etc.) and are not comparable across categories.',
      inputSchema,
      outputSchema,
    },
    async ({ category, query, limit }) =>
      guardToolErrors(async () => {
        const catalog = await ctx.catalog.getMedia(category);
        const matched = filterMedia(catalog.models, query);
        const top = sortMedia(matched).slice(0, limit);
        const warnings = catalogWarnings(ctx, catalog.stale, catalog.dataAsOf);

        const direction =
          top[0]?.score_direction ?? (category === 'speech-to-text' ? 'asc' : 'desc');
        const table = mdTable(
          ['#', 'Model', 'Creator', 'Score', 'Metric', 'Price'],
          top.map((m, index) => [
            String(index + 1),
            m.slug !== undefined ? `${m.name} (\`${m.slug}\`)` : m.name,
            m.creator ?? '—',
            fmtNum(m.score_value, 1),
            m.score_kind,
            priceCell(m),
          ]),
        );
        const body =
          top.length === 0
            ? [`No ${category} models match the query.`]
            : [
                `Top ${top.length} of ${matched.length} ${category} models (${CATEGORY_SCORE_KIND[category]}, ${direction === 'asc' ? 'lower is better' : 'higher is better'}):`,
                '',
                table,
              ];

        return {
          content: [{ type: 'text', text: finishText(body, warnings) }],
          structuredContent: {
            tier: catalog.tier,
            category,
            score_kind: CATEGORY_SCORE_KIND[category],
            score_direction: direction,
            data_as_of: catalog.dataAsOf.toISOString(),
            stale: catalog.stale,
            total_matched: matched.length,
            warnings,
            models: top.map((m) => ({
              name: m.name,
              ...(m.slug !== undefined ? { slug: m.slug } : {}),
              creator: m.creator,
              score_kind: m.score_kind,
              score_value: m.score_value,
              ...(m.ci_95 !== undefined ? { ci_95: m.ci_95 } : {}),
              ...(m.release_date !== undefined ? { release_date: m.release_date } : {}),
              ...(m.is_open_weights !== undefined ? { is_open_weights: m.is_open_weights } : {}),
              price_fields: m.price_fields,
            })),
          },
        };
      }),
  );
}
