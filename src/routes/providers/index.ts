import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import type { Database } from '../../database/client.js';
import { discoverModels } from '../../models/discovery.js';
import {
  createProviderBody,
  updateProviderBody,
  createProvider,
  updateProvider,
  listProviders,
} from '../../models/manage.js';

const providerRoutes: FastifyPluginAsync<{
  database: Database;
  config: Config;
}> = async (app, { database, config }) => {
  app.addHook('onRequest', app.authenticate);
  app.get('/', () => listProviders(database));
  app.get('/:id/models', (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return discoverModels(database, id, config.MODEL_CREDENTIALS_KEY);
  });
  app.post('/', async (request, reply) => {
    const input = createProviderBody.parse(request.body);
    const result = await createProvider(
      database,
      input,
      config.MODEL_CREDENTIALS_KEY,
    );
    return reply.code(201).send(result);
  });
  app.patch('/:id', (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return updateProvider(
      database,
      id,
      updateProviderBody.parse(request.body),
      config.MODEL_CREDENTIALS_KEY,
    );
  });
};
export default providerRoutes;
