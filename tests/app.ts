import 'tsx';
import { createRequire } from 'node:module';

// Use Node's loader for both the app and autoload so instanceof sees one class.
export const { createApp }: typeof import('../src/app.js') =
  await createRequire(import.meta.url)('./app.mjs').app;
