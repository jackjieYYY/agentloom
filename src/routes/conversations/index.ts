import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Command } from '@langchain/langgraph';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Decision } from 'langchain';
import { z } from 'zod';
import type { Database } from '../../database/client.js';
import { conversations } from '../../database/schema.js';
import { AppError } from '../../runtime/app-error.js';
import type { Execution } from '../../runtime/execution.js';

const emptyBody = z.strictObject({}).optional();
const messages = z.strictObject({
  messages: z.tuple([
    z.strictObject({
      role: z.literal('user'),
      content: z.string().max(32000).regex(/\S/),
    }),
  ]),
});
const decision: z.ZodType<Decision> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('approve') }),
  z.strictObject({
    type: z.literal('edit'),
    editedAction: z.strictObject({
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
    }),
  }),
  z.strictObject({ type: z.literal('reject'), message: z.string().optional() }),
  z.strictObject({ type: z.literal('respond'), message: z.string() }),
]);
const resume = z.strictObject({
  resume: z
    .record(
      z.string().min(1),
      z.strictObject({
        decisions: z.array(decision).min(1),
      }),
    )
    .refine((value) => Object.keys(value).length === 1),
});
const runRequest = z.union([
  z.object({
    body: messages,
    query: z.strictObject({ modelConfigId: z.uuid() }),
  }),
  z.object({ body: resume.nullable(), query: z.strictObject({}) }),
]);
const listQuery = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const paramsSchema = z.object({ conversationId: z.uuid() });

type ConversationOptions = { database: Database; execution: Execution };
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

  app.get('/:conversationId/metadata', async (request, reply) =>
    execution.metadata(id(request, reply), request.identity),
  );
  app.post('/:conversationId/runs', async (request, reply) => {
    const conversationId = id(request, reply);
    const { body, query } = runRequest.parse({
      body: request.body ?? null,
      query: request.query,
    });
    try {
      await execution.execute(
        conversationId,
        request.identity,
        body && 'resume' in body ? new Command(body) : body,
        'modelConfigId' in query ? query.modelConfigId : undefined,
        async (run, invocation) => {
          const disconnect = () => invocation.abort();
          reply.raw.once('close', disconnect);
          try {
            reply.hijack();
            if (reply.raw.destroyed) invocation.abort();
            else
              reply.raw.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                'x-accel-buffering': 'no',
                'x-request-id': request.id,
              });
            for await (const event of run) {
              if (!reply.raw.write('data: ' + JSON.stringify(event) + '\n\n'))
                await once(reply.raw, 'drain', { signal: invocation.signal });
            }
          } finally {
            reply.raw.off('close', disconnect);
          }
        },
      );
    } catch (error) {
      if (!reply.sent) throw error;
    } finally {
      if (reply.sent) reply.raw.end();
    }
    return reply;
  });
};
export default conversationRoutes;
