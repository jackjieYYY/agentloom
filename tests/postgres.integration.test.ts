import 'tsx';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { AIMessage } from '@langchain/core/messages';
import { createDeepAgent } from 'deepagents';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../src/database/client.js';
import { initializeDatabase } from '../src/database/initialize.js';
import { createApp } from './app.js';
import { ScriptedModel } from './helpers.js';
import { parseConfig } from '../src/config/env.js';
import { conversations, modelProviders } from '../src/database/schema.js';
import { eq, sql } from 'drizzle-orm';
import {
  authEnv,
  jwtFixture,
  prepareUsers,
  userA,
  userB,
} from './auth-helpers.js';

// Deliberately separate from DATABASE_URL: never silently target a production DB.
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated real PostgreSQL database',
  );
const config = parseConfig({ DATABASE_URL: url, ...authEnv });
const databases: Database[] = [];
function database() {
  const db = createDatabase(url!);
  databases.push(db);
  return db;
}
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

it('shares one pool and reloads SDK state across pools without reinitializing', async () => {
  await initializeDatabase(url!);
  const first = database();
  expect(first.db.$client).toBe(first.pool);
  await first.db.execute(
    sql`CREATE TABLE unmanaged_initialization_fixture (value text NOT NULL)`,
  );
  await first.db.execute(
    sql`INSERT INTO unmanaged_initialization_fixture VALUES ('preserved')`,
  );
  const config = { configurable: { thread_id: `step2-${randomUUID()}` } };
  const agent = createDeepAgent({
    model: new ScriptedModel([new AIMessage('saved response')]),
    checkpointer: first.saver,
  });
  await agent.invoke(
    { messages: [{ role: 'user', content: 'persist this' }] },
    config,
  );
  const end = vi.spyOn(first.pool, 'end');
  await Promise.all([first.close(), first.close()]);
  expect(end).toHaveBeenCalledTimes(1);
  const second = database();
  expect(
    (
      await second.db.execute(
        sql`SELECT value FROM unmanaged_initialization_fixture`,
      )
    ).rows,
  ).toEqual([{ value: 'preserved' }]);
  await second.db.execute(sql`DROP TABLE unmanaged_initialization_fixture`);
  const model = new ScriptedModel([]);
  const recreated = createDeepAgent({ model, checkpointer: second.saver });
  const state = await recreated.graph.getState(config);
  expect(state.values.messages.at(-1).content).toBe('saved response');
  expect(state.next).toEqual([]);
  expect(model.seen).toHaveLength(0);
  // Saver work used this pool rather than a hidden independent connection pool.
  expect(second.pool.totalCount).toBeGreaterThan(0);
});

it('recreates the whole database and removes business data, checkpoints and unmanaged objects', async () => {
  await initializeDatabase(url!);
  const db = database();
  const id = randomUUID();
  await db.db.insert(modelProviders).values({
    id,
    name: 'Schema safety fixture',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEncrypted: 'test-fixture',
  });
  await db.pool.query(`
    CREATE TYPE unmanaged_enum AS ENUM ('old');
    CREATE SEQUENCE unmanaged_sequence;
    CREATE SCHEMA unmanaged;
    CREATE TABLE unmanaged.fixture (value unmanaged_enum);
  `);
  const config = { configurable: { thread_id: randomUUID() } };
  const agent = createDeepAgent({
    model: new ScriptedModel([new AIMessage('old checkpoint')]),
    checkpointer: db.saver,
  });
  await agent.invoke({ messages: [{ role: 'user', content: 'old' }] }, config);
  await db.close();

  await initializeDatabase(url!);
  const fresh = database();
  expect(await fresh.db.select().from(modelProviders)).toEqual([]);
  expect(await fresh.saver.getTuple(config)).toBeUndefined();
  expect(
    (
      await fresh.pool.query(`
    SELECT to_regtype('unmanaged_enum') AS enum,
           to_regclass('unmanaged_sequence') AS sequence,
           to_regnamespace('unmanaged') AS schema
  `)
    ).rows,
  ).toEqual([{ enum: null, sequence: null, schema: null }]);
});

it('requires an explicit database name before connecting', async () => {
  const target = new URL(url!);
  target.pathname = '/';
  target.searchParams.delete('database');
  await expect(initializeDatabase(target.href)).rejects.toThrow(
    'requires an explicit database name',
  );
});

