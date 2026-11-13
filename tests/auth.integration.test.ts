import 'tsx';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';
import { afterEach, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/client.js';
import { initializeDatabase } from '../src/database/initialize.js';
import { users } from '../src/database/schema.js';
import { createApp } from './app.js';
import { jwtFixture, prepareUsers, userA } from './auth-helpers.js';

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated real PostgreSQL database',
  );
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  await initializeDatabase(url!);
  const database = createDatabase(url!);
  const fixture = jwtFixture();
  const config = parseConfig({ DATABASE_URL: url, ...fixture.env });
  const app = createApp(database, config);
  apps.push(app);
  return { app, database, fixture };
}

const credentials = {
  email: '  Alice.Test+account@Example.COM  ',
  password: '  a long account passphrase  ',
};

it('registers an enabled account, signs a seven-day JWT and returns public user data', async () => {
  const { app, database, fixture } = await setup();
  const registered = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: credentials,
  });
  expect(registered.statusCode).toBe(201);
  expect(registered.headers['cache-control']).toBe('no-store');
  expect(registered.headers['set-cookie']).toBeUndefined();
  const { user } = registered.json();
  expect(Object.keys(user).sort()).toEqual(['createdAt', 'email', 'id']);
  expect(user.email).toBe('alice.test+account@example.com');
  expect(Number.isNaN(Date.parse(user.createdAt))).toBe(false);
  expect(Object.keys(registered.json())).toEqual(['user']);
  const [stored] = await database.db.select().from(users);
  expect(stored).toMatchObject({
    id: user.id,
    email: user.email,
    enabled: true,
  });
  expect(stored.passwordHash).toMatch(/^scrypt\$/);
  expect(stored.passwordHash).not.toContain(credentials.password);

  const loggedIn = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { ...credentials, email: 'ALICE.TEST+ACCOUNT@example.com' },
  });
  expect(loggedIn.statusCode).toBe(200);
  expect(loggedIn.headers['cache-control']).toBe('no-store');
  const login = loggedIn.json();
  expect(Object.keys(login).sort()).toEqual([
    'accessToken',
    'expiresIn',
    'tokenType',
    'user',
  ]);
  expect(login).toMatchObject({ user, tokenType: 'Bearer', expiresIn: 604800 });
  expect(decodeProtectedHeader(login.accessToken).alg).toBe('HS256');
  const { payload } = await jwtVerify(
    login.accessToken,
    new TextEncoder().encode(fixture.env.AUTH_JWT_SECRET),
    { algorithms: ['HS256'] },
  );
  expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
  expect(payload.sub).toBe(user.id);
  expect(payload.exp! - payload.iat!).toBe(604800);
  const headers = { authorization: `Bearer ${login.accessToken}` };
  const me = await app.inject({ url: '/auth/me', headers });
  expect(me.statusCode).toBe(200);
  expect(me.json()).toEqual({ user });
  expect(me.headers['cache-control']).toBe('no-store');
  expect(
    (await app.inject({ method: 'POST', url: '/conversations', headers }))
      .statusCode,
  ).toBe(201);
});

it('enforces normalized email uniqueness during concurrent registration', async () => {
  const { app, database } = await setup();
  const responses = await Promise.all(
    [
      credentials,
      { ...credentials, email: 'alice.test+account@example.com' },
    ].map((payload) =>
      app.inject({ method: 'POST', url: '/auth/register', payload }),
    ),
  );
  expect(responses.map((response) => response.statusCode).sort()).toEqual([
    201, 409,
  ]);
  const conflict = responses.find((response) => response.statusCode === 409)!;
  expect(conflict.json()).toEqual({
    error: 'Email already registered',
    requestId: conflict.headers['x-request-id'],
  });
  expect(conflict.headers['cache-control']).toBe('no-store');
  expect(await database.db.select({ id: users.id }).from(users)).toHaveLength(
    1,
  );
});

it('returns identical credential errors for a wrong password, missing user and disabled user', async () => {
  const { app, database } = await setup();
  await prepareUsers(database);
  for (const payload of [
    { email: `${userA}@example.com`, password: 'a wrong account password' },
    { email: 'missing@example.com', password: 'test account password' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'Invalid credentials',
      requestId: response.headers['x-request-id'],
    });
  }
  await database.db
    .update(users)
    .set({ enabled: false })
    .where(eq(users.id, userA));
  const disabled = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      email: `${userA}@example.com`,
      password: 'test account password',
    },
  });
  expect(disabled.statusCode).toBe(401);
  expect(disabled.json().error).toBe('Invalid credentials');
});

