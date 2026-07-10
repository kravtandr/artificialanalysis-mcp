import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NormalizedLlmModel } from '../catalog.js';
import type { AppContext } from '../context.js';
import { finishText, fmtBool, fmtNum, fmtUsd, mdTable } from '../format.js';
import { resolveModel } from '../match.js';
import {
  catalogWarnings,
  errorResult,
  guardToolErrors,
  llmModelOutputSchema,
  toLlmOutput,
} from './common.js';

const inputSchema = {
  models: z
    .array(z.string())
    .min(2)
    .max(5)
    .describe('2-5 model slugs or (approximate) names to compare side by side.'),
};

const outputSchema = {
  tier: z.string(),
  data_as_of: z.string(),
  stale: z.boolean(),
  warnings: z.array(z.string()),
  models: z.array(llmModelOutputSchema),
};

function comparisonTable(models: NormalizedLlmModel[]): string {
  const metric = (label: string, cell: (m: NormalizedLlmModel) => string): string[] => [
    label,
    ...models.map(cell),
  ];
  const rows: string[][] = [
    metric('Creator', (m) => m.creator ?? '—'),
    metric('Release date', (m) => m.release_date ?? '—'),
    metric('Intelligence Index', (m) => fmtNum(m.intelligence_index, 1)),
    metric('Coding Index', (m) => fmtNum(m.coding_index, 1)),
    metric('Agentic Index', (m) => fmtNum(m.agentic_index, 1)),
    metric('Price $/1M input', (m) => fmtUsd(m.price_1m_input)),
    metric('Price $/1M output', (m) => fmtUsd(m.price_1m_output)),
    metric('Median output tokens/s', (m) => fmtNum(m.median_output_tps, 0)),
    metric('Median TTFT s', (m) => fmtNum(m.median_ttft_s)),
    metric('Median end-to-end s', (m) => fmtNum(m.median_e2e_s)),
  ];
  if (models.some((m) => m.context_window_tokens !== undefined)) {
    rows.push(metric('Context window tokens', (m) => fmtNum(m.context_window_tokens, 0)));
  }
  if (models.some((m) => m.input_modalities !== undefined)) {
    rows.push(metric('Input modalities', (m) => m.input_modalities?.join(', ') ?? '—'));
  }
  if (models.some((m) => m.is_open_weights !== undefined)) {
    rows.push(metric('Open weights', (m) => fmtBool(m.is_open_weights)));
  }
  return mdTable(['Metric', ...models.map((m) => m.name)], rows);
}

export function registerCompareModels(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'compare_models',
    {
      title: 'Compare LLMs',
      description:
        'Side-by-side comparison of 2-5 LLMs across indices, pricing and performance. Names are resolved fuzzily; unresolved names are reported in warnings.',
      inputSchema,
      outputSchema,
    },
    async ({ models: queries }) =>
      guardToolErrors(async () => {
        const catalog = await ctx.catalog.getLlm();

        const resolvedModels: Array<{ model: NormalizedLlmModel; resolvedFrom?: string }> = [];
        const problems: string[] = [];
        for (const query of queries) {
          const result = resolveModel(query, catalog.models);
          if (result.kind === 'resolved') {
            if (resolvedModels.some((r) => r.model.slug === result.model.slug)) {
              problems.push(
                `"${query}" resolves to ${result.model.slug}, already in the comparison.`,
              );
            } else {
              resolvedModels.push(
                result.resolvedFrom !== undefined
                  ? { model: result.model, resolvedFrom: result.resolvedFrom }
                  : { model: result.model },
              );
            }
          } else if (result.kind === 'ambiguous') {
            const options = result.candidates
              .slice(0, 5)
              .map((c) => `${c.name} (\`${c.slug}\`)`)
              .join(', ');
            problems.push(`"${query}" is ambiguous; candidates: ${options}.`);
          } else {
            problems.push(`"${query}" not found in the catalog.`);
          }
        }

        if (resolvedModels.length < 2) {
          return errorResult(
            [
              'Could not confidently resolve at least 2 models to compare:',
              ...problems.map((p) => `- ${p}`),
              'Specify exact slugs (see find_models).',
            ].join('\n'),
          );
        }

        const warnings = [...catalogWarnings(ctx, catalog.stale, catalog.dataAsOf), ...problems];
        const models = resolvedModels.map((r) => r.model);
        const body = [
          `Comparing ${models.map((m) => m.name).join(' vs ')}:`,
          '',
          comparisonTable(models),
        ];

        return {
          content: [{ type: 'text', text: finishText(body, warnings) }],
          structuredContent: {
            tier: catalog.tier,
            data_as_of: catalog.dataAsOf.toISOString(),
            stale: catalog.stale,
            warnings,
            models: resolvedModels.map((r) => toLlmOutput(r.model, r.resolvedFrom)),
          },
        };
      }),
  );
}
