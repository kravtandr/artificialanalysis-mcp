import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MockAgent, fetch as undiciFetch } from 'undici';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createAppContext, type AppContext } from '../src/context.js';
import { ATTRIBUTION } from '../src/format.js';
import { createLogger } from '../src/logger.js';
import { createMcpServer } from '../src/server.js';
import { fixture } from './helpers.js';

const BASE = 'https://aa.test';

const hdrs = (extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  'x-ratelimit-limit': '100',
  'x-ratelimit-remaining': '90',
  'x-ratelimit-reset': '1767100800',
  ...extra,
});

function setup(env: Record<string, string> = {}, now?: () => number) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const fetchImpl = ((
    input: Parameters<typeof undiciFetch>[0],
    init?: Parameters<typeof undiciFetch>[1],
  ) => undiciFetch(input, { ...init, dispatcher: agent })) as unknown as typeof fetch;
  const config = loadConfig({ ARTIFICIAL_ANALYSIS_API_KEY: 'sk-test', AA_BASE_URL: BASE, ...env });
  const ctx = createAppContext(config, {
    logger: createLogger('error', () => undefined),
    fetchImpl,
    ...(now ? { now } : {}),
  });
  return { agent, ctx };
}

async function connect(ctx: AppContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function text(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

function mockLlmFreeCatalog(agent: MockAgent, tierHeader = 'free') {
  agent
    .get(BASE)
    .intercept({ path: '/api/v2/language/models/free', query: { page: '1' }, method: 'GET' })
    .reply(200, fixture('llm-free-page1') as object, {
      headers: hdrs({ 'x-aa-tier': tierHeader }),
    });
  agent
    .get(BASE)
    .intercept({ path: '/api/v2/language/models/free', query: { page: '2' }, method: 'GET' })
    .reply(200, fixture('llm-free-page2') as object, {
      headers: hdrs({ 'x-aa-tier': tierHeader }),
    });
}

describe('tools/list', () => {
  it('exposes exactly the five specified tools', async () => {
    const { ctx } = setup({ AA_TIER: 'free' });
    const client = await connect(ctx);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compare_models',
      'find_models',
      'get_api_status',
      'get_model',
      'list_media_models',
    ]);
  });
});

describe('find_models', () => {
  it('filters, sorts and returns markdown plus structuredContent with attribution', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);

    const result = await call(client, 'find_models', {
      min_intelligence_index: 40,
      sort_by: 'intelligence_index',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      tier: string;
      total_matched: number;
      stale: boolean;
      intelligence_index_version: number;
      models: Array<{ slug: string }>;
    };
    expect(structured.tier).toBe('free');
    expect(structured.intelligence_index_version).toBe(4.1);
    expect(structured.stale).toBe(false);
    expect(structured.total_matched).toBe(3);
    expect(structured.models.map((m) => m.slug)).toEqual([
      'claude-sonnet-5',
      'deepseek-v4',
      'kimi-k2',
    ]);
    expect(text(result).trim().split('\n').at(-1)).toBe(ATTRIBUTION);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('returns an empty result gracefully', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);
    const result = await call(client, 'find_models', { min_intelligence_index: 99 });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { total_matched: number }).total_matched).toBe(0);
    expect(text(result)).toContain('No models match');
  });

  it('reports pro filters as unsupported on the free tier instead of applying them silently', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);
    const result = await call(client, 'find_models', { reasoning_only: true, limit: 50 });
    const structured = result.structuredContent as {
      unsupported_filters: string[];
      total_matched: number;
    };
    expect(structured.unsupported_filters).toEqual(['reasoning_only']);
    expect(structured.total_matched).toBe(6);
    expect(text(result)).toContain('reasoning_only');
  });

  it('coalesces two concurrent cold-cache calls into a single catalog fetch', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent); // каждый интерсептор строго на 1 запрос
    const client = await connect(ctx);
    const [a, b] = await Promise.all([
      call(client, 'find_models', {}),
      call(client, 'find_models', { sort_by: 'price_input' }),
    ]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('serves a stale snapshot with a warning when refresh hits 429 after TTL expiry', async () => {
    let now = 0;
    const { agent, ctx } = setup({}, () => now);
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);
    await call(client, 'find_models', {});

    now = 22_000_000; // за пределами TTL 21600 c
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/language/models/free', query: { page: '1' }, method: 'GET' })
      .reply(429, { error: 'rate limited' }, { headers: hdrs() });

    const result = await call(client, 'find_models', {});
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { stale: boolean; data_as_of: string };
    expect(structured.stale).toBe(true);
    expect(structured.data_as_of).toBe(new Date(0).toISOString());
    expect(text(result)).toContain('serving cached data');
  });

  it('surfaces 429 as a tool error when there is no stale copy', async () => {
    const { agent, ctx } = setup();
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/language/models/free', query: { page: '1' }, method: 'GET' })
      .reply(429, { error: 'rate limited' }, { headers: hdrs() });
    const client = await connect(ctx);
    const result = await call(client, 'find_models', {});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('quota');
    expect(text(result)).toContain('resets at');
  });

  it('surfaces 401 as a clear key error', async () => {
    const { agent, ctx } = setup();
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/language/models/free', query: { page: '1' }, method: 'GET' })
      .reply(401, { error: 'unauthorized' });
    const client = await connect(ctx);
    const result = await call(client, 'find_models', {});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('ARTIFICIAL_ANALYSIS_API_KEY');
  });
});

