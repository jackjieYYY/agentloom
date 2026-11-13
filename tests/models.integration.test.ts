import 'tsx';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { parseConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/client.js';
import { initializeDatabase } from '../src/database/initialize.js';
import {
  conversations,
  modelConfigs,
  modelProviders,
} from '../src/database/schema.js';
import { jwtFixture, prepareUsers, userA, userB } from './auth-helpers.js';
import { ScriptedModel } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated real PostgreSQL database',
  );
const key = 'ab'.repeat(32);
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  const cleanup = createDatabase(url!);
  try {
    await cleanup.db.delete(conversations);
    await cleanup.db.delete(modelConfigs);
    await cleanup.db.delete(modelProviders);
  } finally {
    await cleanup.close();
  }
});

async function setup(model?: ScriptedModel) {
  const userId = randomUUID();
  const fixture = jwtFixture();
  const config = parseConfig({
    DATABASE_URL: url,
    ...fixture.env,
    MODEL_CREDENTIALS_KEY: key,
  });
  await initializeDatabase(url!);
  const database = createDatabase(url!);
  await prepareUsers(database, [userId, userA, userB]);
  const app = createApp(database, config, model);
  apps.push(app);
  const headers = {
    authorization: `Bearer ${await fixture.sign({ sub: userId })}`,
  };
  const request = async (
    method: 'POST' | 'PATCH',
    path: string,
    payload: Record<string, unknown>,
  ) => {
    const response = await app.inject({ method, url: path, headers, payload });
    expect(response.statusCode, response.body).toBe(
      method === 'POST' ? 201 : 200,
    );
    return response.json();
  };
  const a = await request('POST', '/providers', {
    name: 'Provider A',
    type: 'openai-compatible',
    baseUrl: 'https://a.models.example/v1',
    apiKey: 'private-key-a',
  });
  const b = await request('POST', '/providers', {
    name: 'Provider B',
    type: 'openai-compatible',
    baseUrl: 'https://b.models.example/v1',
    apiKey: 'private-key-b',
  });
  const ma = await request('POST', '/models', {
    providerId: a.providerId,
    modelName: 'codex-a',
  });
  const mb = await request('POST', '/models', {
    providerId: b.providerId,
    modelName: 'model-b',
  });
  const modelA = ma.modelConfigId!;
  const modelB = mb.modelConfigId!;
  const created = await app.inject({
    method: 'POST',
    url: '/conversations',
    headers,
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().conversationId as string;
  const path = `/conversations/${id}`;
  return {
    userId,
    fixture,
    config,
    database,
    app,
    headers,
    request,
    providerA: a.providerId!,
    providerB: b.providerId!,
    modelA,
    modelB,
    id,
    path,
  };
}

type ProviderRequest = {
  url: string;
  authorization: string | null;
  body: { model: string; messages: { role: string; content: unknown }[] };
};
function providerMock(responses: ('text' | 'tool' | 'todos' | 'error')[] = []) {
  const calls: ProviderRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      body,
    });
    const response = responses.shift() ?? 'text';
    if (response === 'error')
      return new Response(
        JSON.stringify({ error: { message: 'private-provider-error' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    const delta =
      response === 'tool' || response === 'todos'
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call-echo',
                type: 'function',
                function:
                  response === 'tool'
                    ? { name: 'echo', arguments: '{"text":"safe"}' }
                    : { name: 'write_todos', arguments: '{"todos":[]}' },
              },
            ],
          }
        : { role: 'assistant', content: `${body.model} answer` };
    const frame = {
      id: `chatcmpl-test-${calls.length}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    const finish = {
      ...frame,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason:
            response === 'tool' || response === 'todos' ? 'tool_calls' : 'stop',
        },
      ],
    };
    return new Response(
      `data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  return calls;
}

it('switches A → B → A within one chat, preserves tool history and keeps chats independent', async () => {
  const f = await setup();
  const calls = providerMock(['tool', 'text', 'text', 'text', 'text']);
  const post = (payload: Record<string, unknown>) =>
    f.app.inject({
      method: 'POST',
      url: `${f.path}/input`,
      headers: f.headers,
      payload,
    });
  expect(
    (await post({ text: 'first', modelConfigId: f.modelA })).body,
  ).toContain('event: awaiting_approval');
  const pending = (
    await f.app.inject({ url: f.path, headers: f.headers })
  ).json();
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${f.path}/approvals`,
        headers: f.headers,
        payload: {
          interruptId: pending.approvals[0].interruptId,
          decisions: [{ type: 'approve' }],
        },
      })
    ).body,
  ).toContain('event: completed');
  expect(
    (await post({ text: 'second', modelConfigId: f.modelB })).body,
  ).toContain('model-b answer');
  expect(
    (await post({ text: 'third', modelConfigId: f.modelA })).body,
  ).toContain('codex-a answer');
  expect(calls.map((call) => call.body.model)).toEqual([
    'codex-a',
    'codex-a',
    'model-b',
    'codex-a',
  ]);
  expect(calls.every((call) => call.url.endsWith('/chat/completions'))).toBe(
    true,
  );
  expect(calls[2].url).toContain('b.models.example');
  expect(calls[2].authorization).toBe('Bearer private-key-b');
  expect(
    calls[2].body.messages.some((message) => message.role === 'tool'),
  ).toBe(true);
  expect(
    calls[3].body.messages.some(
      (message) => message.content === 'model-b answer',
    ),
  ).toBe(true);
  const state = (
    await f.app.inject({ url: f.path, headers: f.headers })
  ).json();
  expect(state).not.toHaveProperty('defaultModelConfigId');
  expect(state).not.toHaveProperty('defaultModel');
  expect(state.lastExecutionModelConfigId).toBe(f.modelA);
  expect(state.lastExecutionModel).toEqual({
    id: f.modelA,
    modelName: 'codex-a',
  });
  expect(JSON.stringify(state)).not.toContain('private-key');
  const created = await f.app.inject({
    method: 'POST',
    url: '/conversations',
    headers: f.headers,
  });
  const otherPath = `/conversations/${created.json().conversationId}`;
  await f.app.inject({
    method: 'POST',
    url: `${otherPath}/input`,
    headers: f.headers,
    payload: { text: 'separate', modelConfigId: f.modelB },
  });
  expect(calls.at(-1)!.body.model).toBe('model-b');
  expect(
    calls.at(-1)!.body.messages.some((message) => message.content === 'first'),
  ).toBe(false);
  const callsBefore = calls.length;
  const missing = await post({ text: 'missing selection' });
  expect(missing.statusCode).toBe(400);
  expect(missing.json().error).toBe('Invalid request');
  expect(calls).toHaveLength(callsBefore);
  await post({ text: 'fifth', modelConfigId: f.modelA });
  expect(calls.at(-1)!.body.model).toBe('codex-a');
});

it('persists the selected model across restart and rejects override on continuation', async () => {
  const f = await setup();
  const calls = providerMock(['error', 'text']);
  const failed = await f.app.inject({
    method: 'POST',
    url: `${f.path}/input`,
    headers: f.headers,
    payload: { text: 'resume this', modelConfigId: f.modelB },
  });
  expect(failed.body).toContain('event: error');
  expect(failed.body).not.toContain('private-provider-error');
  expect(calls).toHaveLength(1);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${f.path}/input`,
        headers: f.headers,
        payload: { text: 'cannot bypass', modelConfigId: f.modelA },
      })
    ).statusCode,
  ).toBe(409);
  await f.request('PATCH', `/providers/${f.providerB}`, {
    type: 'openai',
    baseUrl: 'https://updated.models.example/v1',
    apiKey: 'updated-key',
  });
  await f.request('PATCH', `/models/${f.modelB}`, { modelName: 'gpt-4o' });
  await f.app.close();
  const app = createApp(createDatabase(url!), f.config);
  apps.push(app);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${f.path}/continue`,
        headers: f.headers,
        payload: { modelConfigId: f.modelA },
      })
    ).statusCode,
  ).toBe(400);
  const resumed = await app.inject({
    method: 'POST',
    url: `${f.path}/continue`,
    headers: f.headers,
  });
  expect(resumed.body).toContain('gpt-4o answer');
  expect(calls.map((call) => call.body.model)).toEqual(['model-b', 'gpt-4o']);
  expect(calls[1].url).toContain('updated.models.example');
  expect(calls[1].authorization).toBe('Bearer updated-key');
  expect(
    calls[1].body.messages.filter((message) => message.role === 'user'),
  ).toHaveLength(1);
});

it('shares model selection globally while isolating paginated chats by owner', async () => {
  const f = await setup();
  const calls = providerMock();
  const otherHeaders = {
    authorization: `Bearer ${await f.fixture.sign({ sub: userA })}`,
  };
  const userHeaders = {
    authorization: `Bearer ${await f.fixture.sign({ sub: userB })}`,
  };
  for (let i = 0; i < 3; i++)
    await f.app.inject({
      method: 'POST',
      url: '/conversations',
      headers: f.headers,
    });
  // Force identical timestamps to exercise the id tie-breaker without sleeps.
  await f.database.db
    .update(conversations)
    .set({ createdAt: new Date('2025-01-01T00:00:00Z') })
    .where(eq(conversations.userId, f.userId));
  const page = (
    await f.app.inject({ url: '/conversations?limit=2', headers: f.headers })
  ).json();
  const next = (
    await f.app.inject({
      url: `/conversations?limit=2&cursor=${page.nextCursor}`,
      headers: f.headers,
    })
  ).json();
  expect(page.items).toHaveLength(2);
  expect(next.items).toHaveLength(2);
  expect(next.nextCursor).toBeNull();
  expect(
    new Set(
      [...page.items, ...next.items].map(
        (row: { conversationId: string }) => row.conversationId,
      ),
    ).size,
  ).toBe(4);
  for (const headers of [otherHeaders, userHeaders]) {
    expect(
      (await f.app.inject({ url: '/conversations', headers })).json().items,
    ).toEqual([]);
    expect(
      (await f.app.inject({ url: `/conversations?cursor=${f.id}`, headers }))
        .statusCode,
    ).toBe(404);
  }
  const other = await f.app.inject({
    method: 'POST',
    url: '/conversations',
    headers: otherHeaders,
  });
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/conversations/${other.json().conversationId}/input`,
        headers: otherHeaders,
        payload: { text: 'explicit selection', modelConfigId: f.modelA },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await f.app.inject({ url: '/models', headers: otherHeaders })).json(),
  ).toEqual(
    (await f.app.inject({ url: '/models', headers: f.headers })).json(),
  );
  expect(calls.at(-1)).toMatchObject({
    authorization: 'Bearer private-key-a',
    body: { model: 'codex-a' },
  });
  const models = await f.app.inject({ url: '/models', headers: f.headers });
  expect(models.json()).toHaveLength(2);
  expect(models.json()[0]).toHaveProperty('modelName');
  expect(models.json()[0]).not.toHaveProperty('name');
  expect(models.json()[0]).not.toHaveProperty('isDefault');
  for (const secret of [
    'private-key',
    'apiKeyEncrypted',
    'baseUrl',
    'models.example',
  ])
    expect(models.body).not.toContain(secret);
  expect((await f.app.inject('/models')).statusCode).toBe(401);
  for (const query of ['limit=101', 'limit=0', 'limit=bad', 'cursor=bad'])
    expect(
      (
        await f.app.inject({
          url: `/conversations?${query}`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(400);
});

it('rotates credentials, rejects disabled selections without fallback, and permits reads without a master key', async () => {
  const f = await setup();
  const calls = providerMock();
  await f.request('PATCH', `/providers/${f.providerA}`, {
    apiKey: 'rotated-private-key',
  });
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${f.path}/input`,
        headers: f.headers,
        payload: { text: 'rotated', modelConfigId: f.modelA },
      })
    ).body,
  ).toContain('event: completed');
  expect(calls[0].authorization).toBe('Bearer rotated-private-key');
  await f.request('PATCH', `/models/${f.modelB}`, {
    enabled: false,
  });
  const disabled = await f.app.inject({
    method: 'POST',
    url: `${f.path}/input`,
    headers: f.headers,
    payload: { text: 'no fallback', modelConfigId: f.modelB },
  });
  expect(disabled.statusCode).toBe(404);
  expect(calls).toHaveLength(1);
  const config = { ...f.config, MODEL_CREDENTIALS_KEY: undefined };
  const readOnly = createApp(createDatabase(url!), config);
  apps.push(readOnly);
  expect(
    (await readOnly.inject({ url: f.path, headers: f.headers })).statusCode,
  ).toBe(200);
  expect(
    (
      await readOnly.inject({
        method: 'POST',
        url: `${f.path}/input`,
        headers: f.headers,
        payload: { text: 'missing key', modelConfigId: f.modelA },
      })
    ).statusCode,
  ).toBe(503);
  await f.request('PATCH', `/providers/${f.providerA}`, {
    enabled: false,
  });
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `${f.path}/input`,
        headers: f.headers,
        payload: { text: 'disabled provider', modelConfigId: f.modelA },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await readOnly.inject({
        method: 'POST',
        url: `${f.path}/cancel`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(200);
});

it('keeps provider API output credential-free and encrypts stored keys', async () => {
  const f = await setup();
  const created = await f.request('POST', '/providers', {
    type: 'openai',
    name: 'API provider',
    apiKey: 'api-private-key',
  });
  const providers = await f.app.inject({
    url: '/providers',
    headers: f.headers,
  });
  expect(providers.body).not.toContain('private-key');
  expect(providers.body).not.toContain('apiKeyEncrypted');
  expect(providers.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: created.providerId,
        baseUrl: 'https://api.openai.com/v1',
      }),
    ]),
  );
  const [stored] = await f.database.db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.id, created.providerId));
  expect(stored.apiKeyEncrypted).not.toContain('api-private-key');
});

it('keeps every in-flight model call fixed while provider routing and model configuration change', async () => {
  const f = await setup();
  const calls = providerMock(['todos', 'text', 'text']);
  const fetch = vi.mocked(globalThis.fetch);
  const respond = fetch.getMockImplementation()!;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fetch.mockImplementationOnce(async (...args) => {
    const response = await respond(...args);
    entered.resolve();
    await release.promise;
    return response;
  });
  const running = f.app
    .inject({
      method: 'POST',
      url: `${f.path}/input`,
      headers: f.headers,
      payload: { text: 'in flight', modelConfigId: f.modelA },
    })
    .then((response) => response);
  try {
    await entered.promise;
    await f.request('PATCH', `/providers/${f.providerA}`, {
      apiKey: 'new-private-key',
      type: 'openai',
      baseUrl: 'https://new.models.example/v1',
    });
    await f.request('PATCH', `/models/${f.modelA}`, {
      modelName: 'gpt-4o',
    });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.path}/input`,
          headers: f.headers,
          payload: { text: 'racing', modelConfigId: f.modelB },
        })
      ).statusCode,
    ).toBe(409);
    const state = (
      await f.app.inject({ url: f.path, headers: f.headers })
    ).json();
    expect(state).toMatchObject({
      active: true,
      lastExecutionModelConfigId: f.modelA,
    });
  } finally {
    release.resolve();
    await running;
  }
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.authorization).toBe('Bearer private-key-a');
    expect(call.url).toContain('a.models.example');
    expect(call.body.model).toBe('codex-a');
  }
  await f.app.inject({
    method: 'POST',
    url: `${f.path}/input`,
    headers: f.headers,
    payload: { text: 'next', modelConfigId: f.modelA },
  });
  expect(calls[2].body.model).toBe('gpt-4o');
  expect(calls[2].url).toContain('new.models.example');
  expect(calls[2].authorization).toBe('Bearer new-private-key');
});

