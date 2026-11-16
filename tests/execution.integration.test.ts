import 'tsx';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  Command,
  GraphRunStream,
  type ProtocolEvent,
} from '@langchain/langgraph';
import { BytesLineDecoder, SSEDecoder } from '@langchain/langgraph-sdk/utils';
import type { Decision } from 'langchain';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { parseConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/client.js';
import { initializeDatabase } from '../src/database/initialize.js';
import { approvalAudits, modelConfigs } from '../src/database/schema.js';
import { createExecution } from '../src/runtime/execution.js';
import { createProvider, createModel } from '../src/models/manage.js';
import { jwtFixture, prepareUsers, userA, userB } from './auth-helpers.js';
import { callTool, ScriptedModel, startInput, resumeInput } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated real PostgreSQL database',
  );
const apps: ReturnType<typeof createApp>[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function setup(model: ScriptedModel, overrides: NodeJS.ProcessEnv = {}) {
  const fixture = jwtFixture();
  const config = parseConfig({
    DATABASE_URL: url,
    ...fixture.env,
    ...overrides,
  });
  await initializeDatabase(url!);
  const database = createDatabase(url!);
  await prepareUsers(database);
  const provider = await createProvider(
    database,
    { name: 'test', type: 'openai', apiKey: 'test-only-key' },
    'ab'.repeat(32),
  );
  const selected = await createModel(database, {
    providerId: provider.providerId,
    modelName: 'gpt-4.1-mini',
  });
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
  const modelConfigId = selected.modelConfigId;
  const input = (text: string) =>
    app.inject({
      method: 'POST',
      url: `${path}/runs`,
      headers,
      ...startInput({ text, modelConfigId }),
    });
  const resume = (interruptId: string, decisions: Decision[]) =>
    app.inject({
      method: 'POST',
      url: `${path}/runs`,
      headers,
      payload: resumeInput({ interruptId, decisions }),
    });
  const next = () =>
    app.inject({ method: 'POST', url: `${path}/runs`, headers });
  const query = () => app.inject({ url: path, headers });
  const metadata = () => app.inject({ url: `${path}/metadata`, headers });
  const cancel = () =>
    app.inject({ method: 'POST', url: `${path}/cancel`, headers });
  return {
    app,
    database,
    config,
    fixture,
    headers,
    id,
    path,
    modelConfigId,
    input,
    resume,
    next,
    query,
    metadata,
    cancel,
  };
}
function gate() {
  const entered = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<AIMessage>();
  const aborted = Promise.withResolvers<void>();
  const release = () => finished.resolve(new AIMessage('unblocked'));
  releases.push(release);
  return {
    entered: entered.promise,
    aborted: aborted.promise,
    release,
    response: async (options: { signal?: AbortSignal }) => {
      options.signal?.addEventListener('abort', () => aborted.resolve(), {
        once: true,
      });
      entered.resolve();
      return finished.promise;
    },
  };
}

it('passes native input unchanged and sends SDK events and snapshots without projection', async () => {
  const emitted: unknown[] = [];
  const iterate = GraphRunStream.prototype[Symbol.asyncIterator];
  vi.spyOn(GraphRunStream.prototype, Symbol.asyncIterator).mockImplementation(
    async function* (this: GraphRunStream) {
      for await (const event of {
        [Symbol.asyncIterator]: () => iterate.call(this),
      }) {
        emitted.push(JSON.parse(JSON.stringify(event)));
        yield event;
      }
    },
  );
  const text = '  original\tinput\r\n\n';
  const model = new ScriptedModel([
    new AIMessage({
      content: [
        { type: 'reasoning', reasoning: 'model reasoning' },
        { type: 'text', text: 'answer' },
      ],
      response_metadata: { providerMarker: 'model metadata' },
    }),
  ]);
  const f = await setup(model);
  const response = await f.input(text);
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('text/event-stream');
  const frames = await Array.fromAsync(
    new Response(response.body)
      .body!.pipeThrough(BytesLineDecoder())
      .pipeThrough(SSEDecoder()),
  );
  const events = frames.map(({ data }) => data as ProtocolEvent);
  expect(events).toEqual(emitted);
  expect(events.length).toBeGreaterThan(1);
  expect(
    events.every(
      (data) =>
        data.type === 'event' &&
        typeof data.seq === 'number' &&
        Array.isArray(data.params.namespace),
    ),
  ).toBe(true);
  expect(events.some((data) => data.method === 'updates')).toBe(true);
  expect(events.some((data) => data.method === 'values')).toBe(true);
  expect(response.body).toContain('model reasoning');
  expect(response.body).not.toContain('event_id');
  expect(response.body).not.toContain('input.requested');
  expect(
    model.seen[0]
      .filter(HumanMessage.isInstance)
      .map((message) => message.text),
  ).toEqual([text]);
  const snapshot = (await f.query()).json();
  expect(snapshot).toHaveProperty('config.configurable.thread_id', f.id);
  expect(snapshot).toHaveProperty('metadata');
  expect(snapshot.next).toEqual([]);
  expect(JSON.stringify(snapshot.values.messages)).toContain(
    JSON.stringify(text).slice(1, -1),
  );
  expect(JSON.stringify(snapshot)).toContain('model reasoning');
  expect(snapshot).not.toHaveProperty('canSubmit');
  expect((await f.metadata()).json()).toMatchObject({
    active: false,
    lastExecutionModelConfigId: f.modelConfigId,
  });
});

it('requires ownership on every native execution, state, metadata and cancellation request', async () => {
  const f = await setup(new ScriptedModel([]));
  for (const [suffix, method] of [
    ['', 'GET'],
    ['/metadata', 'GET'],
    ['/runs', 'POST'],
    ['/cancel', 'POST'],
  ] as const) {
    for (const other of [false, true]) {
      const headers = other
        ? { authorization: `Bearer ${await f.fixture.sign({ sub: userB })}` }
        : {};
      const response = await f.app.inject({
        method,
        url: `${f.path}${suffix}`,
        headers,
      });
      expect(response.statusCode).toBe(other ? 404 : 401);
    }
  }
});

it('validates the HTTP input boundary without trimming user content', async () => {
  const f = await setup(new ScriptedModel([]));
  for (const content of ['', ' \t\n ', 'x'.repeat(32001)]) {
    expect((await f.input(content)).statusCode).toBe(400);
  }
  for (const options of [
    { payload: { messages: [{ role: 'user', content: 'missing model' }] } },
    {
      query: { modelConfigId: 'invalid' },
      payload: { messages: [{ role: 'user', content: 'invalid model' }] },
    },
    { query: { modelConfigId: f.modelConfigId } },
    {
      query: { modelConfigId: f.modelConfigId },
      payload: { messages: [{ role: 'system', content: 'forged' }] },
    },
    {
      query: { modelConfigId: f.modelConfigId },
      payload: {
        messages: [{ role: 'user', content: 'forged' }],
        userId: userB,
      },
    },
    { payload: { resume: { missing: { decisions: [{ type: 'edit' }] } } } },
    {
      payload: {
        resume: {
          missing: {
            decisions: [
              { type: 'edit', editedAction: { name: 'echo', args: [] } },
            ],
          },
        },
      },
    },
    { payload: { resume: { missing: { decisions: [{ type: 'respond' }] } } } },
    {
      payload: {
        resume: { missing: { decisions: [{ type: 'respond', message: 42 }] } },
      },
    },
    {
      payload: {
        resume: { missing: { decisions: [{ type: 'reject', message: 42 }] } },
      },
    },
    { payload: { resume: {} } },
    { payload: { resume: { first: { decisions: [] } } } },
  ])
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/runs`,
          headers: f.headers,
          ...options,
        })
      ).statusCode,
    ).toBe(400);
});

it('retains exact checkpoints across failure and restart and only resumes explicitly', async () => {
  const text = ' \tpersist\r\n\n';
  const f = await setup(new ScriptedModel([new Error('native model error')]));
  expect((await f.input(text)).body).toContain('native model error');
  const snapshot = (await f.query()).json();
  expect(snapshot.next.length).toBeGreaterThan(0);
  expect(
    snapshot.tasks.some(
      (task: { error?: unknown }) => task.error !== undefined,
    ),
  ).toBe(true);
  expect((await f.input('cannot bypass')).statusCode).toBe(409);
  await f.app.close();
  const model = new ScriptedModel([new AIMessage('recovered')]);
  const app = createApp(createDatabase(url!), f.config, model);
  apps.push(app);
  expect(
    (await app.inject({ url: f.path, headers: f.headers })).statusCode,
  ).toBe(200);
  expect(model.seen).toHaveLength(0);
  const resumed = await app.inject({
    method: 'POST',
    url: `${f.path}/runs`,
    headers: f.headers,
  });
  expect(resumed.body).toContain('recovered');
  expect(
    model.seen[0]
      .filter(HumanMessage.isInstance)
      .map((message) => message.text),
  ).toEqual([text]);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${f.path}/runs`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(409);
});

it.each(['model', 'tool'])(
  'enforces %s limits with fresh continuation budgets',
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
    expect((await f.input('limited')).body).toContain('call limit reached');
    expect((await f.query()).json().next.length).toBeGreaterThan(0);
    expect((await f.input('bypass')).statusCode).toBe(409);
    expect((await f.next()).body).toContain('finished');
  },
);

