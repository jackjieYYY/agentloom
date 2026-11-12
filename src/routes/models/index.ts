import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  createModelBody,
  updateModelBody,
  createModel,
  updateModel,
} from '../../models/manage.js';
import type { Database } from '../../database/client.js';
import { listModels } from '../../models/configuration.js';

const modelRoutes: FastifyPluginAsync<{
  database: Database;
}> = async (app, { database }) => {
  app.addHook('onRequest', app.authenticate);
  app.get('/', () => listModels(database));
  app.post('/', async (request, reply) => {
    const input = createModelBody.parse(request.body);
    return reply.code(201).send(await createModel(database, input));
  });
  app.patch('/:id', (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return updateModel(database, id, updateModelBody.parse(request.body));
  });
};
export default modelRoutes;
