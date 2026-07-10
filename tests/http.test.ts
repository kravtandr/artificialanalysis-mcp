import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createAppContext } from '../src/context.js';
import { createLogger } from '../src/logger.js';
import { startHttp } from '../src/transport/http.js';

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function start(env: Record<string, string> = {}): Promise<{ base: string; logs: string[] }> {
  const logs: string[] = [];
  const config = loadConfig({
    ARTIFICIAL_ANALYSIS_API_KEY: 'sk-test',
    MCP_TRANSPORT: 'http',
    PORT: '1', // заменяется на случайный порт ниже
    AA_TIER: 'free',
    ...env,
  });
  // Случайный свободный порт, чтобы тесты не конфликтовали
  config.port = 0;
  const ctx = createAppContext(config, {
    logger: createLogger('debug', (line) => logs.push(line)),
  });
  server = await startHttp(ctx);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, logs };
}

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
});

const mcpHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

describe('HTTP transport', () => {
  it('serves /healthz without auth', async () => {
    const { base } = await start({ MCP_AUTH_TOKEN: 'secret' });
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  it('answers an initialize POST on /mcp in stateless mode', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: initializeBody,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { serverInfo: { name: string }; instructions?: string };
    };
    expect(body.result.serverInfo.name).toBe('artificialanalysis-mcp');
  });

  it('requires a Bearer token when MCP_AUTH_TOKEN is set', async () => {
    const { base } = await start({ MCP_AUTH_TOKEN: 'secret-token' });
    const noAuth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: initializeBody,
    });
    expect(noAuth.status).toBe(401);
    const wrong = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, authorization: 'Bearer wrong-token1' },
      body: initializeBody,
    });
    expect(wrong.status).toBe(401);
    const right = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, authorization: 'Bearer secret-token' },
      body: initializeBody,
    });
    expect(right.status).toBe(200);
  });

  it('rejects non-local Origin with 403 (DNS rebinding protection)', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, origin: 'https://evil.example.com' },
      body: initializeBody,
    });
    expect(res.status).toBe(403);
    const local = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, origin: 'http://localhost:3000' },
      body: initializeBody,
    });
    expect(local.status).toBe(200);
  });

  it('returns 404 for unknown paths and 405 for GET /mcp', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it('loudly warns when bound to a non-loopback host without a token', async () => {
    const { logs } = await start({ MCP_HTTP_HOST: '0.0.0.0' });
    expect(logs.join('\n')).toContain('WITHOUT MCP_AUTH_TOKEN');
  });
});
