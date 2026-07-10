import { MockAgent, fetch as undiciFetch } from 'undici';
import { describe, expect, it } from 'vitest';
import { AAClient } from '../src/api/client.js';
import { AAApiError } from '../src/api/errors.js';
import { createLogger } from '../src/logger.js';

const BASE = 'https://aa.test';
const API_KEY = 'sk-secret-test-key-123';

function makeAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

function mockFetch(agent: MockAgent): typeof fetch {
  return ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...init, dispatcher: agent })) as unknown as typeof fetch;
}

function makeClient(
  agent: MockAgent,
  opts: Partial<ConstructorParameters<typeof AAClient>[0]> = {},
) {
  return new AAClient({
    apiKey: API_KEY,
    baseUrl: BASE,
    timeoutMs: 5000,
    logger: createLogger('error', () => undefined),
    fetchImpl: mockFetch(agent),
    retryDelayMs: 0,
    ...opts,
  });
}

const freePage = { tier: 'free', data: [{ marker: 'seed' }] };
const jsonHeaders = (extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  'x-ratelimit-limit': '100',
  'x-ratelimit-remaining': '90',
  'x-ratelimit-reset': '1767100800',
  ...extra,
});

describe('AAClient tier detection', () => {
  it('detects the tier from X-AA-Tier and keeps page 1 as a consumable seed', async () => {
    const agent = makeAgent();
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/language/models/free', query: { page: '1' }, method: 'GET' })
      .reply(200, freePage, { headers: jsonHeaders({ 'x-aa-tier': 'free' }) });
    const client = makeClient(agent);

    await expect(client.getTier()).resolves.toBe('free');
    // seed отдаётся без второго сетевого запроса — незамоканный запрос бросил бы ошибку
    const page1 = await client.getCategoryPage('llm', 1);
    expect(page1).toEqual(freePage);
    expect(client.tierIfKnown).toBe('free');
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });

  it('deduplicates concurrent tier probes into one request', async () => {
    const agent = makeAgent();
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/language/models/free', query: { page: '1' }, method: 'GET' })
      .reply(200, freePage, { headers: jsonHeaders({ 'x-aa-tier': 'pro' }) });
    const client = makeClient(agent);
    const [a, b] = await Promise.all([client.getTier(), client.getTier()]);
    expect(a).toBe('pro');
    expect(b).toBe('pro');
  });

  it('honours the AA_TIER override without any network call', async () => {
    const agent = makeAgent(); // без интерсепторов: любой запрос упал бы
    const client = makeClient(agent, { tierOverride: 'pro' });
    await expect(client.getTier()).resolves.toBe('pro');
  });

  it('assumes free and warns when the header is missing', async () => {
    const agent = makeAgent();
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/language/models/free', query: { page: '1' }, method: 'GET' })
      .reply(200, freePage, { headers: jsonHeaders() });
    const warnings: string[] = [];
    const client = makeClient(agent, {
      logger: createLogger('warn', (line) => warnings.push(line)),
    });
    await expect(client.getTier()).resolves.toBe('free');
    expect(warnings.join('\n')).toContain('assuming free');
  });
});

describe('AAClient routing', () => {
  it('uses the full endpoint on pro tier', async () => {
    const agent = makeAgent();
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/language/models', query: { page: '1' }, method: 'GET' })
      .reply(200, { tier: 'pro' }, { headers: jsonHeaders({ 'x-aa-tier': 'pro' }) });
    const client = makeClient(agent, { tierOverride: 'pro' });
    await expect(client.getCategoryPage('llm', 1)).resolves.toEqual({ tier: 'pro' });
  });

  it('falls back to /free on unexpected 403 and downgrades the cached tier', async () => {
    const agent = makeAgent();
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/media/text-to-image/models', method: 'GET' })
      .reply(403, { error: 'forbidden' }, { headers: jsonHeaders({ 'x-aa-tier': 'pro' }) });
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/media/text-to-image/models/free', method: 'GET' })
      .reply(200, { tier: 'free', data: [] }, { headers: jsonHeaders({ 'x-aa-tier': 'free' }) });
    const client = makeClient(agent, { tierOverride: 'pro' });
    await expect(client.getCategoryPage('text-to-image')).resolves.toEqual({
      tier: 'free',
      data: [],
    });
    expect(client.tierIfKnown).toBe('free');
  });

  it('maps nested music categories to their nested paths', async () => {
    const agent = makeAgent();
    agent
      .get(BASE)
      .intercept({ path: '/api/v2/media/music/with-vocals/models/free', method: 'GET' })
      .reply(200, { tier: 'free', data: [] }, { headers: jsonHeaders() });
    const client = makeClient(agent, { tierOverride: 'free' });
    await expect(client.getCategoryPage('music-with-vocals')).resolves.toEqual({
      tier: 'free',
      data: [],
    });
  });
});

