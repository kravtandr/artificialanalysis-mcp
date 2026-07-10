import { createAppContext } from './context.js';
import { ConfigError, loadConfig } from './config.js';
import { startHttp } from './transport/http.js';
import { startStdio } from './transport/stdio.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // Отсутствие ключа — немедленный выход при старте, не при первом вызове инструмента.
    if (error instanceof ConfigError) {
      process.stderr.write(`artificialanalysis-mcp: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const ctx = createAppContext(config);

  if (config.transport === 'http') {
    const server = await startHttp(ctx);
    const shutdown = (): void => {
      ctx.logger.info('Shutting down');
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    await startStdio(ctx);
  }
}

main().catch((error: unknown) => {
  console.error('artificialanalysis-mcp fatal:', error);
  process.exit(1);
});