it('serializes admission and keeps cancellation active until the model drains', async () => {
  const blocked = gate();
  const f = await setup(new ScriptedModel([blocked.response]));
  const running = f.input('blocked').then((response) => response);
  await blocked.entered;
  expect((await f.input('racing')).statusCode).toBe(409);
  expect((await f.next()).statusCode).toBe(409);
  const canceled = (await f.cancel()).json();
  expect(canceled).toMatchObject({
    active: true,
    closedAt: expect.any(String),
  });
  blocked.release();
  await running;
  expect((await f.cancel()).json()).toMatchObject({
    active: false,
    closedAt: canceled.closedAt,
  });
  expect((await f.input('closed')).statusCode).toBe(409);
});

it('stops and drains the current run when its HTTP client disconnects', async () => {
  const blocked = gate();
  const f = await setup(new ScriptedModel([blocked.response]));
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  try {
    const response = await fetch(
      `${address}${f.path}/runs?modelConfigId=${f.modelConfigId}`,
      {
        method: 'POST',
        headers: { ...f.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'disconnect' }],
        }),
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    await blocked.entered;
    controller.abort();
    await blocked.aborted;
    expect((await f.metadata()).json()).toMatchObject({
      active: true,
      closedAt: null,
    });
    blocked.release();
    await vi.waitFor(async () =>
      expect((await f.metadata()).json().active).toBe(false),
    );
    expect((await f.query()).json().next.length).toBeGreaterThan(0);
  } finally {
    controller.abort();
    blocked.release();
  }
});