it('validates account fields strictly and accepts password character boundaries', async () => {
  const { app } = await setup();
  const invalid = [
    {},
    { ...credentials, email: 'invalid' },
    {
      ...credentials,
      email: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`,
    },
    { ...credentials, password: 'a'.repeat(14) },
    { ...credentials, password: '😀'.repeat(14) },
    { ...credentials, password: 'a'.repeat(129) },
    ...['id', 'userId', 'enabled', 'role', 'permissions'].map((field) => ({
      ...credentials,
      [field]: 'forged',
    })),
  ];
  for (const endpoint of ['register', 'login']) {
    for (const payload of invalid) {
      const response = await app.inject({
        method: 'POST',
        url: `/auth/${endpoint}`,
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toEqual({
        error: 'Invalid request',
        requestId: response.headers['x-request-id'],
      });
      expect(response.body).not.toContain(credentials.password);
    }
  }
  for (const [index, password] of [
    ' '.repeat(15),
    '😀'.repeat(128),
  ].entries()) {
    const payload = { email: `boundary-${index}@example.com`, password };
    expect(
      (await app.inject({ method: 'POST', url: '/auth/register', payload }))
        .statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: 'POST', url: '/auth/login', payload }))
        .statusCode,
    ).toBe(200);
  }
});

it('rejects invalid credentials before protected business handlers and rechecks current account state', async () => {
  const { app, database, fixture } = await setup();
  await prepareUsers(database);
  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(fixture.env.AUTH_JWT_SECRET);
  const tokens = [
    undefined,
    'invalid',
    await jwtFixture().sign(),
    await fixture.sign({ exp: now - 1 }),
    await fixture.sign({ exp: undefined }),
    await fixture.sign({ sub: undefined }),
    await fixture.sign({ sub: 'not-a-uuid' }),
    await fixture.sign({ sub: randomUUID() }),
    await fixture.sign({ nbf: now + 3600 }),
    await new SignJWT({ sub: userA, exp: now + 300 })
      .setProtectedHeader({ alg: 'HS384' })
      .sign(key),
  ];
  for (const token of tokens) {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    for (const request of [
      { method: 'GET' as const, url: '/auth/me' },
      { method: 'GET' as const, url: '/models' },
      {
        method: 'POST' as const,
        url: `/conversations/${randomUUID()}/input`,
        payload: { text: 'private', modelConfigId: randomUUID() },
      },
    ]) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.headers['content-type']).not.toContain(
        'text/event-stream',
      );
      expect(response.json()).toEqual({
        error: 'Invalid request',
        requestId: response.headers['x-request-id'],
      });
    }
  }
  const headers = { authorization: `Bearer ${await fixture.sign()}` };
  expect((await app.inject({ url: '/auth/me', headers })).statusCode).toBe(200);
  await database.db
    .update(users)
    .set({ enabled: false })
    .where(eq(users.id, userA));
  expect((await app.inject({ url: '/auth/me', headers })).statusCode).toBe(401);
  expect(
    (await app.inject({ method: 'POST', url: '/conversations', headers }))
      .statusCode,
  ).toBe(401);
  await database.db
    .update(users)
    .set({ enabled: true })
    .where(eq(users.id, userA));
  expect((await app.inject({ url: '/auth/me', headers })).statusCode).toBe(200);
  await database.db.delete(users).where(eq(users.id, userA));
  expect((await app.inject({ url: '/auth/me', headers })).statusCode).toBe(401);
  expect((await app.inject('/health')).statusCode).toBe(200);
});

it('keeps database failures on the sanitized server-error path', async () => {
  const { app, database, fixture } = await setup();
  await app.ready();
  await database.close();
  const headers = { authorization: `Bearer ${await fixture.sign()}` };
  for (const request of [
    { method: 'GET' as const, url: '/auth/me', headers },
    { method: 'POST' as const, url: '/auth/login', payload: credentials },
    { method: 'POST' as const, url: '/auth/register', payload: credentials },
  ]) {
    const response = await app.inject(request);
    expect(response.statusCode).toBe(500);
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(response.json()).toEqual({
      error: 'Internal server error',
      requestId: response.headers['x-request-id'],
    });
  }
});
