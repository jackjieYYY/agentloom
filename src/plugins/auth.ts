import fastifyAuth from '@fastify/auth';
import fastifyJwt from '@fastify/jwt';
import type { onRequestHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import type { AgentContext } from '../agents/agent.js';
import type { Config } from '../config/env.js';
import { AppError } from '../runtime/app-error.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: onRequestHookHandler;
  }
  interface FastifyRequest {
    identity: AgentContext;
  }
}

const claimsSchema = z.object({
  sub: z.string().min(1).max(200).regex(/\S/),
});

export default fp<{ config: Config }>(async function authentication(
  app,
  { config },
) {
  await app.register(fastifyAuth);
  await app.register(fastifyJwt, {
    secret: config.AUTH_JWT_SECRET,
    verify: {
      algorithms: ['HS256'],
      requiredClaims: ['exp', 'sub'],
    },
  });
  app.decorateRequest('identity');
  app.decorate(
    'authenticate',
    app.auth([
      async (request, reply) => {
        try {
          const claims = claimsSchema.parse(await request.jwtVerify());
          request.identity = { userId: claims.sub };
        } catch {
          reply.header('www-authenticate', 'Bearer');
          throw new AppError(401, 'Invalid request');
        }
      },
    ]),
  );
});