it('stops on timeout without closing and waits for underlying work', async () => {
  const blocked = gate();
  const f = await setup(
    new ScriptedModel([blocked.response, new AIMessage('continued')]),
    { AGENT_TIMEOUT_MS: '1000' },
  );
  const running = f.input('timeout').then((response) => response);
  await blocked.entered;
  await new Promise<void>((resolve) => setTimeout(resolve, 1050));
  expect((await f.metadata()).json()).toMatchObject({
    active: true,
    closedAt: null,
  });
  blocked.release();
  await running;
  expect((await f.query()).json().next.length).toBeGreaterThan(0);
  expect((await f.next()).body).toContain('continued');
});

it('drains active execution on service shutdown', async () => {
  const blocked = gate();
  const f = await setup(new ScriptedModel([blocked.response]));
  const running = f.input('shutdown').then((response) => response);
  await blocked.entered;
  const stopping = f.app.close();
  blocked.release();
  await Promise.all([running, stopping]);
  const model = new ScriptedModel([]);
  const app = createApp(createDatabase(url!), f.config, model);
  apps.push(app);
  expect(
    (await app.inject({ url: f.path, headers: f.headers })).json().next.length,
  ).toBeGreaterThan(0);
  expect(model.seen).toHaveLength(0);
});

it('waits for admission while stopping and does not launch the model', async () => {
  const model = new ScriptedModel([]);
  const f = await setup(model);
  const execution = createExecution(f.database, f.config, model);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  const getTuple = f.database.saver.getTuple.bind(f.database.saver);
  vi.spyOn(f.database.saver, 'getTuple').mockImplementationOnce(
    async (config) => {
      entered.resolve();
      await release.promise;
      return getTuple(config);
    },
  );
  const running = execution.execute(
    f.id,
    { userId: userA },
    { messages: [{ role: 'user', content: 'admission' }] },
    f.modelConfigId,
    async () => {},
  );
  const rejected = expect(running).rejects.toThrow('Server stopping');
  await entered.promise;
  const stopping = execution.stop();
  release.resolve();
  await rejected;
  await stopping;
  expect(model.seen).toHaveLength(0);
});

