import { AAClient } from './api/client.js';
import { TtlCache } from './cache.js';
import { Catalog } from './catalog.js';
import type { AppConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';

/**
 * Синглтоны уровня процесса (SPEC.md §3.4): AAClient (тариф, квота), кэш и каталог
 * создаются один раз при старте. В stateless-HTTP-режиме SDK создаёт server/transport
 * на каждый POST — request-scoped только MCP-обвязка, иначе каждый запрос заново
 * определял бы тариф и грел каталог, сжигая квоту.
 */
export interface AppContext {
  config: AppConfig;
  logger: Logger;
  client: AAClient;
  cache: TtlCache;
  catalog: Catalog;
}

export function createAppContext(
  config: AppConfig,
  overrides: { logger?: Logger; fetchImpl?: typeof fetch; now?: () => number } = {},
): AppContext {
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const client = new AAClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeoutMs: config.requestTimeoutMs,
    logger,
    ...(config.tierOverride ? { tierOverride: config.tierOverride } : {}),
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  const cache = new TtlCache(config.cacheTtlSeconds, overrides.now);
  const catalog = new Catalog(client, cache);
  return { config, logger, client, cache, catalog };
}
