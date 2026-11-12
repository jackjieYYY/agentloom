import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/client.js';
import { modelConfigs, modelProviders } from '../database/schema.js';
import { AppError } from '../runtime/app-error.js';
import { providerType, providerUrl } from './configuration.js';
import { encryptApiKey } from './credentials.js';

const name = z.string().trim().min(1).max(200);
const apiKey = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .regex(/^[^\r\n]+$/);
const providerFields = z.strictObject({
  name,
  type: providerType,
  baseUrl: providerUrl,
  apiKey,
  enabled: z.boolean(),
});
export const createProviderBody = providerFields
  .partial({ baseUrl: true, enabled: true })
  .refine((value) => value.type === 'openai' || value.baseUrl !== undefined);
export const updateProviderBody = providerFields
  .partial()
  .refine((value) => Object.keys(value).length > 0);
const modelFields = z.strictObject({
  providerId: z.uuid(),
  modelName: name,
  enabled: z.boolean(),
});
export const createModelBody = modelFields.partial({ enabled: true });
export const updateModelBody = modelFields
  .omit({ providerId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0);

export async function listProviders(database: Database) {
  return database.db
    .select({
      id: modelProviders.id,
      name: modelProviders.name,
      type: modelProviders.type,
      baseUrl: modelProviders.baseUrl,
      enabled: modelProviders.enabled,
      createdAt: modelProviders.createdAt,
      updatedAt: modelProviders.updatedAt,
    })
    .from(modelProviders)
    .orderBy(modelProviders.name, modelProviders.id);
}

export async function createProvider(
  database: Database,
  input: z.infer<typeof createProviderBody>,
  key: string | undefined,
) {
  const id = randomUUID();
  const { apiKey: secret, ...fields } = input;
  await database.db.insert(modelProviders).values({
    id,
    ...fields,
    baseUrl: input.baseUrl ?? 'https://api.openai.com/v1',
    apiKeyEncrypted: await encryptApiKey(secret, key, id),
  });
  return { providerId: id };
}

export async function updateProvider(
  database: Database,
  id: string,
  input: z.infer<typeof updateProviderBody>,
  key: string | undefined,
) {
  const { apiKey: nextKey, ...fields } = input;
  const [provider] = await database.db
    .update(modelProviders)
    .set({
      ...fields,
      ...(nextKey !== undefined
        ? { apiKeyEncrypted: await encryptApiKey(nextKey, key, id) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(modelProviders.id, id))
    .returning({ id: modelProviders.id });
  if (!provider) throw new AppError(404, 'Provider not found');
  return { providerId: provider.id };
}

export async function createModel(
  database: Database,
  input: z.infer<typeof createModelBody>,
) {
  const [provider] = await database.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(eq(modelProviders.id, input.providerId));
  if (!provider) throw new AppError(404, 'Provider not found');
  const modelConfigId = randomUUID();
  await database.db
    .insert(modelConfigs)
    .values({ ...input, id: modelConfigId });
  return { modelConfigId };
}

export async function updateModel(
  database: Database,
  id: string,
  input: z.infer<typeof updateModelBody>,
) {
  const [model] = await database.db
    .update(modelConfigs)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(modelConfigs.id, id))
    .returning({ id: modelConfigs.id });
  if (!model) throw new AppError(404, 'Model not found');
  return { modelConfigId: model.id };
}
