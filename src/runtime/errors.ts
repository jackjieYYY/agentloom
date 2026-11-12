import { constants } from 'node:os';
import { DrizzleQueryError } from 'drizzle-orm';
import pg from 'pg';

export function errorLogFields(error: unknown): { errorCode?: string } {
  const source = error instanceof DrizzleQueryError ? error.cause : error;

  if (!(source instanceof Error)) return {};
  if (!('code' in source)) return {};

  const code = source.code;
  if (typeof code !== 'string') return {};

  if (source instanceof pg.DatabaseError && /^[0-9A-Z]{5}$/.test(code)) {
    return { errorCode: code };
  }

  if (Object.hasOwn(constants.errno, code)) {
    return { errorCode: code };
  }

  return {};
}

export function logError(message: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({ message, ...errorLogFields(error) })}\n`,
  );
}
