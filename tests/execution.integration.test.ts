import 'tsx';
import {
  AIMessage,
  isToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { parseConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/client.js';
import { initializeDatabase } from '../src/database/initialize.js';
import { approvalAudits, modelConfigs } from '../src/database/schema.js';
import { createExecution } from '../src/runtime/execution.js';
import { createProvider, createModel } from '../src/models/manage.js';
import { jwtFixture, prepareUsers, userA, userB } from './auth-helpers.js';
import { callTool, ScriptedModel } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated real PostgreSQL database',
  );
const apps: ReturnType<typeof createApp>[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(
  model: ScriptedModel | undefined,
  overrides: NodeJS.ProcessEnv = {},
) {
  const fixture = jwtFixture();
  const config = parseConfig({
    DATABASE_URL: url,
    ...fixture.env,
    ...overrides,
  });
  await initializeDatabase(url!);
  const database = createDatabase(url!);
  await prepareUsers(database);
  let modelConfigId: string | undefined;
  if (model) {
    const provider = await createProvider(
      database,
      { name: 'test', type: 'openai', apiKey: 'test-only-key' },
      'ab'.repeat(32),
    );
    const selected = await createModel(database, {
      providerId: provider.providerId,
      modelName: 'gpt-4.1-mini',
    });
    modelConfigId = selected.modelConfigId;
  }
  const app = createApp(database, config, model);
  apps.push(app);
  const headers = { authorization: `Bearer ${await fixture.sign()}` };
  const created = await app.inject({
    method: 'POST',
    url: '/conversations',
    headers,
  });
  expect(created.statusCode).toBe(201);
  const id: string = created.json().conversationId;
  const path = `/conversations/${id}`;
  const post = (action: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `${path}/${action}`,
      headers,
      payload: action === 'input' ? { modelConfigId, ...payload } : payload,
    });
  const query = () => app.inject({ url: path, headers });
  return {
    app,
    database,
    config,
    fixture,
    headers,
    id,
    path,
    post,
    query,
    modelConfigId,
  };
}

function gate() {
  const entered = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<AIMessage>();
  const release = () => finished.resolve(new AIMessage('unblocked'));
  releases.push(release);
  return {
    entered: entered.promise,
    release,
    response: async () => {
      entered.resolve();
      return finished.promise;
    },
  };
}

it('streams tools, messages and completion, retains history and isolates conversations', async () => {
  const model = new ScriptedModel([
    callTool('write_todos', {
      todos: [{ content: 'safe task', status: 'completed' }],
    }),
    new AIMessage({
      content: [
        { type: 'reasoning', reasoning: 'private reasoning' },
        { type: 'text', text: 'first answer' },
      ],
    }),
    new AIMessage('follow-up answer'),
    new AIMessage('isolated'),
  ]);
  const f = await setup(model);
  expect((await f.post('continue')).json().error).toBe('No unfinished work');
  const first = await f.post('input', { text: 'first input' });
  expect(first.statusCode).toBe(200);
  expect(first.headers['content-type']).toContain('text/event-stream');
  expect(first.body).toContain('event: message');
  expect(first.body).toContain('first answer');
  expect(first.body).toContain('"status":"requested"');
  expect(first.body).toContain('"status":"finished"');
  expect(first.body).toContain('event: completed');
  expect(first.body).toContain('event: end');
  expect(first.body).not.toContain('safe echo');
  expect(first.body).not.toContain('private reasoning');
  expect(first.body).not.toContain(userA);
  expect((await f.post('input', { text: 'follow up' })).body).toContain(
    'follow-up answer',
  );
  const state = (await f.query()).json();
  expect(JSON.stringify(state)).not.toContain('private reasoning');
  expect(state).toMatchObject({
    active: false,
    unfinished: false,
    closedAt: null,
    canSubmit: true,
    canContinue: false,
  });
  expect(
    state.messages.map((message: { content: string }) => message.content),
  ).toEqual(['first input', 'first answer', 'follow up', 'follow-up answer']);
  const calls = model.seen.length;
  await f.query();
  expect(model.seen).toHaveLength(calls);
  const other = await f.app.inject({
    method: 'POST',
    url: '/conversations',
    headers: f.headers,
  });
  const otherPath = `/conversations/${other.json().conversationId}`;
  expect(
    (await f.app.inject({ url: otherPath, headers: f.headers })).json()
      .messages,
  ).toEqual([]);
  await f.app.inject({
    method: 'POST',
    url: `${otherPath}/input`,
    headers: f.headers,
    payload: { text: 'other input', modelConfigId: f.modelConfigId },
  });
  expect(
    model.seen.at(-1)?.some((message) => message.content === 'first input'),
  ).toBe(false);
});

it('authorizes every execution, read and cancel operation and validates request bodies', async () => {
  const model = new ScriptedModel([]);
  const f = await setup(model);
  for (const action of ['', '/input', '/continue', '/cancel', '/approvals']) {
    for (const claims of [undefined, { sub: userB }]) {
      const response = await f.app.inject({
        method: action ? 'POST' : 'GET',
        url: `${f.path}${action}`,
        headers: claims
          ? { authorization: `Bearer ${await f.fixture.sign(claims)}` }
          : {},
        ...(action === '/input'
          ? { payload: { text: 'private', modelConfigId: f.modelConfigId } }
          : action === '/approvals'
            ? {
                payload: {
                  interruptId: 'unknown',
                  decisions: [{ type: 'approve' }],
                },
              }
            : {}),
      });
      expect(response.statusCode).toBe(claims ? 404 : 401);
    }
  }
  for (const payload of [
    { text: 'missing model', modelConfigId: undefined },
    { text: 'null model', modelConfigId: null },
    { text: 'invalid model', modelConfigId: 'invalid' },
    { text: '' },
    { text: '   ' },
    { text: 'ok', userId: 'forged' },
    { messages: [] },
    { text: 'x'.repeat(32001) },
  ]) {
    expect((await f.post('input', payload)).statusCode).toBe(400);
  }
  for (const action of ['continue', 'cancel'])
    expect((await f.post(action, { text: 'forged' })).statusCode).toBe(400);
  for (const payload of [
    {},
    { interruptId: '', decisions: [{ type: 'approve' }] },
    { interruptId: 'unknown', decisions: [] },
    { interruptId: 'unknown', decisions: [{ type: 'edit' }] },
    { interruptId: 'unknown', decisions: [{ type: 'respond' }] },
    {
      interruptId: 'unknown',
      decisions: [{ type: 'reject', message: 'extra' }],
    },
    {
      interruptId: 'unknown',
      decisions: [{ type: 'approve' }],
      userId: 'forged',
    },
    {
      interruptId: 'unknown',
      decisions: [{ type: 'approve' }],
      modelConfigId: f.modelConfigId,
    },
  ])
    expect((await f.post('approvals', payload)).statusCode).toBe(400);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/conversations',
        headers: f.headers,
        payload: { modelConfigId: f.modelConfigId },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.app.inject({
        method: 'PATCH',
        url: f.path,
        headers: f.headers,
        payload: { modelConfigId: f.modelConfigId },
      })
    ).statusCode,
  ).toBe(404);
  expect(model.seen).toHaveLength(0);
  expect((await f.query()).json().closedAt).toBeNull();
});