describe('get_model', () => {
  it('returns candidates for an ambiguous query as a normal response', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);
    const result = await call(client, 'get_model', { model: 'gpt oss' });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      candidates: Array<{ slug: string }>;
      model?: unknown;
    };
    expect(structured.model).toBeUndefined();
    expect(structured.candidates.map((c) => c.slug)).toEqual(['gpt-oss-120b', 'gpt-oss-20b']);
    expect(text(result)).toContain('several models');
  });

  it('resolves a fuzzy name and marks resolved_from; free tier stays on the cached list entry', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);
    const result = await call(client, 'get_model', { model: 'sonnet' });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      model: { slug: string; resolved_from?: string };
    };
    expect(structured.model.slug).toBe('claude-sonnet-5');
    expect(structured.model.resolved_from).toBe('sonnet');
    expect(agent.pendingInterceptors()).toHaveLength(0); // detail-эндпоинт не вызывался
  });

  it('errors with a find_models hint when nothing matches', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);
    const result = await call(client, 'get_model', { model: 'grok-17' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('find_models');
  });

  it('fetches the detail card with providers on pro+', async () => {
    const { agent, ctx } = setup({ AA_TIER: 'pro' });
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/language/models', query: { page: '1' }, method: 'GET' })
      .reply(200, fixture('llm-pro-page1') as object, { headers: hdrs({ 'x-aa-tier': 'pro' }) });
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/language/models/gpt-oss-20b', method: 'GET' })
      .reply(200, fixture('llm-detail') as object, { headers: hdrs({ 'x-aa-tier': 'pro' }) });
    const client = await connect(ctx);
    const result = await call(client, 'get_model', { model: 'gpt-oss-20b' });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      model: { providers?: Array<{ name: string }> };
    };
    expect(structured.model.providers).toEqual([{ name: 'Groq', slug: 'groq' }]);
    expect(text(result)).toContain('Groq');
  });
});

describe('compare_models', () => {
  it('builds a metric × model table for resolved models', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);
    const result = await call(client, 'compare_models', {
      models: ['gpt-oss-20b', 'claude sonnet 5'],
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { models: Array<{ slug: string }> };
    expect(structured.models.map((m) => m.slug)).toEqual(['gpt-oss-20b', 'claude-sonnet-5']);
    expect(text(result)).toContain('| Metric |');
    expect(text(result)).toContain('Intelligence Index');
  });

  it('compares the resolved subset and lists unresolved names in warnings', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);
    const result = await call(client, 'compare_models', {
      models: ['gpt-oss-20b', 'kimi', 'grok-17'],
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      models: Array<{ slug: string }>;
      warnings: string[];
    };
    expect(structured.models.map((m) => m.slug)).toEqual(['gpt-oss-20b', 'kimi-k2']);
    expect(structured.warnings.join(' ')).toContain('grok-17');
  });

  it('errors when fewer than 2 models resolve, listing candidates of ambiguous names', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);
    const result = await call(client, 'compare_models', { models: ['grok-17', 'gpt oss'] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('grok-17');
    expect(text(result)).toContain('gpt-oss-120b');
    expect(text(result)).toContain('gpt-oss-20b');
  });
});

