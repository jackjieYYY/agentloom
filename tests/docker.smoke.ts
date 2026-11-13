import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AIMessage } from '@langchain/core/messages';
import { createApp } from './app.js';
import { parseConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/client.js';
import { jwtFixture } from './auth-helpers.js';
import { callTool, ScriptedModel } from './helpers.js';

// An isolated Compose project and random ports never touch the developer's DB.
const directory = await mkdtemp(join(tmpdir(), 'agentloom-smoke-'));
const project = `agentloom-smoke-${randomBytes(6).toString('hex')}`;
const fixture = jwtFixture();
const env = {
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
  MODEL_CREDENTIALS_KEY: randomBytes(32).toString('hex'),
  ...fixture.env,
};
const run = promisify(execFile);
const compose = async (...args: string[]) => {
  const { stdout } = await run(
    'docker',
    [
      'compose',
      '--project-name',
      project,
      '--env-file',
      join(directory, '.env'),
      '-f',
      resolve('compose.yaml'),
      '-f',
      join(directory, 'ports.yaml'),
      ...args,
    ],
    { env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
};

try {
  await writeFile(
    join(directory, '.env'),
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, 'ports.yaml'),
    "services:\n  postgres:\n    ports: !override ['127.0.0.1::5432']\n  api:\n    ports: !override ['127.0.0.1::3000']\n",
  );
  console.log('Building runtime and initialization images');
  await compose('build', 'api', 'db-init');
  await compose('up', '-d', '--wait', '--wait-timeout', '60', 'postgres');
  await compose('run', '--rm', 'db-init');
  const postgresAddress = await compose('port', 'postgres', '5432');
  const config = parseConfig({
    ...env,
    DATABASE_URL: `postgresql://myagents:${env.POSTGRES_PASSWORD}@${postgresAddress}/myagents`,
  });
  const authorization = `Bearer ${await fixture.sign({ exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const headers = { authorization };
  const app = createApp(
    createDatabase(config.DATABASE_URL),
    config,
    new ScriptedModel([
      new AIMessage('saved smoke result'),
      callTool('echo', { text: 'pending smoke approval' }),
    ]),
  );
  const saved: { id: string; state: unknown }[] = [];
  try {
    const provider = await app.inject({
      method: 'POST',
      url: '/providers',
      headers,
      payload: { name: 'smoke', type: 'openai', apiKey: 'fake-smoke-key' },
    });
    assert.equal(provider.statusCode, 201);
    const model = await app.inject({
      method: 'POST',
      url: '/models',
      headers,
      payload: { providerId: provider.json().providerId, modelName: 'smoke' },
    });
    assert.equal(model.statusCode, 201);
    for (const event of ['completed', 'awaiting_approval']) {
      const created = await app.inject({
        method: 'POST',
        url: '/conversations',
        headers,
      });
      assert.equal(created.statusCode, 201);
      const id: string = created.json().conversationId;
      const response = await app.inject({
        method: 'POST',
        url: `/conversations/${id}/input`,
        headers,
        payload: { text: 'smoke', modelConfigId: model.json().modelConfigId },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes(`event: ${event}\n`));
      const state = await app.inject({ url: `/conversations/${id}`, headers });
      assert.equal(state.statusCode, 200);
      saved.push({ id, state: state.json() });
    }
  } finally {
    await app.close();
  }

  for (let restart = 0; restart < 2; restart++) {
    console.log(
      `Checking container health and saved state (restart ${restart})`,
    );
    await compose('up', '-d', '--wait', '--wait-timeout', '60', 'api');
    const address = await compose('port', 'api', '3000');
    assert.equal((await fetch(`http://${address}/health`)).status, 200);
    assert.notEqual(await compose('exec', '-T', 'api', 'id', '-u'), '0');
    for (const { id, state } of saved) {
      const response = await fetch(`http://${address}/conversations/${id}`, {
        headers,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), state);
    }
    const id = await compose('ps', '-q', 'api');
    const started = Date.now();
    await compose('stop', 'api');
    assert.ok(Date.now() - started < 15000, 'SIGTERM exceeded grace period');
    const { stdout } = await run('docker', [
      'inspect',
      '--format',
      '{{.State.ExitCode}}',
      id,
    ]);
    assert.equal(stdout.trim(), '0');
    // Recreate both containers while preserving the named PostgreSQL volume.
    await compose('down');
  }
  console.log('Docker smoke passed: non-root, health, persistence and SIGTERM');
} catch (error) {
  console.error(await compose('logs', '--no-color').catch(() => ''));
  throw error;
} finally {
  await compose('down', '--volumes', '--remove-orphans');
  await rm(directory, { recursive: true, force: true });
}
