export type Tier = 'free' | 'pro' | 'commercial';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class ConfigError extends Error {}

export interface AppConfig {
  apiKey: string;
  baseUrl: string;
  cacheTtlSeconds: number;
  requestTimeoutMs: number;
  tierOverride?: Tier;
  transport: 'stdio' | 'http';
  port: number;
  httpHost: string;
  authToken?: string;
  logLevel: LogLevel;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function oneOf<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback?: T,
): T | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw as T;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const apiKey = env.ARTIFICIAL_ANALYSIS_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      'ARTIFICIAL_ANALYSIS_API_KEY is required. Get a key at https://artificialanalysis.ai and set it in the environment.',
    );
  }

  const config: AppConfig = {
    apiKey,
    baseUrl: env.AA_BASE_URL?.trim() || 'https://artificialanalysis.ai',
    cacheTtlSeconds: positiveInt(env, 'AA_CACHE_TTL_SECONDS', 21600),
    requestTimeoutMs: positiveInt(env, 'AA_REQUEST_TIMEOUT_MS', 30000),
    transport: oneOf(env, 'MCP_TRANSPORT', ['stdio', 'http'] as const, 'stdio') ?? 'stdio',
    port: positiveInt(env, 'PORT', 3000),
    httpHost: env.MCP_HTTP_HOST?.trim() || '127.0.0.1',
    logLevel:
      oneOf(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info') ?? 'info',
  };

  const tierOverride = oneOf(env, 'AA_TIER', ['free', 'pro', 'commercial'] as const);
  if (tierOverride !== undefined) config.tierOverride = tierOverride;
  const authToken = env.MCP_AUTH_TOKEN;
  if (authToken) config.authToken = authToken;

  return config;
}
