import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/client.js';
import { users } from '../database/schema.js';
import { AppError } from '../runtime/app-error.js';
import { hashPassword, verifyPassword } from './password.js';

export const accessTokenLifetime = 7 * 24 * 60 * 60;

export const credentialsBody = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().refine((value) => {
    const length = [...value].length;
    return length >= 15 && length <= 128;
  }),
});

export const publicUserFields = {
  id: users.id,
  email: users.email,
  createdAt: users.createdAt,
};
export type PublicUser = Pick<
  typeof users.$inferSelect,
  'id' | 'email' | 'createdAt'
>;

export async function registerUser(
  database: Database,
  input: z.infer<typeof credentialsBody>,
): Promise<PublicUser> {
  const [user] = await database.db
    .insert(users)
    .values({
      id: randomUUID(),
      email: input.email,
      passwordHash: await hashPassword(input.password),
    })
    .onConflictDoNothing({ target: users.email })
    .returning(publicUserFields);
  if (!user) throw new AppError(409, 'Email already registered');
  return user;
}

export async function loginUser(
  database: Database,
  input: z.infer<typeof credentialsBody>,
): Promise<PublicUser> {
  const [user] = await database.db
    .select({
      ...publicUserFields,
      enabled: users.enabled,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, input.email));
  if (
    !user?.enabled ||
    !(await verifyPassword(input.password, user.passwordHash))
  )
    throw new AppError(401, 'Invalid credentials');
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}
