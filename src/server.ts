import { createApp } from './app.js';
import { ConfigurationError, parseConfig } from './config/env.js';
import { createDatabase } from './database/client.js';
import { logError } from './runtime/errors.js';

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const database = createDatabase(config.DATABASE_URL);
  const app = createApp(database, config);
  let closing: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    if (closing) return closing;
    // Also bounds stuck handlers and checked-out database clients.
    const timer = setTimeout(() => {
      app.server.closeAllConnections();
      process.exit(1);
    }, 10000);
    timer.unref();
    closing = app.close().finally(() => clearTimeout(timer));
    return closing;
  }
  const stop = () => {
    void shutdown().catch((error: unknown) => {
      logError('Shutdown failed', error);
      process.exitCode = 1;
    });
  };
  app.addHook('onClose', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.off(signal, stop);
    }
  });

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, stop);
    }
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigurationError
      ? error.message
      : 'Server startup failed';
  logError(message, error);
  process.exitCode = 1;
});
