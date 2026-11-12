import { ChatOpenAI, ChatOpenAICompletions } from '@langchain/openai';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import type { Database } from '../database/client.js';
import { modelConfigs, modelProviders } from '../database/schema.js';
import { AppError } from '../runtime/app-error.js';
import { decryptApiKey } from './credentials.js';

export const providerType = z.enum(['openai', 'openai-compatible']);
export const providerUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });

export async function availableModel(database: Database, id: string) {
  const [row] = await database.db
    .select({
      id: modelConfigs.id,
      modelName: modelConfigs.modelName,
      providerId: modelProviders.id,
      providerName: modelProviders.name,
      type: modelProviders.type,
      baseUrl: modelProviders.baseUrl,
      apiKeyEncrypted: modelProviders.apiKeyEncrypted,
    })
    .from(modelConfigs)
    .innerJoin(modelProviders, eq(modelConfigs.providerId, modelProviders.id))
    .where(
      and(
        eq(modelConfigs.enabled, true),
        eq(modelProviders.enabled, true),
        eq(modelConfigs.id, id),
      ),
    );
  if (!row) throw new AppError(404, 'Model not found');
  return row;
}

export async function listModels(database: Database) {
  return database.db
    .select({
      id: modelConfigs.id,
      modelName: modelConfigs.modelName,
      providerId: modelProviders.id,
      providerName: modelProviders.name,
      enabled: modelConfigs.enabled,
      providerEnabled: modelProviders.enabled,
    })
    .from(modelConfigs)
    .innerJoin(modelProviders, eq(modelConfigs.providerId, modelProviders.id))
    .orderBy(modelConfigs.modelName, modelConfigs.id);
}

export async function configuredModel(
  row: Awaited<ReturnType<typeof availableModel>>,
  config: Config,
) {
  const apiKey = await decryptApiKey(
    row.apiKeyEncrypted,
    config.MODEL_CREDENTIALS_KEY,
    row.providerId,
  );
  // Compatible endpoints must stay on Chat Completions regardless of model name.
  const options = {
    apiKey,
    model: row.modelName,
    maxRetries: 0,
    configuration: { baseURL: row.baseUrl, maxRetries: 0 },
  };
  return row.type === 'openai-compatible'
    ? new ChatOpenAICompletions(options)
    : new ChatOpenAI(options);
}
