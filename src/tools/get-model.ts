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
  model: z
    .string()
    .describe('Model slug or name; approximate names are resolved fuzzily (e.g. "sonnet 5").'),
};

const outputSchema = {
  tier: z.string(),
  data_as_of: z.string(),
  stale: z.boolean(),
  warnings: z.array(z.string()),
  model: llmModelOutputSchema.optional(),
  candidates: z
    .array(z.object({ name: z.string(), slug: z.string() }))
    .optional()
    .describe('Present when the query was ambiguous; pick one and call again.'),
};

function modelCard(m: NormalizedLlmModel): string {
  const rows: string[][] = [
    ['Creator', m.creator ?? '—'],
    ['Release date', m.release_date ?? '—'],
    ['Intelligence Index', fmtNum(m.intelligence_index, 1)],
    ['Coding Index', fmtNum(m.coding_index, 1)],
    ['Agentic Index', fmtNum(m.agentic_index, 1)],
    ['Price $/1M input', fmtUsd(m.price_1m_input)],
    ['Price $/1M output', fmtUsd(m.price_1m_output)],
  ];
  if (m.price_1m_blended_3_to_1 !== undefined) {
    rows.push(['Price $/1M blended 3:1', fmtUsd(m.price_1m_blended_3_to_1)]);
  }
  rows.push(
    ['Median output tokens/s', fmtNum(m.median_output_tps, 0)],
    ['Median TTFT s', fmtNum(m.median_ttft_s)],
    ['Median end-to-end s', fmtNum(m.median_e2e_s)],
  );
  if (m.reasoning_model !== undefined) rows.push(['Reasoning model', fmtBool(m.reasoning_model)]);
  if (m.context_window_tokens !== undefined) {
    rows.push(['Context window tokens', fmtNum(m.context_window_tokens, 0)]);
  }
  if (m.parameters_b !== undefined) rows.push(['Parameters (B)', fmtNum(m.parameters_b, 0)]);
  if (m.input_modalities !== undefined) {
    rows.push(['Input modalities', m.input_modalities.join(', ') || '—']);
  }
  if (m.output_modalities !== undefined) {
    rows.push(['Output modalities', m.output_modalities.join(', ') || '—']);
  }
  if (m.is_open_weights !== undefined) rows.push(['Open weights', fmtBool(m.is_open_weights)]);
  if (m.providers !== undefined && m.providers.length > 0) {
    rows.push(['Providers', m.providers.map((p) => p.name).join(', ')]);
  }
  return mdTable(['Metric', 'Value'], rows);
}

export function registerGetModel(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'get_model',
    {
      title: 'Get LLM details',
      description:
        'Full benchmark/pricing/performance card for one LLM by slug or (approximate) name. On Pro+ keys the detail endpoint adds extended metadata and providers.',
      inputSchema,
      outputSchema,
    },
    async ({ model }) =>
      guardToolErrors(async () => {
        const catalog = await ctx.catalog.getLlm();
        const resolved = resolveModel(model, catalog.models);

        if (resolved.kind === 'not_found') {
          return errorResult(
            `Model "${model}" not found in the Artificial Analysis catalog. Use the find_models tool to search by capability, price or creator.`,
          );
        }

        if (resolved.kind === 'ambiguous') {
          const candidates = resolved.candidates.map((c) => ({ name: c.name, slug: c.slug }));
          const warnings = catalogWarnings(ctx, catalog.stale, catalog.dataAsOf);
          const body = [
            `"${model}" matches several models. Please call get_model again with one of these slugs:`,
            '',
            mdTable(
              ['Name', 'Slug'],
              candidates.map((c) => [c.name, `\`${c.slug}\``]),
            ),
          ];
          return {
            content: [{ type: 'text', text: finishText(body, warnings) }],
            structuredContent: {
              tier: catalog.tier,
              data_as_of: catalog.dataAsOf.toISOString(),
              stale: catalog.stale,
              warnings,
              candidates,
            },
          };
        }

        // Pro+: detail-эндпоинт с расширенными полями; Free: полная запись из кэша списка.
        let target = resolved.model;
        let dataAsOf = catalog.dataAsOf;
        let stale = catalog.stale;
        const detail = await ctx.catalog.getLlmDetail(resolved.model.slug);
        if (detail !== undefined) {
          target = detail.model;
          dataAsOf = detail.dataAsOf;
          stale = detail.stale;
        }

        const warnings = catalogWarnings(ctx, stale, dataAsOf);
        const body = [`# ${target.name} (\`${target.slug}\`)`];
        if (resolved.resolvedFrom !== undefined) {
          body.push(`Resolved from: "${resolved.resolvedFrom}"`);
        }
        body.push('', modelCard(target));

        return {
          content: [{ type: 'text', text: finishText(body, warnings) }],
          structuredContent: {
            tier: catalog.tier,
            data_as_of: dataAsOf.toISOString(),
            stale,
            warnings,
            model: toLlmOutput(target, resolved.resolvedFrom),
          },
        };
      }),
  );
}
