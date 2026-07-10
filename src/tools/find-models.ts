import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { finishText, fmtNum, fmtUsd, mdTable } from '../format.js';
import { defaultOrder, filterLlm, sortLlm, type LlmFilters } from '../match.js';
import { catalogWarnings, guardToolErrors, llmModelOutputSchema, toLlmOutput } from './common.js';

const inputSchema = {
  query: z
    .string()
    .optional()
    .describe('Case-insensitive substring matched against model name, slug and creator.'),
  min_intelligence_index: z
    .number()
    .optional()
    .describe('Minimum Artificial Analysis Intelligence Index (composite capability score).'),
  min_coding_index: z.number().optional().describe('Minimum Artificial Analysis Coding Index.'),
  min_agentic_index: z.number().optional().describe('Minimum Artificial Analysis Agentic Index.'),
  max_price_input_per_1m: z
    .number()
    .optional()
    .describe('Maximum USD price per 1M input tokens. Models with unknown price are excluded.'),
  max_price_output_per_1m: z
    .number()
    .optional()
    .describe('Maximum USD price per 1M output tokens. Models with unknown price are excluded.'),
  min_output_tokens_per_second: z
    .number()
    .optional()
    .describe('Minimum median output speed in tokens per second.'),
  max_time_to_first_token_seconds: z
    .number()
    .optional()
    .describe('Maximum median time to first token (TTFT) in seconds.'),
  creators: z
    .array(z.string())
    .optional()
    .describe('Only models by these creators, e.g. ["OpenAI", "Meta"]. Case-insensitive.'),
  released_after: z
    .string()
    .optional()
    .describe('ISO date (YYYY-MM-DD); only models released strictly after this date.'),
  open_weights_only: z
    .boolean()
    .optional()
    .describe(
      'Only open-weights models. Requires a Pro-tier API key; ignored (with a warning) on Free.',
    ),
  reasoning_only: z
    .boolean()
    .optional()
    .describe(
      'Only reasoning models. Requires a Pro-tier API key; ignored (with a warning) on Free.',
    ),
  min_context_window_tokens: z
    .number()
    .optional()
    .describe(
      'Minimum context window in tokens. Requires a Pro-tier API key; ignored (with a warning) on Free.',
    ),
  input_modalities: z
    .array(z.enum(['text', 'image', 'video', 'speech']))
    .optional()
    .describe(
      'Model must accept ALL listed input modalities. Requires a Pro-tier API key; ignored (with a warning) on Free.',
    ),
  sort_by: z
    .enum([
      'intelligence_index',
      'coding_index',
      'agentic_index',
      'price_input',
      'price_output',
      'output_speed',
      'ttft',
      'release_date',
      'best_value',
    ])
    .default('intelligence_index')
    .describe(
      'Sort metric. best_value = intelligence_index divided by price (blended on Pro, else input/output average).',
    ),
  order: z
    .enum(['asc', 'desc'])
    .optional()
    .describe(
      'Sort direction. Defaults to the sensible direction for the metric (prices/TTFT ascending, scores descending).',
    ),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum models to return (1-50).'),
};

const outputSchema = {
  tier: z.string(),
  intelligence_index_version: z.number(),
  data_as_of: z.string(),
  stale: z.boolean(),
  total_matched: z.number(),
  unsupported_filters: z.array(z.string()),
  warnings: z.array(z.string()),
  models: z.array(llmModelOutputSchema),
};

export function registerFindModels(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'find_models',
    {
      title: 'Find LLMs by filters',
      description:
        'Search and rank LLMs from Artificial Analysis benchmarks by intelligence/coding/agentic indices, price, speed, creator and more. All filters are optional; results are served from a local cache of the full catalog.',
      inputSchema,
      outputSchema,
    },
    async (args) =>
      guardToolErrors(async () => {
        const { sort_by, order, limit, ...filters } = args;
        const catalog = await ctx.catalog.getLlm();
        const { matched, unsupportedFilters } = filterLlm(
          catalog.models,
          filters as LlmFilters,
          catalog.tier,
        );
        const sorted = sortLlm(matched, sort_by, order);
        const top = sorted.slice(0, limit);

        const warnings = catalogWarnings(ctx, catalog.stale, catalog.dataAsOf);
        if (unsupportedFilters.length > 0) {
          warnings.push(
            `Filters not applied on the ${catalog.tier} tier (Pro-only data): ${unsupportedFilters.join(', ')}. Results are returned without them.`,
          );
        }

        const effectiveOrder = order ?? defaultOrder(sort_by);
        const table = mdTable(
          [
            'Model',
            'Creator',
            'Intel',
            'Coding',
            'Agentic',
            '$/1M in',
            '$/1M out',
            'TPS',
            'TTFT s',
          ],
          top.map((m) => [
            `${m.name} (\`${m.slug}\`)`,
            m.creator ?? '—',
            fmtNum(m.intelligence_index, 1),
            fmtNum(m.coding_index, 1),
            fmtNum(m.agentic_index, 1),
            fmtUsd(m.price_1m_input),
            fmtUsd(m.price_1m_output),
            fmtNum(m.median_output_tps, 0),
            fmtNum(m.median_ttft_s),
          ]),
        );
        const body =
          top.length === 0
            ? ['No models match the given filters. Try relaxing thresholds.']
            : [
                `${top.length} of ${matched.length} matching models, sorted by ${sort_by} (${effectiveOrder}):`,
                '',
                table,
              ];

        return {
          content: [{ type: 'text', text: finishText(body, warnings) }],
          structuredContent: {
            tier: catalog.tier,
            intelligence_index_version: catalog.intelligenceIndexVersion,
            data_as_of: catalog.dataAsOf.toISOString(),
            stale: catalog.stale,
            total_matched: matched.length,
            unsupported_filters: unsupportedFilters,
            warnings,
            models: top.map((m) => toLlmOutput(m)),
          },
        };
      }),
  );
}
