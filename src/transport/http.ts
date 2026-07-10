import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppContext } from '../context.js';
import { createMcpServer } from '../server.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function tokenMatches(header: string | undefined, expectedToken: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  // Сравнение constant-time; timingSafeEqual требует равных длин.
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Защита от DNS rebinding (рекомендация спецификации MCP): чужой Origin → 403. */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleMcpPost(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Stateless-режим SDK: server/transport создаются на каждый POST; всё состояние
  // (тариф, квота, кэш) живёт в ctx — синглтонах уровня процесса (SPEC.md §3.4).
  const server = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function startHttp(ctx: AppContext): Promise<Server> {
  const { config, logger } = ctx;

  if (!isLoopbackHost(config.httpHost) && config.authToken === undefined) {
    logger.warn(
      `SECURITY: HTTP transport is bound to ${config.httpHost} WITHOUT MCP_AUTH_TOKEN. ` +
        'Anyone who can reach this port can spend your Artificial Analysis API quota. ' +
        'Set MCP_AUTH_TOKEN or bind to 127.0.0.1.',
    );
  }

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { status: 'ok' });
        return;
      }

      if (url.pathname === '/mcp') {
        if (!originAllowed(req.headers.origin)) {
          json(res, 403, { error: 'Origin not allowed' });
          return;
        }
        if (
          config.authToken !== undefined &&
          !tokenMatches(req.headers.authorization, config.authToken)
        ) {
          json(res, 401, { error: 'Unauthorized: Bearer token required' });
          return;
        }
        if (req.method === 'POST') {
          await handleMcpPost(ctx, req, res);
          return;
        }
        // Stateless-режим: GET/DELETE сессий не поддерживаются.
        json(res, 405, { error: 'Method not allowed' });
        return;
      }

      json(res, 404, { error: 'Not found' });
    })().catch((error: unknown) => {
      logger.error('HTTP request handling failed', { error: String(error) });
      if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.httpHost, () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : config.port;
      logger.info(`MCP server ready on http://${config.httpHost}:${port}/mcp`);
      resolve(httpServer);
    });
  });
}
