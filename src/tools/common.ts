import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodError } from 'zod';
import { AAApiError } from '../api/errors.js';
import type { NormalizedLlmModel } from '../catalog.js';
import type { AppContext } from '../context.js';
import { finishText, quotaWarning, staleNotice } from '../format.js';

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: finishText([message]) }], isError: true };
}

/** Предупреждение о почти исчерпанной квоте (< 5 оставшихся запросов). */
export function quotaWarningsOnly(ctx: AppContext): string[] {
  const remaining = ctx.client.rateLimit().remaining;
  return remaining !== undefined && remaining < 5 ? [quotaWarning(remaining)] : [];
}

/** Общие предупреждения инструментов: stale-данные и почти исчерпанная квота. */
export function catalogWarnings(ctx: AppContext, stale: boolean, dataAsOf: Date): string[] {
  const warnings: string[] = [];
  if (stale) warnings.push(staleNotice(dataAsOf));
  warnings.push(...quotaWarningsOnly(ctx));
  return warnings;
}

/** AAApiError и невалидная форма ответа AA становятся ошибкой инструмента, не крэшем. */
export async function guardToolErrors(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AAApiError) return errorResult(error.message);
    if (error instanceof ZodError) {
      return errorResult('Artificial Analysis API returned an unexpected response shape.');
    }
    throw error;
  }
}

/** Форма LLM-модели в structuredContent (общая для find/get/compare). */
export const llmModelOutputSchema = z.object({
  name: z.string(),
  slug: z.string(),
  creator: z.string().nullable(),
  release_date: z.string().nullable(),
  intelligence_index: z.number().nullable(),
  coding_index: z.number().nullable(),
  agentic_index: z.number().nullable(),
  price_1m_input: z.number().nullable(),
  price_1m_output: z.number().nullable(),
  price_1m_blended_3_to_1: z.number().nullable().optional(),
  median_output_tps: z.number().nullable(),
  median_ttft_s: z.number().nullable(),
  median_e2e_s: z.number().nullable(),
  reasoning_model: z.boolean().optional(),
  context_window_tokens: z.number().nullable().optional(),
  parameters_b: z.number().nullable().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  is_open_weights: z.boolean().optional(),
  providers: z.array(z.object({ name: z.string(), slug: z.string() })).optional(),
  resolved_from: z.string().optional(),
});

export type LlmModelOutput = z.infer<typeof llmModelOutputSchema>;

export function toLlmOutput(model: NormalizedLlmModel, resolvedFrom?: string): LlmModelOutput {
  const { id: _id, ...rest } = model;
  const output: LlmModelOutput = { ...rest };
  if (resolvedFrom !== undefined) output.resolved_from = resolvedFrom;
  return output;
}