it('continues work started with an injected model using the configured client after restart', async () => {
  const model = new ScriptedModel([new Error('test failure')]);
  const f = await setup(model);
  const failed = await f.app.inject({
    method: 'POST',
    url: `${f.path}/input`,
    headers: f.headers,
    payload: { text: 'resume injected work', modelConfigId: f.modelA },
  });
  expect(failed.body).toContain('event: error');
  expect(model.seen).toHaveLength(1);
  const state = (
    await f.app.inject({ url: f.path, headers: f.headers })
  ).json();
  expect(state).toMatchObject({
    lastExecutionModelConfigId: f.modelA,
    canContinue: true,
  });
  await f.app.close();
  const app = createApp(createDatabase(url!), f.config);
  apps.push(app);
  const calls = providerMock();
  const resumed = await app.inject({
    method: 'POST',
    url: `${f.path}/continue`,
    headers: f.headers,
  });
  expect(resumed.statusCode).toBe(200);
  expect(resumed.body).toContain('event: completed');
  expect(calls).toHaveLength(1);
  expect(calls[0].body.model).toBe('codex-a');
  expect(calls[0].body.messages).toContainEqual({
    role: 'user',
    content: 'resume injected work',
  });
});

it('validates configuration requests and shares management APIs across users', async () => {
  const f = await setup();
  const foreignHeaders = { authorization: '' };
  foreignHeaders.authorization =
    'Bearer ' + (await f.fixture.sign({ sub: userA }));
  for (const path of ['/providers', '/models']) {
    expect((await f.app.inject({ url: path })).statusCode).toBe(401);
    expect(
      (await f.app.inject({ url: path, headers: foreignHeaders })).json(),
    ).toEqual((await f.app.inject({ url: path, headers: f.headers })).json());
  }
  for (const [path, payload] of [
    ['/providers/' + f.providerA, { name: 'shared' }],
    ['/models/' + f.modelA, { modelName: 'shared' }],
  ] as const) {
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: path,
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: path,
          headers: foreignHeaders,
          payload,
        })
      ).statusCode,
    ).toBe(200);
  }
  for (const path of ['/providers', '/models'])
    expect(
      (await f.app.inject({ method: 'POST', url: path, payload: {} }))
        .statusCode,
    ).toBe(401);
  const invalid: {
    method: 'POST' | 'PATCH';
    url: string;
    payload: Record<string, unknown>;
  }[] = [
    {
      method: 'POST',
      url: '/providers',
      payload: {
        name: 'bad',
        type: 'openai',
        apiKey: 'secret',
        userId: 'spoofed',
      },
    },
    {
      method: 'POST',
      url: '/providers',
      payload: { name: 'bad', type: 'openai-compatible', apiKey: 'secret' },
    },
    {
      method: 'POST',
      url: '/providers',
      payload: { name: 'bad', type: 'unknown', apiKey: 'secret' },
    },
    { method: 'PATCH', url: '/providers/' + f.providerA, payload: {} },
    {
      method: 'PATCH',
      url: '/providers/' + f.providerA,
      payload: { baseUrl: 'http://unsafe.example' },
    },
    {
      method: 'PATCH',
      url: '/providers/' + f.providerA,
      payload: { apiKey: 'secret\ninvalid' },
    },
    { method: 'PATCH', url: '/providers/invalid', payload: { name: 'bad' } },
    { method: 'PATCH', url: '/models/' + f.modelA, payload: {} },
    { method: 'PATCH', url: '/models/' + f.modelA, payload: { modelName: '' } },
    {
      method: 'PATCH',
      url: '/models/' + f.modelA,
      payload: { name: 'unused alias' },
    },
    {
      method: 'PATCH',
      url: '/models/' + f.modelA,
      payload: { providerId: f.providerB, modelName: 'forbidden' },
    },
    {
      method: 'PATCH',
      url: '/models/' + f.modelA,
      payload: { isDefault: true, modelName: 'forbidden' },
    },
    {
      method: 'POST',
      url: '/models',
      payload: { providerId: f.providerA, modelName: 'test', isDefault: true },
    },
    {
      method: 'POST',
      url: '/models',
      payload: { providerId: f.providerA },
    },
  ];
  for (const input of invalid) {
    const response = await f.app.inject({ ...input, headers: f.headers });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).not.toContain('secret');
  }
  for (const input of [
    {
      method: 'POST' as const,
      url: '/models',
      payload: { providerId: randomUUID(), modelName: 'test' },
    },
    {
      method: 'PATCH' as const,
      url: '/providers/' + randomUUID(),
      payload: { name: 'missing' },
    },
  ]) {
    const response = await f.app.inject({
      ...input,
      headers: input.method === 'POST' ? foreignHeaders : f.headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Provider not found',
      requestId: response.headers['x-request-id'],
    });
  }
  const missingModel = await f.app.inject({
    method: 'PATCH',
    url: '/models/' + randomUUID(),
    headers: f.headers,
    payload: { modelName: 'missing' },
  });
  expect(missingModel.statusCode).toBe(404);
  expect(missingModel.json()).toEqual({
    error: 'Model not found',
    requestId: missingModel.headers['x-request-id'],
  });
  const shared = await f.app.inject({
    method: 'POST',
    url: '/models',
    headers: foreignHeaders,
    payload: {
      providerId: f.providerA,
      modelName: 'shared',
    },
  });
  expect(shared.statusCode).toBe(201);
  expect(
    (await f.app.inject({ url: '/models', headers: f.headers })).json(),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: shared.json().modelConfigId }),
    ]),
  );
  expect(
    (
      await f.app.inject({
        method: 'PATCH',
        url: '/models/' + shared.json().modelConfigId,
        headers: f.headers,
        payload: { modelName: 'shared-renamed' },
      })
    ).statusCode,
  ).toBe(200);
  const userHeaders = {
    authorization: 'Bearer ' + (await f.fixture.sign({ sub: userB })),
  };
  expect(
    (
      await f.app.inject({
        method: 'PATCH',
        url: '/providers/' + f.providerA,
        headers: userHeaders,
        payload: { name: 'Shared provider' },
      })
    ).statusCode,
  ).toBe(200);
});

