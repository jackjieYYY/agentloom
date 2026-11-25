import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessageLike } from '@langchain/core/messages';
import {
  isCommand,
  type Command,
  type ProtocolEvent,
} from '@langchain/langgraph';
import { and, eq, sql } from 'drizzle-orm';
import type { HITLRequest, HITLResponse } from 'langchain';
import { createConversationAgent, type AgentContext } from '../agents/agent.js';
import { AgentInvocation } from '../agents/invocation.js';
import { createModalWorkspace } from '../agents/modal.js';
import type { Config } from '../config/env.js';
import type { Database } from '../database/client.js';
import { approvalAudits, conversations } from '../database/schema.js';
import { availableModel, configuredModel } from '../models/configuration.js';
import { AppError } from './app-error.js';

type Input = { messages: BaseMessageLike[] } | Command | null;

export function createExecution(
  database: Database,
  config: Config,
  injectedModel?: BaseChatModel,
) {
  const agent = createConversationAgent({ checkpointer: database.saver });
  const active = new Map<string, AgentInvocation>();
  const locks = new Map<string, Promise<unknown>>();
  let closing = false;
  const state = (id: string) =>
    agent.graph.getState({ configurable: { thread_id: id } });
  async function owned(id: string, identity: AgentContext) {
    const [row] = await database.db
      .select()
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
  async function locked<T>(id: string, work: () => Promise<T>) {
    const next = (locks.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    locks.set(id, next);
    try {
      return await next;
    } finally {
      if (locks.get(id) === next) locks.delete(id);
    }
  }
  return {
    async query(id: string, identity: AgentContext) {
      await owned(id, identity);
      return state(id);
    },
    async metadata(id: string, identity: AgentContext) {
      const row = await owned(id, identity);
      const audit = await database.db
        .select()
        .from(approvalAudits)
        .where(eq(approvalAudits.conversationId, id));
      return { ...row, active: active.has(id), approvalAudit: audit };
    },
    cancel(id: string, identity: AgentContext) {
      return locked(id, async () => {
        const [row] = await database.db
          .update(conversations)
          .set({ closedAt: sql`coalesce(${conversations.closedAt}, now())` })
          .where(
            and(
              eq(conversations.id, id),
              eq(conversations.userId, identity.userId),
            ),
          )
          .returning();
        if (!row) throw new AppError(404, 'Not found');
        active.get(id)?.abort();
        return { ...row, active: active.has(id) };
      });
    },
    async execute(
      id: string,
      identity: AgentContext,
      input: Input,
      modelConfigId: string | undefined,
      consume: (
        run: AsyncIterable<ProtocolEvent>,
        invocation: AgentInvocation,
      ) => Promise<void>,
    ) {
      if (closing) throw new AppError(503, 'Server stopping');
      const decision = isCommand(input)
        ? Object.entries(input.resume as Record<string, HITLResponse>)[0]
        : undefined;
      const { invocation, workspace } = await locked(id, async () => {
        const row = await owned(id, identity);
        if (closing) throw new AppError(503, 'Server stopping');
        if (row.closedAt) throw new AppError(409, 'Conversation closed');
        if (active.has(id)) throw new AppError(409, 'Execution active');
        const snapshot = await state(id);
        const pending = snapshot.tasks.flatMap((task) => task.interrupts);
        const fresh = input !== null && !isCommand(input);
        if (decision) {
          const [interruptId, response] = decision;
          const interrupt = pending.find((item) => item.id === interruptId);
          if (!interrupt) throw new AppError(409, 'Approval not pending');
          const [recorded] = await database.db
            .select()
            .from(approvalAudits)
            .where(
              and(
                eq(approvalAudits.conversationId, id),
                eq(approvalAudits.interruptId, interruptId),
              ),
            );
          if (recorded) throw new AppError(409, 'Decision outcome unconfirmed');
          if (
            response.decisions.length !==
            (interrupt.value as HITLRequest).actionRequests.length
          )
            throw new AppError(400, 'Invalid approval decisions');
        } else {
          if (pending.length) throw new AppError(409, 'Approval required');
          if (fresh && snapshot.next.length)
            throw new AppError(409, 'Unfinished work');
          if (!fresh && !snapshot.next.length)
            throw new AppError(409, 'No unfinished work');
        }
        const selected = await availableModel(
          database,
          fresh ? modelConfigId! : row.lastExecutionModelConfigId!,
        );
        const model =
          injectedModel ?? (await configuredModel(selected, config));
        const workspace = config.MODAL_TOKEN_ID
          ? await createModalWorkspace(id, config.AGENT_TIMEOUT_MS + 30_000)
          : undefined;
        try {
          if (closing) throw new AppError(503, 'Server stopping');
          if (fresh)
            await database.db
              .update(conversations)
              .set({ lastExecutionModelConfigId: selected.id })
              .where(eq(conversations.id, id));
          if (closing) throw new AppError(503, 'Server stopping');
          if (decision) {
            const [interruptId, response] = decision;
            await database.db.insert(approvalAudits).values({
              conversationId: id,
              interruptId,
              decisions: response.decisions,
              userId: identity.userId,
            });
            if (closing) throw new AppError(503, 'Server stopping');
          }
          const invocation = new AgentInvocation(model, {
            model: config.AGENT_MODEL_CALL_LIMIT,
            tool: config.AGENT_TOOL_CALL_LIMIT,
          });
          active.set(id, invocation);
          return { invocation, workspace };
        } catch (error) {
          await workspace?.close();
          throw error;
        }
      });
      try {
        await invocation.run(config.AGENT_TIMEOUT_MS, async () => {
          const closeSandbox = () => void workspace?.close();
          invocation.signal.addEventListener('abort', closeSandbox, {
            once: true,
          });
          try {
            invocation.signal.throwIfAborted();
            const runAgent = workspace
              ? createConversationAgent({
                  checkpointer: database.saver,
                  backend: workspace.backend,
                })
              : agent;
            const run = await runAgent.streamEvents(input, {
              version: 'v3',
              configurable: { thread_id: id },
              context: { ...identity, invocation },
              signal: invocation.signal,
              callbacks: [invocation.callbacks],
              durability: 'sync',
            });
            try {
              await consume(run, invocation);
              await run.output;
            } catch (error) {
              invocation.abort();
              await run.output.catch(() => {});
              throw error;
            }
          } finally {
            invocation.signal.removeEventListener('abort', closeSandbox);
            await workspace?.close();
          }
        });
      } finally {
        active.delete(id);
      }
    },
    async stop() {
      closing = true;
      for (const invocation of active.values()) invocation.abort();
      await Promise.allSettled([...locks.values()]);
      await Promise.all(
        [...active.values()].map((invocation) => invocation.done),
      );
    },
  };
}

export type Execution = ReturnType<typeof createExecution>;