it('passes full native approval payloads and tool outputs and resumes with Command input', async () => {
  const text = `  ${'visible '.repeat(30)}complete-tail\n\n`;
  const model = new ScriptedModel([
    callTool('echo', { text, extraArgument: 'model argument' }),
    new AIMessage('approved'),
  ]);
  const f = await setup(model);
  const waiting = await f.input('approval');
  expect(waiting.body).toContain('extraArgument');
  expect(waiting.body).toContain('complete-tail');
  expect(waiting.body).not.toContain('input.requested');
  const pending = (await f.query()).json().tasks[0].interrupts[0];
  expect(pending.value.actionRequests[0]).toMatchObject({
    name: 'echo',
    args: { text, extraArgument: 'model argument' },
    description: expect.stringContaining('complete-tail'),
  });
  expect(pending.value.reviewConfigs[0].allowedDecisions).toEqual([
    'approve',
    'edit',
    'reject',
    'respond',
  ]);
  expect((await f.input('bypass')).statusCode).toBe(409);
  expect((await f.next()).statusCode).toBe(409);
  expect((await f.resume(pending.id, [])).statusCode).toBe(400);
  const resumed = await f.resume(pending.id, [{ type: 'approve' }]);
  expect(resumed.body).toContain('tool-finished');
  expect(resumed.body).toContain('complete-tail');
  expect(resumed.body).not.toContain('input.answered');
  expect(model.seen[1].filter(ToolMessage.isInstance)[0].content).toBe(text);
  expect((await f.metadata()).json().approvalAudit).toMatchObject([
    {
      interruptId: pending.id,
      decisions: [{ type: 'approve' }],
      userId: userA,
    },
  ]);
});

it('restores native batched interrupts and preserves all four decisions across restart', async () => {
  const text = '  approval\n';
  const decisions: Decision[] = [
    { type: 'approve' },
    {
      type: 'edit',
      editedAction: { name: 'echo', args: { text: '  edited\ttext\n' } },
    },
    { type: 'reject', message: '  do not run this call\n' },
    { type: 'respond', message: '  human result\n' },
  ];
  const f = await setup(
    new ScriptedModel([
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'one', name: 'echo', args: { text }, type: 'tool_call' },
          {
            id: 'two',
            name: 'echo',
            args: { text: 'edit me' },
            type: 'tool_call',
          },
          {
            id: 'three',
            name: 'echo',
            args: { text: 'reject me' },
            type: 'tool_call',
          },
          {
            id: 'four',
            name: 'echo',
            args: { text: 'answer for me' },
            type: 'tool_call',
          },
        ],
      }),
    ]),
  );
  await f.input('batch');
  const pending = (await f.query()).json().tasks[0].interrupts[0];
  expect((await f.resume(pending.id, decisions.slice(0, 3))).statusCode).toBe(
    400,
  );
  expect((await f.metadata()).json().approvalAudit).toEqual([]);
  await f.app.close();
  const model = new ScriptedModel([new AIMessage('reviewed')]);
  const app = createApp(createDatabase(url!), f.config, model);
  apps.push(app);
  const reply = await app.inject({
    method: 'POST',
    url: `${f.path}/runs`,
    headers: f.headers,
    payload: resumeInput({ interruptId: pending.id, decisions }),
  });
  expect(reply.statusCode).toBe(200);
  expect(reply.body).toContain('reviewed');
  expect(reply.body.match(/"event":"tool-started"/g)).toHaveLength(2);
  const results = model.seen[0].filter(ToolMessage.isInstance);
  expect(results).toHaveLength(4);
  expect(
    results.find((message) => message.tool_call_id === 'one')?.content,
  ).toBe(text);
  expect(
    results.find((message) => message.tool_call_id === 'two')?.content,
  ).toBe('  edited\ttext\n');
  expect(
    results.find((message) => message.tool_call_id === 'three'),
  ).toMatchObject({ content: '  do not run this call\n', status: 'error' });
  expect(
    results.find((message) => message.tool_call_id === 'four'),
  ).toMatchObject({ content: '  human result\n', status: 'success' });
  await app.close();
  const restarted = createApp(
    createDatabase(url!),
    f.config,
    new ScriptedModel([]),
  );
  apps.push(restarted);
  expect(
    (
      await restarted.inject({ url: `${f.path}/metadata`, headers: f.headers })
    ).json().approvalAudit,
  ).toMatchObject([{ interruptId: pending.id, decisions, userId: userA }]);
  expect(
    (await restarted.inject({ url: f.path, headers: f.headers })).json().next,
  ).toEqual([]);
});

it('executes edited arguments using the native decision and records the complete edit', async () => {
  const model = new ScriptedModel([
    callTool('echo', { text: 42 }),
    new AIMessage('edited'),
  ]);
  const f = await setup(model);
  await f.input('correct the tool arguments');
  const pending = (await f.query()).json().tasks[0].interrupts[0];
  expect(pending.value.actionRequests[0].args).toEqual({ text: 42 });
  const decisions: Decision[] = [
    {
      type: 'edit',
      editedAction: { name: 'echo', args: { text: '  corrected\ttext\n' } },
    },
  ];
  const reply = await f.resume(pending.id, decisions);
  expect(reply.statusCode).toBe(200);
  expect(reply.body).toContain('tool-started');
  expect(model.seen[1].filter(ToolMessage.isInstance)[0].content).toBe(
    '  corrected\ttext\n',
  );
  expect((await f.metadata()).json().approvalAudit[0].decisions).toEqual(
    decisions,
  );
});

