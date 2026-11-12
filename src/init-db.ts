import { ConfigurationError, parseDatabaseConfig } from './config/env.js';
import { initializeDatabase } from './database/initialize.js';
import { logError } from './runtime/errors.js';

async function main(): Promise<void> {
  const config = parseDatabaseConfig(process.env);
  await initializeDatabase(config.DATABASE_URL);
  process.stdout.write('Database reset and initialized\n');
}

main().catch((error: unknown) => {
  logError(
    error instanceof ConfigurationError
      ? error.message
      : 'Database initialization failed',
    error,
  );
  process.exitCode = 1;
});
