import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import type { Database } from '../../database/client.js';
import { conversations } from '../../database/schema.js';
import { createAuthenticator } from './auth.js';

const createBody = z.strictObject({}).optional();
const paramsSchema = z.object({ conversationId: z.uuid() });
const publicColumns = {
  conversationId: conversations.id,
  createdAt: conversations.createdAt,
};

type ConversationOptions = { database: Database; config: Config };

const conversationRoutes: FastifyPluginAsync<ConversationOptions> = async (
  app,
  { database, config },
) => {
  const authenticate = createAuthenticator(config);
  app.decorateRequest('identity');
  app.addHook('onRequest', async (request, reply) => {
    try {
      request.identity = await authenticate(request.headers.authorization);
    } catch {
      reply.header('www-authenticate', 'Bearer');
      return reply
        .code(401)
        .send({ error: 'Invalid request', requestId: request.id });
    }
  });

  app.post('/', async (request, reply) => {
    if (!createBody.safeParse(request.body).success) {
      return reply
        .code(400)
        .send({ error: 'Invalid request', requestId: request.id });
    }
    const conversationId = randomUUID();
    request.log = reply.log = request.log.child({ conversationId });
    const [conversation] = await database.db
      .insert(conversations)
      .values({ id: conversationId, ...request.identity })
      .returning(publicColumns);
    return reply.code(201).send(conversation);
  });

  app.get('/:conversationId', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'Invalid request', requestId: request.id });
    }
    const { conversationId } = params.data;
    request.log = reply.log = request.log.child({ conversationId });
    const [conversation] = await database.db
      .select(publicColumns)
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.tenantId, request.identity.tenantId),
          eq(conversations.userId, request.identity.userId),
        ),
      );
    if (!conversation) {
      return reply
        .code(404)
        .send({ error: 'Not found', requestId: request.id });
    }
    return conversation;
  });
};

export default conversationRoutes;
