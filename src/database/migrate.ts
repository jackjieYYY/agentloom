import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.js';

export async function migrateDatabase(database: Database): Promise<void> {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(
      new URL('../../migrations/', import.meta.url),
    ),
  });
  // Checkpoint schema is owned exclusively by the official saver.
  await database.saver.setup();
}