it('patches only supplied model fields while the provider is disabled', async () => {
  const f = await setup();
  await f.request('PATCH', `/providers/${f.providerA}`, { enabled: false });
  const [before] = await f.database.db
    .select()
    .from(modelConfigs)
    .where(eq(modelConfigs.id, f.modelA));
  await f.request('PATCH', `/models/${f.modelA}`, {
    modelName: 'offline-model',
  });
  const [renamed] = await f.database.db
    .select()
    .from(modelConfigs)
    .where(eq(modelConfigs.id, f.modelA));
  expect(renamed).toEqual({
    ...before,
    modelName: 'offline-model',
    updatedAt: expect.any(Date),
  });
  await f.request('PATCH', `/models/${f.modelA}`, { enabled: false });
  const [updated] = await f.database.db
    .select()
    .from(modelConfigs)
    .where(eq(modelConfigs.id, f.modelA));
  expect(updated).toEqual({
    ...renamed,
    enabled: false,
    updatedAt: expect.any(Date),
  });
});

it('lists disabled models and allows creation under a disabled provider', async () => {
  const f = await setup();
  await f.request('PATCH', '/models/' + f.modelB, { enabled: false });
  await f.request('PATCH', '/providers/' + f.providerB, { enabled: false });
  const all = (
    await f.app.inject({
      url: '/models',
      headers: f.headers,
    })
  ).json();
  expect(all).toHaveLength(2);
  expect(all.find((row: { id: string }) => row.id === f.modelB)).toMatchObject({
    enabled: false,
    providerId: f.providerB,
    providerEnabled: false,
  });
  const created = await f.request('POST', '/models', {
    providerId: f.providerB,
    modelName: 'offline-model',
  });
  const unavailable = await f.app.inject({
    method: 'POST',
    url: f.path + '/input',
    headers: f.headers,
    payload: { text: 'unavailable', modelConfigId: created.modelConfigId },
  });
  expect(unavailable.statusCode).toBe(404);
  const noKey = createApp(createDatabase(url!), {
    ...f.config,
    MODEL_CREDENTIALS_KEY: undefined,
  });
  apps.push(noKey);
  for (const input of [
    {
      method: 'POST' as const,
      url: '/providers',
      payload: { name: 'missing key', type: 'openai', apiKey: 'private-key' },
    },
    {
      method: 'PATCH' as const,
      url: '/providers/' + f.providerA,
      payload: { apiKey: 'private-key' },
    },
  ]) {
    const result = await noKey.inject({ ...input, headers: f.headers });
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain('private-key');
  }
  expect(
    (
      await noKey.inject({
        method: 'PATCH',
        url: '/providers/' + f.providerA,
        headers: f.headers,
        payload: { name: 'No key needed' },
      })
    ).statusCode,
  ).toBe(200);
});

