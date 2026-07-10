import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

const baseEnv = { ARTIFICIAL_ANALYSIS_API_KEY: 'test-key' };

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config).toEqual({
      apiKey: 'test-key',
      baseUrl: 'https://artificialanalysis.ai',
      cacheTtlSeconds: 21600,
      requestTimeoutMs: 30000,
      transport: 'stdio',
      port: 3000,
      httpHost: '127.0.0.1',
      logLevel: 'info',
    });
  });

  it('reads overrides from env', () => {
    const config = loadConfig({
      ...baseEnv,
      AA_BASE_URL: 'http://localhost:8080',
      AA_CACHE_TTL_SECONDS: '60',
      AA_REQUEST_TIMEOUT_MS: '5000',
      AA_TIER: 'pro',
      MCP_TRANSPORT: 'http',
      PORT: '4001',
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_AUTH_TOKEN: 'secret',
      LOG_LEVEL: 'debug',
    });
    expect(config.baseUrl).toBe('http://localhost:8080');
    expect(config.cacheTtlSeconds).toBe(60);
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.tierOverride).toBe('pro');
    expect(config.transport).toBe('http');
    expect(config.port).toBe(4001);
    expect(config.httpHost).toBe('0.0.0.0');
    expect(config.authToken).toBe('secret');
    expect(config.logLevel).toBe('debug');
  });

  it('rejects a missing or empty API key', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ARTIFICIAL_ANALYSIS_API_KEY: '  ' })).toThrow(
      /ARTIFICIAL_ANALYSIS_API_KEY/,
    );
  });

  it('rejects invalid numbers and enums', () => {
    expect(() => loadConfig({ ...baseEnv, AA_CACHE_TTL_SECONDS: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, PORT: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, MCP_TRANSPORT: 'websocket' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, AA_TIER: 'gold' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });
});

describe('createLogger', () => {
  it('writes to the provided sink, filtering below the level', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (line) => lines.push(line));
    logger.debug('hidden');
    logger.info('hidden too');
    logger.warn('careful');
    logger.error('boom', { code: 500 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('careful');
    expect(lines[0]).toContain('[warn]');
    expect(lines[1]).toContain('boom');
    expect(lines[1]).toContain('"code":500');
  });
});