it('does not retry model failures, exposes only safe saved state and continues after restart with null', async () => {
  const failed = new ScriptedModel([
    new Error('private-api-key-and-tool-result'),
  ]);
  const f = await setup(failed);
  const response = await f.post('input', { text: 'persist before failure' });
  expect(response.body).toContain('event: error');
  expect(response.body).not.toContain('private-api-key');
  expect(failed.seen).toHaveLength(1);
  const state = (await f.query()).json();
  expect(state).toMatchObject({
    unfinished: true,
    canContinue: true,
    error: 'Execution failed',
  });
  expect(JSON.stringify(state)).not.toContain('private-api-key');
  expect((await f.post('input', { text: 'must not merge' })).statusCode).toBe(
    409,
  );
  await f.app.close();
  const db = createDatabase(url!);
  const model = new ScriptedModel([new AIMessage('recovered')]);
  const app = createApp(db, f.config, model);
  apps.push(app);
  expect(
    (await app.inject({ url: f.path, headers: f.headers })).json().canContinue,
  ).toBe(true);
  expect(model.seen).toHaveLength(0);
  const resumed = await app.inject({
    method: 'POST',
    url: `${f.path}/continue`,
    headers: f.headers,
  });
  expect(resumed.body).toContain('recovered');
  expect(
    model.seen[0]
      .filter((message) => message.getType() === 'human')
      .map((message) => message.content),
  ).toEqual(['persist before failure']);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${f.path}/continue`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(409);
});

it.each(['model', 'tool'])(
  'bounds %s calls and grants a fresh budget on explicit continuation',
  async (kind) => {
    const model = new ScriptedModel(
      kind === 'model'
        ? [callTool('write_todos', { todos: [] }), new AIMessage('finished')]
        : [
            callTool('write_todos', { todos: [] }),
            callTool('write_todos', { todos: [] }, 'call-2'),
            new AIMessage('finished'),
          ],
    );
    const f = await setup(model, {
      [kind === 'model' ? 'AGENT_MODEL_CALL_LIMIT' : 'AGENT_TOOL_CALL_LIMIT']:
        '1',
    });
    const first = await f.post('input', { text: 'limited' });
    expect(first.body).toContain('event: error');
    expect(model.seen).toHaveLength(kind === 'model' ? 1 : 2);
    expect(first.body.match(/"status":"finished"/g) ?? []).toHaveLength(1);
    expect((await f.query()).json().canContinue).toBe(true);
    const resumed = await f.post('continue');
    expect(resumed.body).toContain('event: completed');
    expect(model.seen).toHaveLength(kind === 'model' ? 2 : 3);
    expect((await f.query()).json().unfinished).toBe(false);
  },
);

it('keeps the active slot until execution settles and persists cancellation across restart', async () => {
  const blocked = gate();
  const f = await setup(new ScriptedModel([blocked.response]));
  const running = f.post('input', { text: 'blocked' }).then((result) => result);
  await blocked.entered;
  expect((await f.query()).json().active).toBe(true);
  for (const action of ['input', 'continue'])
    expect(
      (
        await f.post(
          action,
          action === 'input' ? { text: 'racing' } : undefined,
        )
      ).statusCode,
    ).toBe(409);
  const canceled = await f.post('cancel');
  expect(canceled.statusCode).toBe(200);
  expect(canceled.json()).toMatchObject({
    active: true,
    closedAt: expect.any(String),
  });
  expect((await f.query()).json()).toMatchObject({
    active: true,
    canSubmit: false,
    canContinue: false,
  });
  blocked.release();
  expect((await running).body).toContain('"status":"stopped"');
  expect((await f.post('cancel')).json().closedAt).toBe(
    canceled.json().closedAt,
  );
  await f.app.close();
  const model = new ScriptedModel([]);
  const app = createApp(createDatabase(url!), f.config, model);
  apps.push(app);
  expect(
    (await app.inject({ url: f.path, headers: f.headers })).json(),
  ).toMatchObject({ active: false, closedAt: canceled.json().closedAt });
  for (const action of ['input', 'continue'])
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${f.path}/${action}`,
          headers: f.headers,
          ...(action === 'input'
            ? { payload: { text: 'closed', modelConfigId: f.modelConfigId } }
            : {}),
        })
      ).statusCode,
    ).toBe(409);
  expect(model.seen).toHaveLength(0);
});

