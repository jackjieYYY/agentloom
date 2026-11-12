import fp from 'fastify-plugin';
import { handleError } from './handler.js';

export default fp(async function errorHandlers(app) {
  app.setErrorHandler(handleError);
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({ error: 'Not found', requestId: request.id });
  });
});