it('checks database health and reports unavailable PostgreSQL without leaking details', async () => {
  const db = database();
  const app = createApp(db, config);
  try {
    const healthy = await app.inject('/health');
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toEqual({ status: 'ok' });
    await db.close();
    const response = await app.inject('/health');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'Database unavailable',
      requestId: response.headers['x-request-id'],
    });
  } finally {
    await app.close();
  }

  // A genuinely unreachable TCP endpoint, not a mocked pg query.
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address() as { port: number };
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const unavailableUrl = new URL(url!);
  unavailableUrl.hostname = '127.0.0.1';
  unavailableUrl.port = String(address.port);
  const unavailable = createDatabase(unavailableUrl.href);
  databases.push(unavailable);
  const offline = createApp(unavailable, config);
  try {
    expect((await offline.inject('/health')).statusCode).toBe(503);
  } finally {
    await offline.close();
  }
});

it('creates owned conversations and denies other users and guessed IDs', async () => {
  await initializeDatabase(url!);
  const db = database();
  const fixture = jwtFixture();
  await prepareUsers(db);
  const app = createApp(
    db,
    parseConfig({ DATABASE_URL: url, ...fixture.env, NODE_ENV: 'production' }),
  );
  const authorization = `Bearer ${await fixture.sign()}`;
  let conversationId: string | undefined;
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: {
        authorization,
        'x-user-id': 'forged',
      },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const conversation = created.json();
    conversationId = conversation.conversationId;
    expect(conversationId).toMatch(/^[\da-f-]{36}$/);
    expect(Object.keys(conversation).sort()).toEqual([
      'conversationId',
      'createdAt',
    ]);
    expect(Number.isNaN(Date.parse(conversation.createdAt))).toBe(false);
    const [stored] = await db.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId!));
    expect(stored).toMatchObject({ userId: userA });
    const owned = await app.inject({
      url: `/conversations/${conversationId}`,
      headers: { authorization },
    });
    expect(owned.statusCode).toBe(200);
    expect(owned.json()).toMatchObject({
      ...conversation,
      messages: [],
      closedAt: null,
      active: false,
    });

    for (const claims of [{ sub: userB }]) {
      const denied = await app.inject({
        url: `/conversations/${conversationId}?userId=${userA}&thread_id=${conversationId}`,
        headers: {
          authorization: `Bearer ${await fixture.sign(claims)}`,
          'x-user-id': userA,
        },
      });
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual({
        error: 'Not found',
        requestId: denied.headers['x-request-id'],
      });
    }
    expect(
      (
        await app.inject({
          url: `/conversations/${randomUUID()}`,
          headers: { authorization },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject(`/conversations/${conversationId}`)).statusCode,
    ).toBe(401);
  } finally {
    if (conversationId)
      await db.db
        .delete(conversations)
        .where(eq(conversations.id, conversationId));
    await app.close();
  }
});

it('runs compiled ESM, preserves conversations across restarts and exits on SIGTERM within a bound', async () => {
  await initializeDatabase(url!);
  const db = database();
  const fixture = jwtFixture();
  await prepareUsers(db);
  const authorization = `Bearer ${await fixture.sign()}`;
  let conversation: { conversationId: string; createdAt: string } | undefined;
  try {
    for (let restart = 0; restart < 2; restart++) {
      const child = spawn(process.execPath, ['dist/server.js'], {
        env: {
          ...process.env,
          ...fixture.env,
          NODE_ENV: 'production',
          DATABASE_URL: url!,
          HOST: '127.0.0.1',
          PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const exited = once(child, 'exit');
      try {
        const address = await new Promise<string>((resolve, reject) => {
          child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
            const match = output.match(
              /Server listening at (http:\/\/127\.0\.0\.1:\d+)/,
            );
            if (match) resolve(match[1]);
          });
          child.once('exit', () =>
            reject(new Error('Server exited before listening')),
          );
          child.once('error', reject);
        });
        expect((await fetch(`${address}/health`)).status).toBe(200);
        if (!conversation) {
          const created = await fetch(`${address}/conversations`, {
            method: 'POST',
            headers: { authorization },
          });
          expect(created.status).toBe(201);
          conversation = (await created.json()) as {
            conversationId: string;
            createdAt: string;
          };
        }
        const queried = await fetch(
          `${address}/conversations/${conversation.conversationId}`,
          { headers: { authorization } },
        );
        expect(queried.status).toBe(200);
        expect(await queried.json()).toMatchObject({
          ...conversation,
          messages: [],
          closedAt: null,
          active: false,
        });
        const started = Date.now();
        child.kill('SIGTERM');
        const [code, signal] = await exited;
        expect(code).toBe(0);
        expect(signal).toBeNull();
        expect(Date.now() - started).toBeLessThan(3000);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    }
  } finally {
    if (conversation)
      await db.db
        .delete(conversations)
        .where(eq(conversations.id, conversation.conversationId));
  }
}, 15000);
