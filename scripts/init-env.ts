import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { parseEnv } from 'node:util';

// Exclusive temporary file prevents concurrent runs from generating different credentials.
const pending = await open('.env.init', 'wx', 0o600);
try {
  let content: string;
  try {
    content = await readFile('.env', 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    content = await readFile('.env.example', 'utf8');
  }
  const env = parseEnv(content);
  const credentials: Record<string, string> = {};
  if (!env.DATABASE_URL) {
    if (env.POSTGRES_PASSWORD) {
      throw new Error(
        'Set DATABASE_URL to match the existing POSTGRES_PASSWORD.',
      );
    }
    const password = randomBytes(32).toString('hex');
    credentials.POSTGRES_PASSWORD = password;
    credentials.DATABASE_URL = `postgresql://myagents:${password}@127.0.0.1:5432/myagents`;
  }
  if (!env.AUTH_JWT_SECRET) {
    credentials.AUTH_JWT_SECRET = randomBytes(32).toString('hex');
  }
  if (!env.MODEL_CREDENTIALS_KEY) {
    credentials.MODEL_CREDENTIALS_KEY = randomBytes(32).toString('hex');
  }
  if (Object.keys(credentials).length > 0) {
    for (const [key, value] of Object.entries(credentials)) {
      const line = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm');
      content = line.test(content)
        ? content.replace(line, `${key}=${value}`)
        : `${content.trimEnd()}\n${key}=${value}\n`;
    }
    await pending.writeFile(content);
    await pending.close();
    await rename('.env.init', '.env');
    console.log('Credentials saved to .env (mode 0600).');
  } else {
    console.log('Existing credentials preserved; no changes.');
  }
} finally {
  await pending.close();
  await unlink('.env.init').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
