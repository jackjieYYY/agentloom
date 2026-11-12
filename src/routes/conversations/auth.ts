import { jwtVerify } from 'jose';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import type { AgentContext } from '../../agents/agent.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity: AgentContext;
  }
}

const claimsSchema = z.object({
  tenant_id: z.string().min(1).max(200).regex(/\S/),
  sub: z.string().min(1).max(200).regex(/\S/),
});

export function createAuthenticator(
  config: Config,
): (authorization: string | undefined) => Promise<AgentContext> {
  const key = new TextEncoder().encode(config.AUTH_JWT_SECRET);

  return async (authorization: string | undefined): Promise<AgentContext> => {
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) throw new Error('Missing bearer token');
    const { payload } = await jwtVerify(match[1], key, {
      algorithms: ['HS256'],
      requiredClaims: ['exp', 'sub', 'tenant_id'],
    });
    const claims = claimsSchema.parse(payload);
    return { tenantId: claims.tenant_id, userId: claims.sub };
  };
}