it('rejects provider credential substitution before any model request and accepts a newly encrypted key', async () => {
  const f = await setup();
  const calls = providerMock();
  const [other] = await f.database.db
    .select({ encrypted: modelProviders.apiKeyEncrypted })
    .from(modelProviders)
    .where(eq(modelProviders.id, f.providerB));
  expect(other.encrypted.split('.')).toHaveLength(5);
  await f.database.db
    .update(modelProviders)
    .set({ apiKeyEncrypted: other.encrypted })
    .where(eq(modelProviders.id, f.providerA));
  const rejected = await f.app.inject({
    method: 'POST',
    url: f.path + '/input',
    headers: f.headers,
    payload: { text: 'invalid binding', modelConfigId: f.modelA },
  });
  expect(rejected.statusCode).toBe(503);
  expect(rejected.body).not.toContain(other.encrypted);
  expect(rejected.body).not.toContain('private-key');
  expect(calls).toHaveLength(0);
  await f.request('PATCH', '/providers/' + f.providerA, {
    apiKey: 'new-private-key',
  });
  const accepted = await f.app.inject({
    method: 'POST',
    url: f.path + '/input',
    headers: f.headers,
    payload: { text: 'valid binding', modelConfigId: f.modelA },
  });
  expect(accepted.body).toContain('event: completed');
  expect(calls[0].authorization).toBe('Bearer new-private-key');
});

it('does not start a model if persisting its recovery selection fails', async () => {
  const f = await setup();
  const calls = providerMock();
  const update = vi
    .spyOn(f.database.db, 'update')
    .mockImplementationOnce(() => {
      throw new Error('private-write-error');
    });
  const response = await f.app.inject({
    method: 'POST',
    url: `${f.path}/input`,
    headers: f.headers,
    payload: { text: 'not admitted', modelConfigId: f.modelA },
  });
  update.mockRestore();
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain('private-write-error');
  expect(calls).toHaveLength(0);
  expect(
    (await f.app.inject({ url: f.path, headers: f.headers })).json().messages,
  ).toEqual([]);
});
