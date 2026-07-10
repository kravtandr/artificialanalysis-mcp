import type { Tier } from '../config.js';
import type { Logger } from '../logger.js';
import { AAApiError } from './errors.js';

export type MediaCategory =
  | 'text-to-image'
  | 'image-editing'
  | 'text-to-video'
  | 'image-to-video'
  | 'text-to-video-audio'
  | 'image-to-video-audio'
  | 'text-to-speech'
  | 'speech-to-speech'
  | 'speech-to-text'
  | 'music-instrumental'
  | 'music-with-vocals';

export type CatalogCategory = 'llm' | MediaCategory;

// Пути задаются таблицей, а не конкатенацией: у music они вложенные (SPEC.md §4.4).
const mediaPaths = (segment: string) => ({
  full: `/api/v2/media/${segment}/models`,
  free: `/api/v2/media/${segment}/models/free`,
});

export const CATEGORY_PATHS: Record<CatalogCategory, { full: string; free: string }> = {
  llm: { full: '/api/v2/language/models', free: '/api/v2/language/models/free' },
  'text-to-image': mediaPaths('text-to-image'),
  'image-editing': mediaPaths('image-editing'),
  'text-to-video': mediaPaths('text-to-video'),
  'image-to-video': mediaPaths('image-to-video'),
  'text-to-video-audio': mediaPaths('text-to-video-audio'),
  'image-to-video-audio': mediaPaths('image-to-video-audio'),
  'text-to-speech': mediaPaths('text-to-speech'),
  'speech-to-speech': mediaPaths('speech-to-speech'),
  'speech-to-text': mediaPaths('speech-to-text'),
  'music-instrumental': mediaPaths('music/instrumental'),
  'music-with-vocals': mediaPaths('music/with-vocals'),
};

export interface RateLimitState {
  limit?: number;
  remaining?: number;
  resetAt?: Date;
}

export interface AAClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
  tierOverride?: Tier;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

const TIER_VALUES: readonly Tier[] = ['free', 'pro', 'commercial'];

export class AAClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  private tier?: Tier;
  private tierPromise: Promise<Tier> | undefined;
  private seedFreePage1?: unknown;
  private lastRateLimit: RateLimitState = {};

  constructor(opts: AAClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    if (opts.tierOverride) this.tier = opts.tierOverride;
  }

  get tierIfKnown(): Tier | undefined {
    return this.tier;
  }

  rateLimit(): RateLimitState {
    return { ...this.lastRateLimit };
  }

  /**
   * Тариф определяется лениво первой страницей /language/models/free — она же
   * первая страница прогрева каталога LLM, поэтому тело сохраняется как seed
   * и потребляется getCategoryPage('llm', 1) без повторного запроса.
   */
  async getTier(): Promise<Tier> {
    if (this.tier) return this.tier;
    this.tierPromise ??= this.detectTier().finally(() => {
      this.tierPromise = undefined;
    });
    return this.tierPromise;
  }

  private async detectTier(): Promise<Tier> {
    const body = await this.getJson(CATEGORY_PATHS.llm.free, { page: 1 });
    this.seedFreePage1 = body;
    if (!this.tier) {
      this.logger.warn('X-AA-Tier header missing from tier probe; assuming free tier');
      this.tier = 'free';
    }
    return this.tier;
  }

  takeLlmFreeSeedPage(): unknown {
    const seed = this.seedFreePage1;
    this.seedFreePage1 = undefined;
    return seed;
  }

  /** Tier-aware выбор пути; на неожиданный 403 полного пути — одноразовый фолбэк на /free. */
  async getCategoryPage(category: CatalogCategory, page?: number): Promise<unknown> {
    const tier = await this.getTier();
    const paths = CATEGORY_PATHS[category];
    if (tier === 'free') {
      if (category === 'llm' && (page ?? 1) === 1) {
        const seed = this.takeLlmFreeSeedPage();
        if (seed !== undefined) return seed;
      }
      return this.getJson(paths.free, page !== undefined ? { page } : undefined);
    }
    try {
      return await this.getJson(paths.full, page !== undefined ? { page } : undefined);
    } catch (error) {
      if (error instanceof AAApiError && error.kind === 'forbidden') {
        this.logger.warn(
          `Full endpoint for "${category}" returned 403; downgrading cached tier to free`,
        );
        this.tier = 'free';
        return this.getJson(paths.free, page !== undefined ? { page } : undefined);
      }
      throw error;
    }
  }

  /** GET с таймаутом, одним ретраем 5xx/сети и классификацией ошибок. Ключ в ошибки не попадает. */
  async getJson(path: string, params?: Record<string, string | number>): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(params ?? {})) {
      url.searchParams.set(name, String(value));
    }

    let lastError: AAApiError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await delay(this.retryDelayMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        // Таймаут AbortSignal.timeout приходит сюда же и считается сетевой ошибкой.
        lastError = new AAApiError('network', `Network error requesting ${path}`, { cause });
        continue;
      }

      this.trackHeaders(response);

      if (response.ok) {
        try {
          return await response.json();
        } catch (cause) {
          lastError = new AAApiError('network', `Invalid JSON from ${path}`, { cause });
          continue;
        }
      }

      if (response.status >= 500) {
        lastError = new AAApiError(
          'server_error',
          `Artificial Analysis API error HTTP ${response.status} for ${path}`,
        );
        continue;
      }
      throw this.classifyClientError(response, path);
    }
    throw lastError ?? new AAApiError('network', `Request to ${path} failed`);
  }

  private classifyClientError(response: Response, path: string): AAApiError {
    switch (response.status) {
      case 401:
        return new AAApiError(
          'auth',
          'Invalid or missing ARTIFICIAL_ANALYSIS_API_KEY: the Artificial Analysis API returned HTTP 401.',
        );
      case 403:
        return new AAApiError('forbidden', `Your API key tier does not allow ${path} (HTTP 403).`);
      case 404:
        return new AAApiError('not_found', `Not found: ${path} (HTTP 404).`);
      case 429: {
        const resetAt = this.parseResetAt(response);
        const when = resetAt ? ` Quota resets at ${resetAt.toISOString()}.` : '';
        return new AAApiError('rate_limited', `Daily request quota exhausted (HTTP 429).${when}`, {
          ...(resetAt ? { resetAt } : {}),
        });
      }
      default:
        return new AAApiError(
          'server_error',
          `Unexpected HTTP ${response.status} from Artificial Analysis API for ${path}.`,
        );
    }
  }

  private parseResetAt(response: Response): Date | undefined {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000);
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return new Date(Date.now() + retryAfter * 1000);
    }
    return undefined;
  }

  private trackHeaders(response: Response): void {
    const limit = Number(response.headers.get('x-ratelimit-limit'));
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (response.headers.get('x-ratelimit-limit') !== null && Number.isFinite(limit)) {
      this.lastRateLimit.limit = limit;
    }
    if (response.headers.get('x-ratelimit-remaining') !== null && Number.isFinite(remaining)) {
      this.lastRateLimit.remaining = remaining;
    }
    if (Number.isFinite(reset) && reset > 0) {
      this.lastRateLimit.resetAt = new Date(reset * 1000);
    }
    // X-AA-Tier любого ответа (401 его не несёт) уточняет закэшированный тариф.
    if (response.status !== 401) {
      const headerTier = response.headers.get('x-aa-tier');
      if (headerTier && (TIER_VALUES as readonly string[]).includes(headerTier)) {
        this.tier = headerTier as Tier;
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
