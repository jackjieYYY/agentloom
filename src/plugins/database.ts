import fp from 'fastify-plugin';
import type { Database } from '../database/client.js';

export default fp<{ database: Database }>(async function databaseLifecycle(
  app,
  { database },
) {
  app.addHook('onClose', async () => {
    await database.close();
  });
});
