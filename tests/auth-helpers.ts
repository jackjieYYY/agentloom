import { randomBytes } from 'node:crypto';
import { SignJWT, type JWTPayload } from 'jose';
import type { Database } from '../src/database/client.js';
import { users } from '../src/database/schema.js';
import { hashPassword } from '../src/users/password.js';

export const userA = 'c13bb49d-98eb-4927-8ad6-b0d158b18762';
export const userB = 'c13bb49d-98eb-4927-8ad6-b0d158b18763';
let fixturePassword: Promise<string> | undefined;

export async function prepareUsers(database: Database, ids = [userA, userB]) {
  const passwordHash = await (fixturePassword ??= hashPassword(
    'test account password',
  ));
  await database.db
    .insert(users)
    .values(
      ids.map((id) => ({ id, email: `${id}@example.com`, passwordHash })),
    );
}

export const authEnv = {
  AUTH_JWT_SECRET: randomBytes(32).toString('hex'),
};

export function jwtFixture(
  env = { AUTH_JWT_SECRET: randomBytes(32).toString('hex') },
) {
  return {
    env,
    sign: (claims: JWTPayload = {}) =>
      new SignJWT({
        exp: Math.floor(Date.now() / 1000) + 300,
        sub: userA,
        ...claims,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .sign(new TextEncoder().encode(env.AUTH_JWT_SECRET)),
  };
}