describe('list_media_models', () => {
  it('ranks speech-to-speech by the first available score without Elo', async () => {
    const { agent, ctx } = setup({ AA_TIER: 'free' });
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/media/speech-to-speech/models/free', method: 'GET' })
      .reply(200, fixture('media-speech-to-speech-free') as object, { headers: hdrs() });
    const client = await connect(ctx);
    const result = await call(client, 'list_media_models', { category: 'speech-to-speech' });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      models: Array<{ name: string; score_kind: string; score_value: number | null }>;
    };
    expect(structured.models.map((m) => m.score_kind)).toEqual([
      'bba_score',
      'tau_voice_score',
      'tau_voice_score',
    ]);
    expect(structured.models.at(-1)!.score_value).toBeNull();
  });

  it('ranks speech-to-text by WER ascending; models have no slug', async () => {
    const { agent, ctx } = setup({ AA_TIER: 'free' });
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/media/speech-to-text/models/free', method: 'GET' })
      .reply(200, fixture('media-speech-to-text-free') as object, { headers: hdrs() });
    const client = await connect(ctx);
    const result = await call(client, 'list_media_models', { category: 'speech-to-text' });
    const structured = result.structuredContent as {
      score_kind: string;
      score_direction: string;
      models: Array<{ name: string; slug?: string }>;
    };
    expect(structured.score_kind).toBe('aa_wer_index');
    expect(structured.score_direction).toBe('asc');
    expect(structured.models.map((m) => m.name)).toEqual([
      'Universal-3',
      'Whisper Large v4',
      'Scribe Unmeasured',
    ]);
    expect(structured.models[0]!.slug).toBeUndefined();
    expect(text(result)).toContain('lower is better');
  });

  it('lists music models (no slug) via the nested music path', async () => {
    const { agent, ctx } = setup({ AA_TIER: 'free' });
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/media/music/instrumental/models/free', method: 'GET' })
      .reply(200, fixture('media-music-instrumental-free') as object, { headers: hdrs() });
    const client = await connect(ctx);
    const result = await call(client, 'list_media_models', { category: 'music-instrumental' });
    const structured = result.structuredContent as { models: Array<{ slug?: string }> };
    expect(structured.models[0]!.slug).toBeUndefined();
    expect(text(result)).toContain('Suno v5');
  });

  it('falls back to /free when the full endpoint returns 403 on a pro-claimed key', async () => {
    const { agent, ctx } = setup({ AA_TIER: 'pro' });
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/media/text-to-image/models', method: 'GET' })
      .reply(403, { error: 'forbidden' }, { headers: hdrs({ 'x-aa-tier': 'free' }) });
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/media/text-to-image/models/free', method: 'GET' })
      .reply(200, fixture('media-text-to-image-free') as object, { headers: hdrs() });
    const client = await connect(ctx);
    const result = await call(client, 'list_media_models', { category: 'text-to-image' });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('GPT Image 2'); // лучший Elo — первым
  });

  it('filters by query and respects limit', async () => {
    const { agent, ctx } = setup({ AA_TIER: 'free' });
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/media/text-to-image/models/free', method: 'GET' })
      .reply(200, fixture('media-text-to-image-free') as object, { headers: hdrs() });
    const client = await connect(ctx);
    const result = await call(client, 'list_media_models', {
      category: 'text-to-image',
      query: 'openai',
      limit: 1,
    });
    const structured = result.structuredContent as { models: Array<{ name: string }> };
    expect(structured.models).toEqual([
      expect.objectContaining({ name: 'GPT Image 2' }) as unknown,
    ]);
  });
});

describe('get_api_status', () => {
  it('spends one request to detect the tier on a cold start and says so', async () => {
    const { agent, ctx } = setup();
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/language/models/free', query: { page: '1' }, method: 'GET' })
      .reply(200, fixture('llm-free-page1') as object, { headers: hdrs({ 'x-aa-tier': 'free' }) });
    const client = await connect(ctx);
    const result = await call(client, 'get_api_status');
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      tier: string;
      warnings: string[];
      rate_limit: { remaining: number | null };
      intelligence_index_version: number | null;
    };
    expect(structured.tier).toBe('free');
    expect(structured.warnings.join(' ')).toContain('one API request');
    expect(structured.rate_limit.remaining).toBe(90);
    expect(structured.intelligence_index_version).toBeNull();
  });

  it('spends no quota when the tier is already known and reports cache state', async () => {
    const { agent, ctx } = setup();
    mockLlmFreeCatalog(agent);
    const client = await connect(ctx);
    await call(client, 'find_models', {});
    const result = await call(client, 'get_api_status');
    const structured = result.structuredContent as {
      tier: string;
      warnings: string[];
      cache: Array<{ key: string; stale: boolean }>;
      intelligence_index_version: number | null;
    };
    expect(structured.tier).toBe('free');
    expect(structured.warnings).toEqual([]);
    expect(structured.cache).toEqual([{ key: 'llm', age_seconds: 0, stale: false }]);
    expect(structured.intelligence_index_version).toBe(4.1);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });
});