it('returns a human response without executing the tool and records the complete response', async () => {
  const model = new ScriptedModel([
    callTool('echo', { text: 'tool output' }),
    new AIMessage('answered'),
  ]);
  const f = await setup(model);
  await f.input('answer for the tool');
  const pending = (await f.query()).json().tasks[0].interrupts[0];
  const decisions: Decision[] = [
    { type: 'respond', message: '  human answer\t\n' },
  ];
  const reply = await f.resume(pending.id, decisions);
  expect(reply.statusCode).toBe(200);
  expect(reply.body).not.toContain('tool-started');
  expect(model.seen[1].filter(ToolMessage.isInstance)[0]).toMatchObject({
    content: '  human answer\t\n',
    status: 'success',
  });
  expect((await f.metadata()).json().approvalAudit[0].decisions).toEqual(
    decisions,
  );
});

it('requires an audit and refuses to resend any recorded decision', async () => {
  const model = new ScriptedModel([callTool('echo', { text: 'review' })]);
  const f = await setup(model);
  await f.input('approval');
  const pending = (await f.query()).json().tasks[0].interrupts[0];
  const insert = vi
    .spyOn(f.database.db, 'insert')
    .mockImplementationOnce(() => {
      throw new Error('audit error');
    });
  const decisions: Decision[] = [
    {
      type: 'edit',
      editedAction: { name: 'echo', args: { text: 'edited result' } },
    },
  ];
  expect((await f.resume(pending.id, decisions)).statusCode).toBe(500);
  insert.mockRestore();
  const getTuple = f.database.saver.getTuple.bind(f.database.saver);
  const read = vi
    .spyOn(f.database.saver, 'getTuple')
    .mockImplementationOnce(getTuple)
    .mockRejectedValueOnce(new Error('resume error'));
  await f.resume(pending.id, decisions);
  read.mockRestore();
  expect(model.seen).toHaveLength(1);
  expect((await f.metadata()).json().approvalAudit).toMatchObject([
    { decisions },
  ]);
  expect((await f.query()).json().tasks[0].interrupts[0].id).toBe(pending.id);
  await f.database.db.update(modelConfigs).set({ enabled: false });
  expect(
    (
      await f.resume(pending.id, [
        { type: 'respond', message: 'different decision' },
      ])
    ).json().error,
  ).toBe('Decision outcome unconfirmed');
});

it.each([true, false])(
  'serializes approval and cancellation when approval starts first: %s',
  async (first) => {
    const model = new ScriptedModel([
      callTool('echo', { text: 'review' }),
      new AIMessage('done'),
    ]);
    const f = await setup(model);
    await f.input('race');
    const pending = (await f.query()).json().tasks[0].interrupts[0];
    const execution = createExecution(f.database, f.config, model);
    const identity = { userId: userA };
    const approve = () =>
      execution
        .execute(
          f.id,
          identity,
          new Command({
            resume: { [pending.id]: { decisions: [{ type: 'approve' }] } },
          }),
          undefined,
          async (run) => {
            for await (const event of run) void event;
          },
        )
        .then(
          () => 'accepted',
          (error: Error) => error.message,
        );
    const a = first ? approve() : execution.cancel(f.id, identity);
    const b = first ? execution.cancel(f.id, identity) : approve();
    expect(await (first ? b : a)).toMatchObject({ closedAt: expect.any(Date) });
    await (first ? a : b);
    await execution.stop();
    expect(await f.database.db.select().from(approvalAudits)).toHaveLength(
      first ? 1 : 0,
    );
  },
);

it('cancels and drains a native run when its consumer fails', async () => {
  const blocked = gate();
  const f = await setup(new ScriptedModel([blocked.response]));
  const execution = createExecution(
    f.database,
    f.config,
    new ScriptedModel([blocked.response]),
  );
  const running = execution.execute(
    f.id,
    { userId: userA },
    { messages: [{ role: 'user', content: 'consumer' }] },
    f.modelConfigId,
    async () => {
      await blocked.entered;
      throw new Error('writer failed');
    },
  );
  const rejected = expect(running).rejects.toThrow('writer failed');
  await blocked.aborted;
  expect((await execution.metadata(f.id, { userId: userA })).active).toBe(true);
  blocked.release();
  await rejected;
  expect((await execution.metadata(f.id, { userId: userA })).active).toBe(
    false,
  );
  await execution.stop();
});
