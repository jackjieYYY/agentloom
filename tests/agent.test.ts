import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { expect, it } from 'vitest';
import { createConversationAgent } from '../src/agents/agent.js';
import { AgentInvocation } from '../src/agents/invocation.js';
import { callTool, ScriptedModel } from './helpers.js';

it('reuses one agent, switches models through context and only checkpoints conversation state', async () => {
  const firstModel = new ScriptedModel([
    callTool('echo', { text: 'hello' }),
    new AIMessage('first answer'),
  ]);
  const secondModel = new ScriptedModel([new AIMessage('second answer')]);
  const checkpointer = new MemorySaver();
  const agent = createConversationAgent({
    checkpointer,
  });
  expect(firstModel.seen).toHaveLength(0);
  const config = {
    configurable: { thread_id: 'conversation-a' },
    context: {
      userId: 'user-a',
      invocation: new AgentInvocation(firstModel, { model: 2, tool: 1 }),
    },
  };
  await agent.invoke(
    { messages: [{ role: 'user', content: 'hello' }] },
    config,
  );
  const names = firstModel.boundTools[0].map((entry) =>
    'name' in entry ? entry.name : undefined,
  );
  expect(names).toContain('echo');
  expect(names).toContain('write_file');
  expect(names).not.toContain('task');
  expect(names).not.toContain('execute');
  const snapshot = await agent.graph.getState(config);
  expect(snapshot.values.messages.at(-1).text).toBe('first answer');
  expect(firstModel.seen).toHaveLength(2);
  const saved = JSON.stringify(await checkpointer.getTuple(config));
  expect(saved).not.toContain('"invocation"');
  expect(saved).not.toContain('"modelCalls"');
  const next = {
    ...config,
    context: {
      ...config.context,
      invocation: new AgentInvocation(secondModel, { model: 2, tool: 1 }),
    },
  };
  await agent.invoke(
    { messages: [{ role: 'user', content: 'follow up' }] },
    next,
  );
  expect(firstModel.seen).toHaveLength(2);
  expect(
    secondModel.seen[0].some((message) => message.text === 'first answer'),
  ).toBe(true);
  expect(secondModel.seen).toHaveLength(1);
  expect((await agent.graph.getState(config)).values.messages.at(-1).text).toBe(
    'second answer',
  );
  expect(
    (await agent.graph.getState({ configurable: { thread_id: 'other' } }))
      .values,
  ).toEqual({});
});

it('isolates simultaneous invocations and their budgets on a shared agent', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<AIMessage>();
  const firstModel = new ScriptedModel([
    async () => {
      entered.resolve();
      return release.promise;
    },
  ]);
  const secondModel = new ScriptedModel([new AIMessage('second answer')]);
  const agent = createConversationAgent({
    checkpointer: new MemorySaver(),
  });
  const firstInvocation = new AgentInvocation(firstModel, {
    model: 1,
    tool: 1,
  });
  const secondInvocation = new AgentInvocation(secondModel, {
    model: 1,
    tool: 1,
  });
  const first = agent.invoke(
    { messages: [{ role: 'user', content: 'first private input' }] },
    {
      configurable: { thread_id: 'first' },
      context: {
        userId: 'user',
        invocation: firstInvocation,
      },
    },
  );
  try {
    await entered.promise;
    const result = await agent.invoke(
      { messages: [{ role: 'user', content: 'second input' }] },
      {
        configurable: { thread_id: 'second' },
        context: {
          userId: 'user',
          invocation: secondInvocation,
        },
      },
    );
    expect(result.messages.at(-1)?.text).toBe('second answer');
    expect(
      secondModel.seen[0].some(
        (message) => message.text === 'first private input',
      ),
    ).toBe(false);
    expect(firstModel.seen).toHaveLength(1);
    expect(secondModel.seen).toHaveLength(1);
  } finally {
    release.resolve(new AIMessage('first answer'));
    await first;
  }
});
