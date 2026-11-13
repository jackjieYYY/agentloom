import 'tsx';
import { createRequire } from 'node:module';

// Test the build with Node's loader so autoload shares the same class identities.
export const { createApp }: typeof import('../src/app.js') =
  await createRequire(import.meta.url)('./app.mjs').app;
