import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { registerCompareModels } from './tools/compare-models.js';
import { registerFindModels } from './tools/find-models.js';
import { registerGetApiStatus } from './tools/get-api-status.js';
import { registerGetModel } from './tools/get-model.js';
import { registerListMediaModels } from './tools/list-media-models.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const INSTRUCTIONS = `Unofficial MCP server for Artificial Analysis (https://artificialanalysis.ai) AI model benchmarks.
Use find_models to search/rank LLMs by intelligence, price and speed; get_model for one model's card;
compare_models for side-by-side comparison; list_media_models for image/video/speech/music arenas;
get_api_status for tier, quota and cache diagnostics. Data is cached locally (default 6h) to respect
the API's daily request quota. All data belongs to Artificial Analysis; responses include attribution.`;

export function createMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: 'artificialanalysis-mcp', version },
    { instructions: INSTRUCTIONS },
  );
  registerFindModels(server, ctx);
  registerGetModel(server, ctx);
  registerCompareModels(server, ctx);
  registerListMediaModels(server, ctx);
  registerGetApiStatus(server, ctx);
  return server;
}
