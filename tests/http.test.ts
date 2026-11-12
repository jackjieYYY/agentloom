import 'tsx';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createShutdown } from '../src/runtime/shutdown.js';
import { parseConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/client.js';
import { authEnv, jwtFixture } from './auth-helpers.js';
import { SignJWT } from 'jose';

const config = parseConfig({
  ...authEnv,
  DATABASE_URL: 'postgresql://unused:secret@127.0.0.1/db',
});
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(appConfig = config) {
  const database = createDatabase(appConfig.DATABASE_URL);
  const app = createApp(database, appConfig);
  apps.push(app);
  return { app, database };
}

describe('conversation authentication', () => {
  it('rejects missing, forged, expired and invalid identity tokens before touching the DB', async () => {
    const fixture = jwtFixture();
    const forged = jwtFixture();
    const { app, database } = setup(
      parseConfig({ DATABASE_URL: config.DATABASE_URL, ...fixture.env }),
    );
    const query = vi.spyOn(database.pool, 'query');
    const valid = await fixture.sign();
    const unsigned = `${valid.split('.').slice(0, 2).join('.')}.`;
    const wrongAlgorithm = await new SignJWT({
      tenant_id: 'tenant-a',
      sub: 'user-a',
      exp: Math.floor(Date.now() / 1000) + 300,
    })
      .setProtectedHeader({ alg: 'HS384' })
      .sign(new TextEncoder().encode(fixture.env.AUTH_JWT_SECRET));
    const invalidTokens = await Promise.all([
      forged.sign(),
      fixture.sign({ exp: 1 }),
      fixture.sign({ exp: undefined }),
      fixture.sign({ tenant_id: undefined }),
      fixture.sign({ tenant_id: '   ' }),
      fixture.sign({ tenant_id: 123 }),
      fixture.sign({ sub: undefined }),
      fixture.sign({ sub: '' }),
      fixture.sign({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
    ]);
    for (const authorization of [
      undefined,
      'Basic private-secret',
      'Bearer malformed',
      `Bearer ${unsigned}`,
      `Bearer ${wrongAlgorithm}`,
      ...invalidTokens.map((token) => `Bearer ${token}`),
    ]) {
      for (const method of ['POST', 'GET'] as const) {
        const response = await app.inject({
          method,
          url:
            method === 'POST'
              ? '/conversations'
              : '/conversations/00000000-0000-4000-8000-000000000000',
          headers: {
            ...(authorization ? { authorization } : {}),
            'x-tenant-id': 'tenant-a',
            'x-user-id': 'user-a',
          },
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers['www-authenticate']).toBe('Bearer');
        expect(response.json()).toEqual({
          error: 'Invalid request',
          requestId: response.headers['x-request-id'],
        });
        expect(response.body).not.toContain('private-secret');
      }
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects invalid request IDs and client-supplied identity or thread IDs', async () => {
    const { app, database } = setup();
    const fixture = jwtFixture(authEnv);
    const headers = { authorization: `Bearer ${await fixture.sign()}` };
    const query = vi.spyOn(database.pool, 'query');
    for (const payload of [
      { tenantId: 'forged', userId: 'forged' },
      { conversationId: 'forged' },
      { thread_id: 'forged' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/conversations',
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Invalid request',
        requestId: response.headers['x-request-id'],
      });
    }
    const response = await app.inject({
      url: '/conversations/not-a-uuid',
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid request',
      requestId: response.headers['x-request-id'],
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('HTTP foundation', () => {
  it('autoloads route directories with shared options and isolated authentication', async () => {
    const { app, database } = setup();
    const query = vi
      .spyOn(database.pool, 'query')
      .mockImplementationOnce(async () => undefined);

    expect((await app.inject('/health/ready')).statusCode).toBe(200);
    expect(query).toHaveBeenCalledExactlyOnceWith('SELECT 1');
    expect(
      (await app.inject({ method: 'POST', url: '/conversations' })).statusCode,
    ).toBe(401);
    expect((await app.inject('/health/live')).json()).toEqual({ status: 'ok' });
    expect((await app.inject('/live')).statusCode).toBe(404);
  });

  it('rejects invalid config without leaking supplied secrets', () => {
    for (const env of [
      { DATABASE_URL: 'secret' },
      { DATABASE_URL: config.DATABASE_URL, PORT: '-1' },
      { DATABASE_URL: config.DATABASE_URL, LANGSMITH_TRACING: 'true' },
    ]) {
      expect(() => parseConfig(env)).toThrow('Invalid configuration:');
      try {
        parseConfig(env);
      } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    }
  });

  it('serves liveness and server-owned IDs without handling CORS', async () => {
    const { app } = setup();
    const allowed = await app.inject({
      url: '/health/live',
      headers: {
        origin: 'https://allowed.example',
        'x-request-id': 'untrusted',
      },
    });
    expect(allowed.json()).toEqual({ status: 'ok' });
    expect(allowed.headers['x-request-id']).not.toBe('untrusted');
    expect(allowed.headers['access-control-allow-origin']).toBeUndefined();
    const denied = await app.inject({
      url: '/health/live',
      headers: { origin: 'https://denied.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('normalizes routing errors without exposing raw URLs', async () => {
    const { app } = setup();
    const response = await app.inject({
      url: '/private-secret%ZZ',
      headers: { 'x-request-id': 'untrusted' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-request-id']).not.toBe('untrusted');
    expect(response.json()).toEqual({
      error: 'Invalid request',
      requestId: response.headers['x-request-id'],
    });
    expect(response.body).not.toContain('private-secret');
  });

  it('leaves preflight handling to Nginx', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/health/live',
      headers: {
        origin: 'https://allowed.example',
        'access-control-request-method': 'GET',
        'x-request-id': 'untrusted',
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-request-id']).not.toBe('untrusted');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    for (const headers of [
      { origin: 'https://allowed.example' },
      { 'access-control-request-method': 'GET' },
      {},
    ]) {
      const invalid = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers,
      });
      expect(invalid.statusCode).toBe(404);
      expect(invalid.headers['content-type']).toContain('application/json');
      expect(invalid.headers['x-request-id']).toEqual(expect.any(String));
      expect(invalid.json()).toEqual({
        error: 'Not found',
        requestId: invalid.headers['x-request-id'],
      });
    }
  });

  it('normalizes 404, malformed JSON, oversized bodies and unexpected errors', async () => {
    const { app } = setup();
    app.post('/test', async () => {
      throw new Error('secret');
    });
    for (const [payload, status] of [
      ['{', 400],
      ['x'.repeat(1048577), 413],
      ['{}', 500],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().requestId).toBe(response.headers['x-request-id']);
      expect(response.body).not.toContain('secret');
    }
    expect((await app.inject('/missing')).statusCode).toBe(404);
  });

  it('drains requests and closes the shared pool only once', async () => {
    const { app, database } = setup();
    const end = vi.spyOn(database.pool, 'end');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.get('/blocked', async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'done';
    });
    const request = app.inject('/blocked');
    await started;
    const force = vi.fn();
    const shutdown = createShutdown(app, 1000, force);
    const closing = shutdown();
    expect(shutdown()).toBe(closing);
    expect(end).not.toHaveBeenCalled();
    release();
    await request;
    await closing;
    expect(end).toHaveBeenCalledTimes(1);
    await database.close();
    expect(end).toHaveBeenCalledTimes(1);
    expect(force).not.toHaveBeenCalled();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'shuts down the server entry point gracefully on %s',
    async (signal) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/server.ts'],
        {
          env: {
            ...process.env,
            ...authEnv,
            DATABASE_URL: config.DATABASE_URL,
            HOST: '127.0.0.1',
            PORT: '0',
            LANGSMITH_TRACING: 'false',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const exited = once(child, 'exit');
      try {
        const address = await new Promise<string>((resolve, reject) => {
          let output = '';
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
        expect((await fetch(`${address}/health/live`)).status).toBe(200);
        child.kill(signal);
        expect(await exited).toEqual([0, null]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    },
    10000,
  );

  it('invokes the hard deadline for a stuck request', async () => {
    const { app } = setup();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.get('/stuck', async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'done';
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const request = fetch(`${address}/stuck`).catch(() => undefined);
    await started;
    let forced!: () => void;
    const deadline = new Promise<void>((resolve) => {
      forced = resolve;
    });
    const closing = createShutdown(app, 100, forced)();
    await deadline;
    release();
    await request;
    await closing;
  });
});
