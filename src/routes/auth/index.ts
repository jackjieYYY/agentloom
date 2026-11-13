import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../database/client.js';
import {
  accessTokenLifetime,
  credentialsBody,
  loginUser,
  registerUser,
} from '../../users/accounts.js';

const authRoutes: FastifyPluginAsync<{ database: Database }> = async (
  app,
  { database },
) => {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.post('/register', async (request, reply) => {
    const user = await registerUser(
      database,
      credentialsBody.parse(request.body),
    );
    return reply.code(201).send({ user });
  });
  app.post('/login', async (request, reply) => {
    const user = await loginUser(database, credentialsBody.parse(request.body));
    return {
      accessToken: await reply.jwtSign({ sub: user.id }),
      tokenType: 'Bearer',
      expiresIn: accessTokenLifetime,
      user,
    };
  });
  app.get('/me', { onRequest: app.authenticate }, (request) => ({
    user: request.account,
  }));
};

export default authRoutes;
