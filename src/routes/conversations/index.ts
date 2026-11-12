import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../database/client.js';
import { conversations } from '../../database/schema.js';
import { AppError } from '../../runtime/app-error.js';
import type { Execution, ExecutionCall } from '../../runtime/execution.js';

const emptyBody = z.strictObject({}).optional();
const inputBody = z.strictObject({
  text: z.string().trim().min(1).max(32000),
  modelConfigId: z.uuid(),
});
const listQuery = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .pipe(z.coerce.number<string>().int().min(1).max(100))
    .default(20),
});
const paramsSchema = z.object({ conversationId: z.uuid() });

type ConversationOptions = {
  database: Database;
  execution: Execution;
};

const conversationRoutes: FastifyPluginAsync<ConversationOptions> = async (
  app,
  { database, execution },
) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (request) => {
    const { cursor, limit } = listQuery.parse(request.query);
    const { userId } = request.identity;
    if (cursor) {
      const [ownedCursor] = await database.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.id, cursor), eq(conversations.userId, userId)),
        );
      if (!ownedCursor) throw new AppError(404, 'Not found');
    }
    const rows = await database.db
      .select({
        conversationId: conversations.id,
        createdAt: conversations.createdAt,
        closedAt: conversations.closedAt,
        lastExecutionModelConfigId: conversations.lastExecutionModelConfigId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, userId),
          // Compare database timestamps directly to preserve PostgreSQL microseconds.
          cursor
            ? sql`(${conversations.createdAt}, ${conversations.id}) < (select created_at, id from conversations where id = ${cursor}::uuid and user_id = ${userId})`
            : undefined,
        ),
      )
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? items.at(-1)!.conversationId : null,
    };
  });

  app.post('/', async (request, reply) => {
    emptyBody.parse(request.body);
    const conversationId = randomUUID();
    request.log = reply.log = request.log.child({ conversationId });
    const [conversation] = await database.db
      .insert(conversations)
      .values({
        id: conversationId,
        ...request.identity,
      })
      .returning({
        conversationId: conversations.id,
        createdAt: conversations.createdAt,
      });
    return reply.code(201).send(conversation);
  });

  function id(request: FastifyRequest, reply: FastifyReply) {
    const { conversationId } = paramsSchema.parse(request.params);
    request.log = reply.log = request.log.child({ conversationId });
    return conversationId;
  }

  app.get('/:conversationId', async (request, reply) =>
    execution.query(id(request, reply), request.identity),
  );
  app.post('/:conversationId/cancel', async (request, reply) => {
    const conversationId = id(request, reply);
    emptyBody.parse(request.body);
    return execution.cancel(conversationId, request.identity);
  });

  app.post('/:conversationId/input', async (request, reply) => {
    const conversationId = id(request, reply);
    const input = inputBody.parse(request.body);
    return execution.execute(conversationId, request.identity, input, (call) =>
      stream(request, reply, call),
    );
  });

  app.post('/:conversationId/continue', async (request, reply) => {
    const conversationId = id(request, reply);
    emptyBody.parse(request.body);
    return execution.execute(conversationId, request.identity, null, (call) =>
      stream(request, reply, call),
    );
  });

  async function stream(
    request: FastifyRequest,
    reply: FastifyReply,
    call: ExecutionCall,
  ) {
    const disconnect = () => {
      if (!reply.raw.writableEnded) call.abort();
    };
    reply.raw.on('close', disconnect);
    try {
      reply.hijack();
      if (reply.raw.destroyed) call.abort();
      else {
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no',
          'x-request-id': request.id,
        });
        reply.raw.flushHeaders();
      }
      await call.stream(async (event, data) => {
        if (reply.raw.destroyed) return;
        const writable = reply.raw.write(
          `event: ${event}\ndata: ${JSON.stringify({ ...data, requestId: request.id })}\n\n`,
        );
        if (!writable)
          await once(reply.raw, 'drain', { signal: call.signal }).catch(
            (error: unknown) => {
              if (!call.signal.aborted) throw error;
            },
          );
      });
    } finally {
      reply.raw.off('close', disconnect);
      reply.raw.end();
    }
    return reply;
  }
};

export default conversationRoutes;
