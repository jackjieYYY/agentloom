import { consumeCallback } from '@langchain/core/callbacks/promises';
import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { expect, it } from 'vitest';
import { createConversationAgent } from '../src/agents/agent.js';
import { AgentInvocation } from '../src/agents/invocation.js';
import { ScriptedModel } from './helpers.js';

it('waits for the actual model after the aborted graph exits, independently of background callbacks', async () => {
  const backgroundEntered = Promise.withResolvers<void>();
  const backgroundRelease = Promise.withResolvers<void>();
  await consumeCallback(async () => {
    backgroundEntered.resolve();
    await backgroundRelease.promise;
  }, false);
  await backgroundEntered.promise;

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<AIMessage>();
  const model = new ScriptedModel([
    async () => {
      entered.resolve();
      return release.promise;
    },
  ]);
  const invocation = new AgentInvocation(model, { model: 1, tool: 1 });
  const agent = createConversationAgent({ checkpointer: new MemorySaver() });
  const streamStopped = Promise.withResolvers<void>();
  let done = false;
  void invocation.done.then(() => (done = true));
  const running = invocation.run(10000, async () => {
    try {
      const stream = await agent.stream(
        { messages: [{ role: 'user', content: 'cancel this' }] },
        {
          configurable: { thread_id: 'cancel' },
          context: { userId: 'user', invocation },
          signal: invocation.signal,
          callbacks: [invocation.callbacks],
          streamMode: ['messages', 'updates'],
          durability: 'sync',
        },
      );
      for await (const chunk of stream) void chunk;
    } finally {
      streamStopped.resolve();
    }
  });
  const stopped = expect(running).rejects.toThrow();
  try {
    await entered.promise;
    expect(invocation.callbacks.awaitHandlers).toBe(true);
    invocation.abort();
    await streamStopped.promise;
    expect(done).toBe(false);
    expect(() =>
      invocation.callModel(() => new AIMessage('too late')),
    ).toThrow();
    expect(model.seen).toHaveLength(1);
    release.resolve(new AIMessage('late model result'));
    await stopped;
    expect(done).toBe(true);
  } finally {
    release.resolve(new AIMessage('cleanup'));
    backgroundRelease.resolve();
    await stopped;
  }
});

it('drains concurrent and newly registered tool work even when a tool fails', async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const nestedEntered = Promise.withResolvers<void>();
  let toolCalls = 0;
  const invocation = new AgentInvocation(new ScriptedModel([]), {
    model: 1,
    tool: 2,
  });
  let done = false;
  void invocation.done.then(() => (done = true));
  const running = invocation.run(10000, async () => {
    void invocation
      .callTool(async () => {
        toolCalls++;
        await first.promise;
        void invocation
          .callTool(async () => {
            toolCalls++;
            nestedEntered.resolve();
            await second.promise;
            throw new Error('tool failed');
          })
          .catch(() => {});
      })
      .catch(() => {});
  });
  try {
    first.resolve();
    await nestedEntered.promise;
    expect(done).toBe(false);
    second.resolve();
    await running;
    expect(done).toBe(true);
    expect(toolCalls).toBe(2);
  } finally {
    first.resolve();
    second.resolve();
    await running;
  }
});
