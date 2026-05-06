import { pgTable, uuid, text, bigint, timestamp, integer, boolean } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  pdkSalt: text('pdk_salt').notNull(),
  totpSecretEncrypted: text('totp_secret_encrypted'),
  mfaDisabled: boolean('mfa_disabled').notNull().default(false),
  recoveryKeyHash: text('recovery_key_hash').notNull(),
  masterPublicKey: text('master_public_key'),
  createdAt: tstz('created_at').defaultNow().notNull(),
  updatedAt: tstz('updated_at').defaultNow().notNull(),
});

export const userSessions = pgTable('user_sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  expiresAt: tstz('expires_at').notNull(),
  // Sliding idle deadline; refreshed on every authenticated request.
  idleExpiresAt: tstz('idle_expires_at').notNull(),
  createdAt: tstz('created_at').defaultNow().notNull(),
});

// ciphertext/iv start empty and are filled on first workspace push.
// wrappedWorkspaceKey and wrappedWorkspaceKeyRecovery encode iv+ciphertext
// as base64(iv || aes-gcm-ciphertext), created at registration.
export const workspaceBlobs = pgTable('workspace_blobs', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull().default(''),
  iv: text('iv').notNull().default(''),
  wrappedWorkspaceKey: text('wrapped_workspace_key').notNull(),
  wrappedWorkspaceKeyRecovery: text('wrapped_workspace_key_recovery').notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  updatedAt: tstz('updated_at').defaultNow().notNull(),
});

export const shareArtifacts = pgTable('share_artifacts', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  revokedAt: tstz('revoked_at'),
  fetchCount: integer('fetch_count').notNull().default(0),
  lastFetchedAt: tstz('last_fetched_at'),
  createdAt: tstz('created_at').defaultNow().notNull(),
});

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  artifactId: text('artifact_id'),
  action: text('action').notNull(),
  ipHash: text('ip_hash'),
  userAgent: text('user_agent'),
  occurredAt: tstz('occurred_at').defaultNow().notNull(),
});
