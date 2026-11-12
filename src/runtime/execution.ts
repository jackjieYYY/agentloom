import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  isAIMessage,
  isHumanMessage,
  isToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { createConversationAgent, type AgentContext } from '../agents/agent.js';
import { AgentInvocation } from '../agents/invocation.js';
import { and, eq } from 'drizzle-orm';
import type { Config } from '../config/env.js';
import type { Database } from '../database/client.js';
import { conversations, modelConfigs } from '../database/schema.js';

import { availableModel, configuredModel } from '../models/configuration.js';
import { AppError } from './app-error.js';

type EventWriter = (
  event: string,
  data: Record<string, unknown>,
) => Promise<void>;

export type ExecutionCall = {
  readonly signal: AbortSignal;
  abort(): void;
  stream(send: EventWriter): Promise<void>;
};

export function createExecution(
  database: Database,
  config: Config,
  injectedModel?: BaseChatModel,
) {
  const agent = createConversationAgent({ checkpointer: database.saver });
  const active = new Map<string, AgentInvocation>();
  const locks = new Map<string, Promise<unknown>>();
  let closing = false;

  async function locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    locks.set(id, next);
    try {
      return await next;
    } finally {
      if (locks.get(id) === next) locks.delete(id);
    }
  }

  async function owned(id: string, identity: AgentContext) {
    const [row] = await database.db
      .select({
        conversationId: conversations.id,
        createdAt: conversations.createdAt,
        closedAt: conversations.closedAt,
        lastExecutionModelConfigId: conversations.lastExecutionModelConfigId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.userId, identity.userId),
        ),
      );
    if (!row) throw new AppError(404, 'Not found');
    return row;
  }

  async function state(id: string) {
    return agent.graph.getState({ configurable: { thread_id: id } });
  }
  function interrupted(snapshot: Awaited<ReturnType<typeof state>>) {
    return snapshot.tasks.some((task) => task.interrupts.length > 0);
  }

  async function streamInvocation(
    id: string,
    identity: AgentContext,
    text: string | null,
    invocation: AgentInvocation,
    write: EventWriter,
  ) {
    const send: EventWriter = async (event, data) => {
      try {
        await write(event, data);
      } catch (error) {
        // Abort before for-await closes the graph iterator and waits for its loop.
        invocation.abort();
        throw error;
      }
    };
    let result = 'completed';
    try {
      invocation.signal.throwIfAborted();
      const stream = await agent.stream(
        text === null ? null : { messages: [{ role: 'user', content: text }] },
        {
          configurable: { thread_id: id },
          context: { ...identity, invocation },
          signal: invocation.signal,
          callbacks: [invocation.callbacks],
          streamMode: ['messages', 'updates'],
          durability: 'sync',
        },
      );
      for await (const [mode, chunk] of stream) {
        if (mode === 'messages') {
          const [message] = chunk;
          if (isAIMessage(message) && message.text)
            await send('message', { text: message.text });
        } else {
          for (const update of Object.values(chunk)) {
            if (!update || !('messages' in update)) continue;
            for (const message of update.messages) {
              if (isAIMessage(message)) {
                for (const call of message.tool_calls ?? [])
                  await send('tool', {
                    name: call.name,
                    status: 'requested',
                  });
              } else if (isToolMessage(message)) {
                await send('tool', {
                  name: message.name,
                  status: 'finished',
                });
              }
            }
          }
        }
      }
      const latest = await state(id);
      if (interrupted(latest)) result = 'awaiting_approval';
      else if (latest.next.length) result = 'unfinished';
    } catch {
      result = invocation.signal.aborted ? 'stopped' : 'error';
      invocation.abort();
    } finally {
      await invocation.waitForIdle();
    }
    if (invocation.signal.aborted && result !== 'error') result = 'stopped';
    if (result === 'error') await send('error', { error: 'Execution failed' });
    else if (result === 'awaiting_approval')
      await send('awaiting_approval', {});
    else if (result === 'completed') await send('completed', {});
    await send('end', { status: result });
  }

  return {
    async query(id: string, identity: AgentContext) {
      const row = await owned(id, identity);
      const [lastExecutionModel] = row.lastExecutionModelConfigId
        ? await database.db
            .select({ id: modelConfigs.id, modelName: modelConfigs.modelName })
            .from(modelConfigs)
            .where(eq(modelConfigs.id, row.lastExecutionModelConfigId))
        : [];
      const snapshot = await state(id);
      const isActive = active.has(id);
      const awaitingApproval = interrupted(snapshot);
      const unfinished = snapshot.next.length > 0;
      return {
        ...row,
        lastExecutionModel: lastExecutionModel ?? null,
        active: isActive,
        awaitingApproval,
        unfinished,
        canSubmit:
          !row.closedAt && !isActive && !awaitingApproval && !unfinished,
        canContinue:
          !row.closedAt && !isActive && !awaitingApproval && unfinished,
        // Only conversational text crosses the API boundary; no tool args, files or task errors.
        messages: (
          (snapshot.values.messages as BaseMessage[] | undefined) ?? []
        )
          .filter((message) => isHumanMessage(message) || isAIMessage(message))
          .map((message) => ({
            role: isHumanMessage(message) ? 'user' : 'assistant',
            content: message.text,
          }))
          .filter((message) => message.content.length > 0),
        ...(snapshot.tasks.some((task) => task.error !== undefined)
          ? { error: 'Execution failed' }
          : {}),
      };
    },
    cancel(id: string, identity: AgentContext) {
      return locked(id, async () => {
        const row = await owned(id, identity);
        if (!row.closedAt) {
          const [closed] = await database.db
            .update(conversations)
            .set({ closedAt: new Date() })
            .where(eq(conversations.id, id))
            .returning({ closedAt: conversations.closedAt });
          row.closedAt = closed.closedAt;
        }
        active.get(id)?.abort();
        return { ...row, active: active.has(id) };
      });
    },
    async execute<T>(
      id: string,
      identity: AgentContext,
      input: { text: string; modelConfigId: string } | null,
      consume: (call: ExecutionCall) => Promise<T>,
    ): Promise<T> {
      if (closing) throw new AppError(503, 'Server stopping');
      const invocation = await locked(id, async () => {
        if (closing) throw new AppError(503, 'Server stopping');
        const row = await owned(id, identity);
        if (row.closedAt) throw new AppError(409, 'Conversation closed');
        if (active.has(id)) throw new AppError(409, 'Execution active');
        const snapshot = await state(id);
        if (interrupted(snapshot)) throw new AppError(409, 'Approval required');
        if (input === null && !snapshot.next.length)
          throw new AppError(409, 'No unfinished work');
        if (input !== null && snapshot.next.length)
          throw new AppError(409, 'Unfinished work');
        const selected = await availableModel(
          database,
          input === null
            ? row.lastExecutionModelConfigId!
            : input.modelConfigId,
        );
        const model =
          injectedModel ?? (await configuredModel(selected, config));
        if (input !== null) {
          await database.db
            .update(conversations)
            .set({ lastExecutionModelConfigId: selected.id })
            .where(eq(conversations.id, id));
        }
        // Shutdown may have started while the database or saver was awaited.
        if (closing) throw new AppError(503, 'Server stopping');
        const invocation = new AgentInvocation(model, {
          model: config.AGENT_MODEL_CALL_LIMIT,
          tool: config.AGENT_TOOL_CALL_LIMIT,
        });
        active.set(id, invocation);
        return invocation;
      });
      try {
        return await invocation.run(config.AGENT_TIMEOUT_MS, () =>
          consume({
            signal: invocation.signal,
            abort: () => invocation.abort(),
            stream: (send) =>
              streamInvocation(
                id,
                identity,
                input?.text ?? null,
                invocation,
                send,
              ),
          }),
        );
      } finally {
        active.delete(id);
      }
    },
    async stop() {
      closing = true;
      for (const invocation of active.values()) invocation.abort();
      // Admissions can still be awaiting database/checkpoint reads during preClose.
      await Promise.allSettled([...locks.values()]);
      await Promise.all(
        [...active.values()].map((invocation) => invocation.done),
      );
    },
  };
}

export type Execution = ReturnType<typeof createExecution>;
