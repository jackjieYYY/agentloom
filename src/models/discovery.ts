import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/client.js';
import { modelProviders } from '../database/schema.js';
import { AppError } from '../runtime/app-error.js';
import { decryptApiKey } from './credentials.js';

const modelList = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

export async function discoverModels(
  database: Database,
  id: string,
  key: string | undefined,
) {
  const [provider] = await database.db
    .select({
      baseUrl: modelProviders.baseUrl,
      apiKeyEncrypted: modelProviders.apiKeyEncrypted,
    })
    .from(modelProviders)
    .where(eq(modelProviders.id, id));
  if (!provider) throw new AppError(404, 'Provider not found');
  const apiKey = await decryptApiKey(provider.apiKeyEncrypted, key, id);
  const signal = AbortSignal.timeout(10_000);
  try {
    const response = await fetch(
      `${provider.baseUrl.replace(/\/+$/, '')}/models`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const { data } = modelList.parse(await response.json());
    return { models: data.map(({ id: modelName }) => ({ modelName })) };
  } catch {
    if (signal.aborted)
      throw new AppError(504, 'Upstream model discovery timed out');
    throw new AppError(502, 'Upstream model discovery failed');
  }
}
