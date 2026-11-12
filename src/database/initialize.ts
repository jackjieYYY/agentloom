import { pushSchema } from 'drizzle-kit/api';
import pg from 'pg';
import { createDatabase } from './client.js';
import * as schema from './schema.js';

export async function initializeDatabase(
  connectionString: string,
): Promise<void> {
  const target = new URL(connectionString);
  const name = decodeURI(target.pathname.slice(1));
  if (!name)
    throw new Error(
      'Database initialization requires an explicit database name',
    );

  const maintenance = new URL(target);
  maintenance.pathname = '/postgres';
  maintenance.searchParams.delete('database');
  const admin = new pg.Client({
    connectionString: maintenance.href,
    connectionTimeoutMillis: 2000,
  });
  try {
    await admin.connect();
    // Identifiers cannot use query parameters; FORCE disconnects existing clients.
    const identifier = pg.escapeIdentifier(name);
    await admin.query(`DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${identifier} TEMPLATE template0`);
  } finally {
    await admin.end();
  }

  const database = createDatabase(connectionString);
  try {
    // Kit's introspection UI exits on connection errors; validate through pg first.
    await database.pool.query('SELECT 1');
    const plan = await pushSchema(schema, database.db, ['public']);
    await plan.apply();
    // Checkpoint schema is owned exclusively by the official saver.
    await database.saver.setup();
  } finally {
    await database.close();
  }
}