describe('AAClient error classification', () => {
  it('maps 401 to an auth error mentioning the env var but never the key', async () => {
    const agent = makeAgent();
    agent.get(BASE).intercept({ path: '/x', method: 'GET' }).reply(401, { error: 'unauthorized' });
    const client = makeClient(agent);
    const error = await client.getJson('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AAApiError);
    expect((error as AAApiError).kind).toBe('auth');
    expect((error as AAApiError).message).toContain('ARTIFICIAL_ANALYSIS_API_KEY');
    expect((error as AAApiError).message).not.toContain(API_KEY);
  });

  it('maps 429 to rate_limited with resetAt from X-RateLimit-Reset', async () => {
    const agent = makeAgent();
    agent
      .get(BASE)
      .intercept({ path: '/x', method: 'GET' })
      .reply(429, { error: 'rate limited' }, { headers: jsonHeaders() });
    const client = makeClient(agent);
    const error = (await client.getJson('/x').catch((e: unknown) => e)) as AAApiError;
    expect(error.kind).toBe('rate_limited');
    expect(error.resetAt).toEqual(new Date(1767100800 * 1000));
    expect(error.message).toContain('resets at');
  });

  it('maps 404 to not_found without retrying', async () => {
    const agent = makeAgent();
    agent.get(BASE).intercept({ path: '/x', method: 'GET' }).reply(404, {});
    const client = makeClient(agent);
    const error = (await client.getJson('/x').catch((e: unknown) => e)) as AAApiError;
    expect(error.kind).toBe('not_found');
  });

  it('retries once on 5xx and succeeds', async () => {
    const agent = makeAgent();
    agent.get(BASE).intercept({ path: '/x', method: 'GET' }).reply(500, {});
    agent
      .get(BASE)
      .intercept({ path: '/x', method: 'GET' })
      .reply(200, { ok: true }, { headers: jsonHeaders() });
    const client = makeClient(agent);
    await expect(client.getJson('/x')).resolves.toEqual({ ok: true });
  });

  it('gives up after the single retry on persistent 5xx', async () => {
    const agent = makeAgent();
    agent.get(BASE).intercept({ path: '/x', method: 'GET' }).reply(502, {}).times(2);
    const client = makeClient(agent);
    const error = (await client.getJson('/x').catch((e: unknown) => e)) as AAApiError;
    expect(error.kind).toBe('server_error');
    expect(error.message).toContain('502');
  });

  it('classifies fetch rejections as network errors after one retry', async () => {
    const agent = makeAgent();
    agent
      .get(BASE)
      .intercept({ path: '/x', method: 'GET' })
      .replyWithError(new Error('socket hang up'))
      .times(2);
    const client = makeClient(agent);
    const error = (await client.getJson('/x').catch((e: unknown) => e)) as AAApiError;
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain(API_KEY);
  });

  it('treats a hung request as a network error via AbortSignal.timeout', async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted due to timeout'));
        });
      });
    const client = new AAClient({
      apiKey: API_KEY,
      baseUrl: BASE,
      timeoutMs: 20,
      logger: createLogger('error', () => undefined),
      fetchImpl: hangingFetch,
      retryDelayMs: 0,
    });
    const error = (await client.getJson('/x').catch((e: unknown) => e)) as AAApiError;
    expect(error.kind).toBe('network');
  }, 10_000);
});

describe('AAClient rate limit tracking', () => {
  it('exposes the latest rate limit headers', async () => {
    const agent = makeAgent();
    agent
      .get(BASE)
      .intercept({ path: '/x', method: 'GET' })
      .reply(
        200,
        { ok: true },
        { headers: jsonHeaders({ 'x-ratelimit-remaining': '3', 'x-aa-tier': 'free' }) },
      );
    const client = makeClient(agent);
    await client.getJson('/x');
    expect(client.rateLimit()).toEqual({
      limit: 100,
      remaining: 3,
      resetAt: new Date(1767100800 * 1000),
    });
    expect(client.tierIfKnown).toBe('free');
  });
});
