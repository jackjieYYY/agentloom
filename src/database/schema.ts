import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);

export const modelProviders = pgTable('model_providers', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['openai', 'openai-compatible'] }).notNull(),
  baseUrl: text('base_url').notNull(),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const modelConfigs = pgTable('model_configs', {
  id: uuid('id').primaryKey(),
  providerId: uuid('provider_id').notNull(),
  modelName: text('model_name').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ApprovalDecision = { type: 'approve' | 'reject' };

export const approvalAudits = pgTable(
  'approval_audits',
  {
    conversationId: uuid('conversation_id').notNull(),
    interruptId: text('interrupt_id').notNull(),
    decisions: jsonb('decisions').$type<ApprovalDecision[]>().notNull(),
    userId: text('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.interruptId] }),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull(),
    lastExecutionModelConfigId: uuid('last_execution_model_config_id'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('conversations_owner_created_id_idx').on(
      table.userId,
      table.createdAt,
      table.id,
    ),
  ],
);
