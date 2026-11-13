import fastifyAuth from '@fastify/auth';
import fastifyJwt from '@fastify/jwt';
import { and, eq } from 'drizzle-orm';
import type { onRequestHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import type { AgentContext } from '../agents/agent.js';
import type { Config } from '../config/env.js';
import type { Database } from '../database/client.js';
import { users } from '../database/schema.js';
import {
  accessTokenLifetime,
  publicUserFields,
  type PublicUser,
} from '../users/accounts.js';
import { AppError } from '../runtime/app-error.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: onRequestHookHandler;
  }
  interface FastifyRequest {
    identity: AgentContext;
    account: PublicUser;
  }
}

const claimsSchema = z.object({ sub: z.uuid() });

export default fp<{ config: Config; database: Database }>(
  async function authentication(app, { config, database }) {
    await app.register(fastifyAuth);
    await app.register(fastifyJwt, {
      secret: config.AUTH_JWT_SECRET,
      sign: { algorithm: 'HS256', expiresIn: accessTokenLifetime },
      verify: {
        algorithms: ['HS256'],
        requiredClaims: ['exp', 'sub'],
      },
    });
    app.decorateRequest('identity');
    app.decorateRequest('account');
    app.decorate(
      'authenticate',
      app.auth([
        async (request, reply) => {
          let userId: string;
          try {
            userId = claimsSchema.parse(await request.jwtVerify()).sub;
          } catch {
            reply.header('www-authenticate', 'Bearer');
            throw new AppError(401, 'Invalid request');
          }
          const [account] = await database.db
            .select(publicUserFields)
            .from(users)
            .where(and(eq(users.id, userId), eq(users.enabled, true)));
          if (!account) {
            reply.header('www-authenticate', 'Bearer');
            throw new AppError(401, 'Invalid request');
          }
          request.account = account;
          request.identity = { userId: account.id };
        },
      ]),
    );
  },
);
