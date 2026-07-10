import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppContext } from '../context.js';
import { createMcpServer } from '../server.js';

// stdout принадлежит протоколу MCP: любые логи — только в stderr (см. logger.ts).
export async function startStdio(ctx: AppContext): Promise<void> {
  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  ctx.logger.info('MCP server ready on stdio');
}