it('times out without closing the conversation and resets the timer on continuation', async () => {
  const first = gate();
  const second = gate();
  const f = await setup(new ScriptedModel([first.response, second.response]), {
    AGENT_TIMEOUT_MS: '1000',
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const running = f.post('input', { text: 'timeout' }).then((result) => result);
  await first.entered;
  await vi.advanceTimersByTimeAsync(1000);
  expect((await f.query()).json().active).toBe(true);
  first.release();
  expect((await running).body).toContain('"status":"stopped"');
  expect((await f.query()).json()).toMatchObject({
    active: false,
    closedAt: null,
    canContinue: true,
  });
  const resumed = f.post('continue').then((result) => result);
  await second.entered;
  await vi.advanceTimersByTimeAsync(999);
  second.release();
  expect((await resumed).body).toContain('event: completed');
});

it('disconnects cooperatively, keeps the slot and leaves saved work available', async () => {
  const blocked = gate();
  const f = await setup(
    new ScriptedModel([blocked.response, new AIMessage('continued')]),
  );
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const pending = fetch(`${address}${f.path}/input`, {
    method: 'POST',
    headers: { ...f.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'disconnect',
      modelConfigId: f.modelConfigId,
    }),
    signal: controller.signal,
  }).catch(() => undefined);
  await blocked.entered;
  controller.abort();
  await pending;
  // Query round trip lets the socket close event be handled without a timing sleep.
  expect((await f.query()).json()).toMatchObject({
    closedAt: null,
    active: true,
  });
  expect((await f.post('input', { text: 'too soon' })).statusCode).toBe(409);
  blocked.release();
  await vi.waitFor(async () =>
    expect((await f.query()).json().active).toBe(false),
  );
  expect((await f.query()).json().canContinue).toBe(true);
  expect((await f.post('continue')).body).toContain('continued');
});

it('shutdown stops active work without closing or automatically restarting the conversation', async () => {
  const blocked = gate();
  const f = await setup(new ScriptedModel([blocked.response]));
  const running = f
    .post('input', { text: 'shutdown' })
    .then((result) => result);
  await blocked.entered;
  const closing = f.app.close();
  blocked.release();
  await running;
  await closing;
  const model = new ScriptedModel([]);
  const app = createApp(createDatabase(url!), f.config, model);
  apps.push(app);
  const state = (await app.inject({ url: f.path, headers: f.headers })).json();
  expect(state).toMatchObject({
    active: false,
    closedAt: null,
    canContinue: true,
  });
  expect(model.seen).toHaveLength(0);
});

it('owns transport setup and keeps the slot through terminal output and shutdown', async () => {
  const model = new ScriptedModel([new AIMessage('answer')]);
  const f = await setup(model);
  const execution = createExecution(f.database, f.config, model);
  const identity = { userId: userA };
  const setupError = new Error('response setup failed');
  await expect(
    execution.execute(
      f.id,
      identity,
      { text: 'not started', modelConfigId: f.modelConfigId! },
      async () => {
        throw setupError;
      },
    ),
  ).rejects.toBe(setupError);
  expect(model.seen).toHaveLength(0);
  expect(await execution.query(f.id, identity)).toMatchObject({
    active: false,
    canSubmit: true,
  });

  const ending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  const running = execution.execute(
    f.id,
    identity,
    { text: 'started', modelConfigId: f.modelConfigId! },
    (call) =>
      call.stream(async (event) => {
        if (event === 'end') {
          ending.resolve();
          await release.promise;
        }
      }),
  );
  await ending.promise;
  expect(await execution.query(f.id, identity)).toMatchObject({ active: true });
  await expect(
    execution.execute(
      f.id,
      identity,
      { text: 'racing', modelConfigId: f.modelConfigId! },
      async () => {},
    ),
  ).rejects.toThrow('Execution active');
  let stopped = false;
  const stopping = execution.stop().then(() => (stopped = true));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(stopped).toBe(false);
  release.resolve();
  await running;
  await stopping;
  expect((await execution.query(f.id, identity)).active).toBe(false);
});

it('aborts a live model before closing the graph iterator when output fails', async () => {
  let finished = false;
  let abortedBeforeModelFinished = false;
  let signal: AbortSignal;
  class StreamingModel extends ScriptedModel {
    override async *_streamResponseChunks(
      messages: BaseMessage[],
      options: BaseChatModelCallOptions,
      runManager?: CallbackManagerForLLMRun,
    ) {
      try {
        for await (const chunk of super._streamResponseChunks(
          messages,
          options,
        )) {
          yield chunk;
          await runManager?.handleLLMNewToken(
            chunk.text,
            undefined,
            undefined,
            undefined,
            undefined,
            { chunk },
          );
        }
        await new Promise<void>((resolve) => {
          const signal = options.signal!;
          if (signal.aborted) resolve();
          else
            signal.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        abortedBeforeModelFinished = signal.aborted;
        finished = true;
      }
    }
  }
  const model = new StreamingModel([new AIMessage('first chunk')]);
  const f = await setup(model);
  const execution = createExecution(f.database, f.config, model);
  const identity = { userId: userA };
  const writeError = new Error('response write failed');
  let abort = () => {};
  const running = execution.execute(
    f.id,
    identity,
    { text: 'streaming', modelConfigId: f.modelConfigId! },
    (call) => {
      signal = call.signal;
      abort = () => call.abort();
      return call.stream(async () => {
        throw writeError;
      });
    },
  );
  const rejected = expect(running).rejects.toBe(writeError);
  try {
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(abortedBeforeModelFinished).toBe(true);
    await rejected;
    expect((await execution.query(f.id, identity)).active).toBe(false);
  } finally {
    abort();
    await rejected;
  }
});

it('waits for in-flight admission during shutdown and never starts its agent', async () => {
  const model = new ScriptedModel([]);
  const f = await setup(model);
  const execution = createExecution(f.database, f.config, model);
  const identity = { userId: userA };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  const getTuple = f.database.saver.getTuple.bind(f.database.saver);
  const read = vi
    .spyOn(f.database.saver, 'getTuple')
    .mockImplementationOnce(async (config) => {
      entered.resolve();
      await release.promise;
      return getTuple(config);
    });
  const consume = vi.fn(async () => {});
  const running = execution.execute(
    f.id,
    identity,
    { text: 'admitting', modelConfigId: f.modelConfigId! },
    consume,
  );
  const rejected = expect(running).rejects.toThrow('Server stopping');
  try {
    await entered.promise;
    let stopped = false;
    const stopping = execution.stop().then(() => (stopped = true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    await expect(
      execution.execute(
        f.id,
        identity,
        { text: 'too late', modelConfigId: f.modelConfigId! },
        consume,
      ),
    ).rejects.toThrow('Server stopping');
    release.resolve();
    await rejected;
    await stopping;
    expect(consume).not.toHaveBeenCalled();
    expect(model.seen).toHaveLength(0);
  } finally {
    release.resolve();
    await rejected;
    read.mockRestore();
  }
});

it('persists pending approvals, blocks bypasses and resumes with fresh limits after restart', async () => {
  const text = `${'visible '.repeat(30)}private-tail`;
  const model = new ScriptedModel([callTool('echo', { text })]);
  const f = await setup(model, {
    AGENT_MODEL_CALL_LIMIT: '1',
    AGENT_TOOL_CALL_LIMIT: '1',
    AGENT_TIMEOUT_MS: '1000',
  });
  const response = await f.post('input', { text: 'approval' });
  expect(response.body).toContain('event: awaiting_approval');
  expect(response.body).not.toContain('"status":"finished"');
  expect(response.body).not.toContain('private-tail');
  expect(model.seen).toHaveLength(1);
  const pending = (await f.query()).json();
  expect(pending).toMatchObject({
    awaitingApproval: true,
    canSubmit: false,
    canContinue: false,
    canApprove: true,
    active: false,
    closedAt: null,
    approvalAudit: [],
    approvals: [
      {
        interruptId: expect.any(String),
        decisionStatus: 'pending',
        actions: [
          {
            toolName: 'echo',
            argumentSummary: text.slice(0, 200),
            allowedDecisions: ['approve', 'reject'],
          },
        ],
      },
    ],
  });
  const decision = {
    interruptId: pending.approvals[0].interruptId,
    decisions: [{ type: 'approve' }],
  };
  expect(response.body).toContain(decision.interruptId);
  for (const action of ['input', 'continue'])
    expect(
      (
        await f.post(
          action,
          action === 'input' ? { text: 'bypass' } : undefined,
        )
      ).json().error,
    ).toBe('Approval required');
  expect(
    (await f.post('approvals', { ...decision, interruptId: 'stale' }))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await f.post('approvals', {
        ...decision,
        decisions: [{ type: 'approve' }, { type: 'reject' }],
      })
    ).statusCode,
  ).toBe(400);
  expect(await f.database.db.select().from(approvalAudits)).toEqual([]);

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await vi.advanceTimersByTimeAsync(10000);
  expect((await f.query()).json()).toMatchObject({
    active: false,
    closedAt: null,
    canApprove: true,
  });
  vi.useRealTimers();
  await f.app.close();
  const resumedModel = new ScriptedModel([new AIMessage('approved answer')]);
  const database = createDatabase(url!);
  const app = createApp(database, f.config, resumedModel);
  apps.push(app);
  expect(
    (await app.inject({ url: f.path, headers: f.headers })).json().approvals,
  ).toEqual(pending.approvals);
  expect(resumedModel.seen).toHaveLength(0);
  const approve = (payload = decision) =>
    app.inject({
      method: 'POST',
      url: `${f.path}/approvals`,
      headers: f.headers,
      payload,
    });
  const resumed = await approve();
  expect(resumed.headers['content-type']).toContain('text/event-stream');
  expect(resumed.body).toContain('approved answer');
  expect(resumed.body).toContain('"status":"finished"');
  expect(resumed.body).toContain('event: completed');
  expect(resumed.body).toContain('"status":"completed"');
  expect(resumedModel.seen).toHaveLength(1);
  expect(
    resumedModel.seen[0].filter(isToolMessage).map((message) => message.text),
  ).toEqual([text]);
  for (const type of ['approve', 'reject'])
    expect(
      (await approve({ ...decision, decisions: [{ type }] })).statusCode,
    ).toBe(409);
  const saved = (await app.inject({ url: f.path, headers: f.headers })).json();
  expect(saved).toMatchObject({
    approvals: [],
    awaitingApproval: false,
    canApprove: false,
    active: false,
    canSubmit: true,
    approvalAudit: [
      {
        interruptId: decision.interruptId,
        decisions: decision.decisions,
        userId: userA,
        createdAt: expect.any(String),
      },
    ],
  });
  expect(await database.db.select().from(approvalAudits)).toHaveLength(1);
});

it('matches batched decisions by position and requires a new approval for a rejected tool request', async () => {
  const model = new ScriptedModel([
    new AIMessage({
      content: '',
      tool_calls: [
        {
          name: 'echo',
          args: { text: 'approved-text' },
          id: 'approved-call',
          type: 'tool_call',
        },
        {
          name: 'echo',
          args: { text: 'rejected-text' },
          id: 'rejected-call',
          type: 'tool_call',
        },
      ],
    }),
    callTool('echo', { text: 'rejected-text' }, 'new-call'),
    new AIMessage('rejection acknowledged'),
  ]);
  const f = await setup(model);
  await f.post('input', { text: 'batch' });
  const first = (await f.query()).json().approvals[0];
  expect(first.actions).toHaveLength(2);
  const resumed = await f.post('approvals', {
    interruptId: first.interruptId,
    decisions: [{ type: 'approve' }, { type: 'reject' }],
  });
  expect(resumed.body).toContain('event: awaiting_approval');
  const toolResults = model.seen[1].filter(isToolMessage);
  expect(toolResults).toHaveLength(2);
  expect(
    toolResults.find((message) => message.tool_call_id === 'approved-call')
      ?.text,
  ).toBe('approved-text');
  expect(
    toolResults.find((message) => message.tool_call_id === 'rejected-call'),
  ).toMatchObject({ status: 'error' });
  const next = (await f.query()).json().approvals[0];
  expect(next.interruptId).not.toBe(first.interruptId);
  expect(next.decisionStatus).toBe('pending');
  expect((await f.post('continue')).statusCode).toBe(409);
  const rejected = await f.post('approvals', {
    interruptId: next.interruptId,
    decisions: [{ type: 'reject' }],
  });
  expect(rejected.body).toContain('rejection acknowledged');
  expect(rejected.body).toContain('event: completed');
  expect(
    model.seen[2]
      .filter(isToolMessage)
      .find((message) => message.tool_call_id === 'new-call'),
  ).toMatchObject({ status: 'error' });
  expect((await f.query()).json().approvalAudit).toHaveLength(2);
});

it('never resumes without an audit receipt or resends a recorded decision whose outcome is unconfirmed', async () => {
  const model = new ScriptedModel([callTool('echo', { text: 'not executed' })]);
  const f = await setup(model);
  await f.post('input', { text: 'approval' });
  const { interruptId } = (await f.query()).json().approvals[0];
  const decision = { interruptId, decisions: [{ type: 'approve' as const }] };
  const insert = vi
    .spyOn(f.database.db, 'insert')
    .mockImplementationOnce(() => {
      throw new Error('private-audit-error');
    });
  const failed = await f.post('approvals', decision);
  insert.mockRestore();
  expect(failed.statusCode).toBe(500);
  expect(failed.body).not.toContain('private-audit-error');
  expect((await f.query()).json().canApprove).toBe(true);
  expect(await f.database.db.select().from(approvalAudits)).toEqual([]);
  const execution = createExecution(f.database, f.config, model);
  await expect(
    execution.execute(f.id, { userId: userA }, decision, async () => {
      throw new Error('response setup failed after receipt');
    }),
  ).rejects.toThrow('response setup failed after receipt');
  expect(model.seen).toHaveLength(1);
  expect((await f.query()).json()).toMatchObject({
    active: false,
    awaitingApproval: true,
    canApprove: false,
    approvals: [{ interruptId, decisionStatus: 'unconfirmed' }],
    approvalAudit: [{ interruptId, decisions: decision.decisions }],
  });
  // The unique key is the durable guard even across processes.
  await expect(
    f.database.db
      .insert(approvalAudits)
      .values({ conversationId: f.id, ...decision, userId: userA }),
  ).rejects.toThrow();
  // A later model configuration change cannot turn a recorded decision into a retry.
  await f.database.db.update(modelConfigs).set({ enabled: false });
  await f.app.close();
  const unused = new ScriptedModel([]);
  const app = createApp(createDatabase(url!), f.config, unused);
  apps.push(app);
  for (const type of ['approve', 'reject']) {
    const repeated = await app.inject({
      method: 'POST',
      url: `${f.path}/approvals`,
      headers: f.headers,
      payload: { interruptId, decisions: [{ type }] },
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error).toBe('Decision outcome unconfirmed');
  }
  expect(
    (await app.inject({ url: f.path, headers: f.headers })).json().approvals[0]
      .decisionStatus,
  ).toBe('unconfirmed');
  expect(unused.seen).toHaveLength(0);
  await app.inject({
    method: 'POST',
    url: `${f.path}/cancel`,
    headers: f.headers,
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${f.path}/approvals`,
        headers: f.headers,
        payload: decision,
      })
    ).json().error,
  ).toBe('Conversation closed');
});

it.each([true, false])(
  'serializes approval with cancellation when approval goes first: %s',
  async (approvalFirst) => {
    const blocked = gate();
    const model = new ScriptedModel([
      callTool('echo', { text: 'review me' }),
      blocked.response,
    ]);
    const f = await setup(model);
    await f.post('input', { text: 'approval race' });
    const { interruptId } = (await f.query()).json().approvals[0];
    const decision = { interruptId, decisions: [{ type: 'approve' }] };
    const execution = createExecution(f.database, f.config, model);
    const identity = { userId: userA };
    const events: string[] = [];
    const approve = () =>
      execution
        .execute(
          f.id,
          identity,
          {
            interruptId,
            decisions: [{ type: 'approve' }],
          },
          (call) =>
            call.stream(async (event, data) => {
              events.push(`${event}:${JSON.stringify(data)}`);
            }),
        )
        .then(
          () => 'accepted',
          (error: Error) => error.message,
        );
    // Both operations queue synchronously on the same lock before either DB read finishes.
    const first = approvalFirst ? approve() : execution.cancel(f.id, identity);
    const second = approvalFirst ? execution.cancel(f.id, identity) : approve();
    const canceled = await (approvalFirst ? second : first);
    expect(canceled).toMatchObject({
      closedAt: expect.any(Date),
      active: approvalFirst,
    });
    for (const action of ['input', 'continue', 'approvals'])
      expect(
        (
          await f.post(
            action,
            action === 'input'
              ? { text: 'closed' }
              : action === 'approvals'
                ? decision
                : undefined,
          )
        ).statusCode,
      ).toBe(409);
    blocked.release();
    const approval = await (approvalFirst ? first : second);
    expect(approval).toBe(approvalFirst ? 'accepted' : 'Conversation closed');
    if (approvalFirst) expect(events.join()).toContain('"status":"stopped"');
    expect(await execution.query(f.id, identity)).toMatchObject({
      closedAt: expect.any(Date),
      active: false,
      canApprove: false,
    });
    expect(await f.database.db.select().from(approvalAudits)).toHaveLength(
      approvalFirst ? 1 : 0,
    );
    expect(model.seen.length).toBeLessThanOrEqual(approvalFirst ? 2 : 1);
  },
);

it('requires available model configuration even with an injected client', async () => {
  const model = new ScriptedModel([]);
  const f = await setup(model);
  const [selected] = await f.database.db.select().from(modelConfigs);
  await f.database.db.update(modelConfigs).set({ enabled: false });
  expect(
    (
      await f.post('input', {
        text: 'disabled model',
        modelConfigId: selected.id,
      })
    ).statusCode,
  ).toBe(404);
  expect(model.seen).toHaveLength(0);
  expect((await f.query()).json().lastExecutionModelConfigId).toBeNull();
});

it('refuses execution without model configuration and disables provider request retries', async () => {
  const unconfigured = await setup(undefined);
  expect((await unconfigured.post('input', { text: 'hello' })).statusCode).toBe(
    400,
  );
  const key = 'ab'.repeat(32);
  const f = await setup(undefined, { MODEL_CREDENTIALS_KEY: key });
  const provider = await createProvider(
    f.database,
    {
      name: 'test',
      type: 'openai',
      apiKey: 'test-only-key',
    },
    key,
  );
  const selected = await createModel(f.database, {
    providerId: provider.providerId,
    modelName: 'gpt-4.1-mini',
  });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'private-provider-error',
            type: 'rate_limit_error',
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
  );
  try {
    const response = await f.post('input', {
      text: 'no retries',
      modelConfigId: selected.modelConfigId,
    });
    expect(response.body).toContain('event: error');
    expect(response.body).not.toContain('private-provider-error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    fetchMock.mockRestore();
  }
});

it('does not signal cancellation when persisting the close marker fails', async () => {
  const blocked = gate();
  const f = await setup(new ScriptedModel([blocked.response]));
  const running = f
    .post('input', { text: 'close failure' })
    .then((result) => result);
  await blocked.entered;
  const update = vi
    .spyOn(f.database.db, 'update')
    .mockImplementationOnce(() => {
      throw new Error('private-db-error');
    });
  expect((await f.post('cancel')).statusCode).toBe(500);
  update.mockRestore();
  expect((await f.query()).json()).toMatchObject({
    active: true,
    closedAt: null,
  });
  blocked.release();
  expect((await running).body).toContain('event: completed');
});

it('serializes simultaneous admission, continuation and cancellation without a second call', async () => {
  const blocked = gate();
  const model = new ScriptedModel([blocked.response]);
  const f = await setup(model);
  const entering = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  const getTuple = f.database.saver.getTuple.bind(f.database.saver);
  const read = vi
    .spyOn(f.database.saver, 'getTuple')
    .mockImplementationOnce(async (config) => {
      entering.resolve();
      await release.promise;
      return getTuple(config);
    });
  const first = f.post('input', { text: 'first' }).then((result) => result);
  await entering.promise;
  const second = f.post('input', { text: 'second' }).then((result) => result);
  const continuation = f.post('continue').then((result) => result);
  const cancel = f.post('cancel').then((result) => result);
  release.resolve();
  expect((await second).statusCode).toBe(409);
  expect((await continuation).statusCode).toBe(409);
  expect((await cancel).statusCode).toBe(200);
  blocked.release();
  await first;
  read.mockRestore();
  expect(model.seen.length).toBeLessThanOrEqual(1);
  expect((await f.query()).json()).toMatchObject({
    active: false,
    closedAt: expect.any(String),
  });
});

it('does not treat old state as proof of an input whose checkpoint was never saved', async () => {
  const model = new ScriptedModel([new AIMessage('old answer')]);
  const f = await setup(model);
  await f.post('input', { text: 'old input' });
  const put = vi
    .spyOn(f.database.saver, 'put')
    .mockRejectedValueOnce(new Error('interrupted before input persisted'));
  const failed = await f.post('input', { text: 'unsaved input' });
  expect(failed.body).toContain('event: error');
  put.mockRestore();
  await f.app.close();
  const db = createDatabase(url!);
  const unused = new ScriptedModel([]);
  const app = createApp(db, f.config, unused);
  apps.push(app);
  const saved = (await app.inject({ url: f.path, headers: f.headers })).json();
  expect(saved.messages.at(-1).content).toBe('old answer');
  expect(saved.messages).not.toContainEqual({
    role: 'user',
    content: 'unsaved input',
  });
  expect(unused.seen).toHaveLength(0);
  expect(model.seen).toHaveLength(1);
});
