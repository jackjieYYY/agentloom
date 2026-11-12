import fp from 'fastify-plugin';

export default fp(async function requestHooks(app) {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
});
