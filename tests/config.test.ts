import { expect, it } from 'vitest';
import {
  ConfigurationError,
  parseConfig,
  parseDatabaseConfig,
} from '../src/config/env.js';

import { authEnv } from './auth-helpers.js';

const DATABASE_URL = 'postgresql://localhost/db';
const baseEnv = { DATABASE_URL, ...authEnv };

it('rejects blank ports while preserving the default and explicit zero', () => {
  for (const PORT of ['', ' ', '\t']) {
    expect(() => parseConfig({ ...baseEnv, PORT })).toThrow(ConfigurationError);
  }
  expect(parseConfig(baseEnv).PORT).toBe(3000);
  expect(parseConfig({ ...baseEnv, PORT: '0' }).PORT).toBe(0);
  expect(parseConfig({ ...baseEnv, PORT: '3001' }).PORT).toBe(3001);
});

it('ignores removed environment settings', () => {
  const config = parseConfig({
    ...baseEnv,
    CORS_ORIGINS: '*',
    LOG_LEVEL: 'invalid',
    BODY_LIMIT: 'invalid',
    SHUTDOWN_TIMEOUT_MS: 'invalid',
  });
  expect(config).not.toHaveProperty('CORS_ORIGINS');
  expect(config).not.toHaveProperty('LOG_LEVEL');
  expect(config).not.toHaveProperty('BODY_LIMIT');
  expect(config).not.toHaveProperty('SHUTDOWN_TIMEOUT_MS');
});

it('requires a JWT secret of at least 32 characters in every environment', () => {
  expect(parseConfig({ ...baseEnv, NODE_ENV: 'production' })).toMatchObject(
    authEnv,
  );
  for (const AUTH_JWT_SECRET of [undefined, '', 'short', ' '.repeat(32)]) {
    expect(() => parseConfig({ ...baseEnv, AUTH_JWT_SECRET })).toThrow(
      'Invalid configuration: AUTH_JWT_SECRET',
    );
  }
});

it('validates only database settings for migrations', () => {
  expect(parseDatabaseConfig({ DATABASE_URL, PORT: 'invalid' })).toEqual({
    DATABASE_URL,
  });
  for (const value of [undefined, 'private-secret', 'https://example.com']) {
    expect(() => parseDatabaseConfig({ DATABASE_URL: value })).toThrow(
      ConfigurationError,
    );
  }
});
