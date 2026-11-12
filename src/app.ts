import { randomUUID } from 'node:crypto';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createExecution } from './runtime/execution.js';
import { fileURLToPath } from 'node:url';
import autoload from '@fastify/autoload';
import Fastify from 'fastify';
import type { Config } from './config/env.js';
import type { Database } from './database/client.js';
import { handleError } from './plugins/errors/handler.js';

export function createApp(
  database: Database,
  config: Config,
  model?: BaseChatModel,
) {
  const execution = createExecution(database, config, model);
  const app = Fastify({
    logger: {
      level: 'info',
      serializers: {
        req: (request) => ({ method: request.method }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    forceCloseConnections: 'idle',
    // Routing errors bypass both onRequest and the normal error handler.
    frameworkErrors: handleError,
  });

  app.addHook('preClose', () => execution.stop());
  app.register(autoload, {
    dir: fileURLToPath(new URL('./plugins', import.meta.url)),
    options: { database, config },
  });
  app.register(autoload, {
    dir: fileURLToPath(new URL('./routes', import.meta.url)),
    options: { database, config, execution },
  });
  return app;
}
