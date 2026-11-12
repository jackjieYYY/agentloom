import { randomBytes } from 'node:crypto';
import { SignJWT, type JWTPayload } from 'jose';

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
        tenant_id: 'tenant-a',
        sub: 'user-a',
        ...claims,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .sign(new TextEncoder().encode(env.AUTH_JWT_SECRET)),
  };
}
