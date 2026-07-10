# artificialanalysis-mcp

[![CI](https://github.com/kravtandr/artificialanalysis-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kravtandr/artificialanalysis-mcp/actions/workflows/ci.yml)

**Unofficial** [MCP](https://modelcontextprotocol.io) server for the
[Artificial Analysis Data API v2](https://artificialanalysis.ai/data-api/docs).
Lets AI agents (Claude Desktop, Claude Code, Cursor, …) find, compare and rank
AI models — LLMs, image/video generation, speech and music — by benchmark
scores, price and speed.

> This project is **not affiliated with Artificial Analysis**. All data belongs
> to [Artificial Analysis](https://artificialanalysis.ai); every tool response
> includes the attribution their license requires.

The server is built around **search and filtering, not endpoint proxying**: it
downloads and caches full model catalogs (default TTL 6 h), then filters, sorts
and compares locally. This respects the API's strict daily request quota
(Free tier: 100 requests/day) and keeps tool responses compact.

## Tools

| Tool                | Purpose                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_models`       | Search/rank LLMs by intelligence/coding/agentic index, price, speed, TTFT, creator, release date, and (on Pro keys) open weights, reasoning, context window, modalities. Sort by any metric, including `best_value` (intelligence per dollar). |
| `get_model`         | Full card for one LLM by slug or approximate name (fuzzy resolution).                                                                                                                                                                          |
| `compare_models`    | Side-by-side metric table for 2–5 LLMs.                                                                                                                                                                                                        |
| `list_media_models` | Top models of a media arena: text-to-image, image-editing, video, text-to-speech, speech-to-speech, speech-to-text, music. Ranked by Elo, or word-error-rate (lower is better) for speech-to-text.                                             |
| `get_api_status`    | API key tier, remaining daily quota, cache freshness.                                                                                                                                                                                          |

## Setup

You need an Artificial Analysis API key (free):
<https://artificialanalysis.ai/api-key-management-redirect>.

### Claude Code

```bash
claude mcp add artificialanalysis \
  --env ARTIFICIAL_ANALYSIS_API_KEY=your-key-here \
  -- npx -y artificialanalysis-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "artificialanalysis": {
      "command": "npx",
      "args": ["-y", "artificialanalysis-mcp"],
      "env": {
        "ARTIFICIAL_ANALYSIS_API_KEY": "your-key-here"
      }
    }
  }
}
```

### Docker (Streamable HTTP)

```bash
docker run -d --name aa-mcp \
  -e ARTIFICIAL_ANALYSIS_API_KEY=your-key-here \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 24) \
  -p 127.0.0.1:3000:3000 \
  ghcr.io/kravtandr/artificialanalysis-mcp:latest
```

The MCP endpoint is `POST http://127.0.0.1:3000/mcp`; health check at
`GET /healthz`.

> ⚠️ **Never expose the HTTP mode publicly without `MCP_AUTH_TOKEN`.** Anyone
> who can reach the port can spend your daily API quota. The server binds to
> `127.0.0.1` by default (the Docker image binds to `0.0.0.0` inside the
> container) and logs a loud warning when bound externally without a token.

## Configuration

| Variable                      | Required | Default                         | Purpose                                          |
| ----------------------------- | -------- | ------------------------------- | ------------------------------------------------ |
| `ARTIFICIAL_ANALYSIS_API_KEY` | yes      | —                               | Artificial Analysis Data API key                 |
| `AA_BASE_URL`                 | no       | `https://artificialanalysis.ai` | API base URL override (tests)                    |
| `AA_CACHE_TTL_SECONDS`        | no       | `21600`                         | Catalog cache TTL (6 h)                          |
| `AA_REQUEST_TIMEOUT_MS`       | no       | `30000`                         | Per-request timeout                              |
| `AA_TIER`                     | no       | auto-detected                   | Force tier (`free`/`pro`/`commercial`)           |
| `MCP_TRANSPORT`               | no       | `stdio`                         | `stdio` or `http`                                |
| `PORT`                        | no       | `3000`                          | HTTP port                                        |
| `MCP_HTTP_HOST`               | no       | `127.0.0.1`                     | HTTP bind host (Docker image sets `0.0.0.0`)     |
| `MCP_AUTH_TOKEN`              | no       | —                               | Bearer token required on `/mcp` when set         |
| `LOG_LEVEL`                   | no       | `info`                          | `debug`/`info`/`warn`/`error` (always to stderr) |

## Tiers and limitations

- **Free keys** (100 requests/day) see headline indices, input/output prices
  and median performance. Pro-only filters (`open_weights_only`,
  `reasoning_only`, `min_context_window_tokens`, `input_modalities`) are
  reported as unsupported instead of being silently applied.
- **Pro/Commercial keys** are detected automatically and unlock the full
  endpoints (extended benchmarks, blended prices, context window, modalities,
  providers).
- The cache never discards expired data: if the API is unavailable or the
  quota is exhausted, tools serve the last known snapshot marked with
  `stale: true` and its timestamp.
- `null` in Artificial Analysis data means "not measured", never zero. Numeric
  filters exclude such models; sorts push them to the end.

## Development

```bash
npm ci
npm run dev        # watch mode (stdio)
npm test           # vitest (no real API calls, ever)
npm run lint       # eslint + prettier
npm run typecheck  # tsc --noEmit
npm run build      # tsup → dist/
npm run smoke      # MCP handshake against the built dist/
npm run generate:types  # regenerate src/api/types.gen.ts from the OpenAPI spec
```

See `SPEC.md` (Russian) for the full technical specification and `AGENTS.md`
for contributor rules.

## License

[MIT](./LICENSE). Model data © [Artificial Analysis](https://artificialanalysis.ai),
provided under their API license terms — responses always cite
`Source: Artificial Analysis (https://artificialanalysis.ai)`.
