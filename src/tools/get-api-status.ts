import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { finishText, fmtNum, mdTable } from '../format.js';
import type { LlmCatalogResult } from '../catalog.js';
import { guardToolErrors, quotaWarningsOnly } from './common.js';

const outputSchema = {
  tier: z.string(),
  intelligence_index_version: z
    .number()
    .nullable()
    .describe('Null until the LLM catalog has been fetched at least once.'),
  rate_limit: z.object({
    limit: z.number().nullable(),
    remaining: z.number().nullable(),
    reset_at: z.string().nullable(),
  }),
  cache: z.array(z.object({ key: z.string(), age_seconds: z.number(), stale: z.boolean() })),
  warnings: z.array(z.string()),
};

export function registerGetApiStatus(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'get_api_status',
    {
      title: 'API status and quota',
      description:
        'Diagnostics: API key tier, Intelligence Index version, remaining daily request quota and cache freshness. Does not spend quota unless the tier is not known yet (cold start).',
      inputSchema: {},
      outputSchema,
    },
    async () =>
      guardToolErrors(async () => {
        const warnings: string[] = [];
        let tier = ctx.client.tierIfKnown;
        if (tier === undefined) {
          // Холодный старт: определение тарифа стоит один запрос — это отражается явно.
          tier = await ctx.client.getTier();
          warnings.push('Tier was not known yet; spent one API request to detect it.');
        }

        const rateLimit = ctx.client.rateLimit();
        warnings.push(...quotaWarningsOnly(ctx));
        const cacheEntries = ctx.cache.inspect();
        const llmSnapshot = ctx.cache.peek<Omit<LlmCatalogResult, 'dataAsOf' | 'stale'>>('llm');
        const iiVersion = llmSnapshot?.value.intelligenceIndexVersion ?? null;

        const body = [
          '# Artificial Analysis API status',
          '',
          mdTable(
            ['Field', 'Value'],
            [
              ['API key tier', tier],
              [
                'Intelligence Index version',
                iiVersion === null ? 'unknown (catalog not fetched yet)' : String(iiVersion),
              ],
              ['Daily quota limit', fmtNum(rateLimit.limit ?? null, 0)],
              ['Requests remaining', fmtNum(rateLimit.remaining ?? null, 0)],
              ['Quota resets at (UTC)', rateLimit.resetAt?.toISOString() ?? '—'],
            ],
          ),
        ];
        if (cacheEntries.length > 0) {
          body.push(
            '',
            'Cache:',
            '',
            mdTable(
              ['Key', 'Age (s)', 'Stale'],
              cacheEntries.map((e) => [e.key, String(e.ageSeconds), e.stale ? 'yes' : 'no']),
            ),
          );
        } else {
          body.push('', 'Cache: empty (no categories fetched yet).');
        }

        return {
          content: [{ type: 'text', text: finishText(body, warnings) }],
          structuredContent: {
            tier,
            intelligence_index_version: iiVersion,
            rate_limit: {
              limit: rateLimit.limit ?? null,
              remaining: rateLimit.remaining ?? null,
              reset_at: rateLimit.resetAt?.toISOString() ?? null,
            },
            cache: cacheEntries.map((e) => ({
              key: e.key,
              age_seconds: e.ageSeconds,
              stale: e.stale,
            })),
            warnings,
          },
        };
      }),
  );
}
