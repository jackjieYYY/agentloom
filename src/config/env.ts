import { z } from 'zod';

const databaseSchema = z.object({
  DATABASE_URL: z.url().refine((value) => /^postgres(ql)?:/.test(value)),
});

const environmentSchema = databaseSchema.extend({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z
    .string()
    .trim()
    .min(1)
    .pipe(z.coerce.number<string>().int().min(0).max(65535))
    .default(3000),
  MODEL_CREDENTIALS_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  AGENT_MODEL_CALL_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  AGENT_TOOL_CALL_LIMIT: z.coerce.number().int().min(1).max(100).default(20),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(1).max(3600000).default(120000),
  AUTH_JWT_SECRET: z.string().min(32).regex(/\S/),
});

export type Config = z.infer<typeof environmentSchema>;

export class ConfigurationError extends Error {}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  return parseEnvironment(environmentSchema, env);
}

export function parseDatabaseConfig(env: NodeJS.ProcessEnv) {
  return parseEnvironment(databaseSchema, env);
}

function parseEnvironment<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  // Never include Zod issue values: they may contain credentials.
  const fields = new Set(
    result.error.issues.map((issue) => issue.path.join('.')),
  );
  throw new ConfigurationError(
    `Invalid configuration: ${[...fields].join(', ')}`,
  );
}
