import { pgTable, uuid, text, bigint, timestamp, integer, boolean, doublePrecision, real, uniqueIndex, index } from 'drizzle-orm/pg-core';

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
  idleExpiresAt: tstz('idle_expires_at').notNull(),
  createdAt: tstz('created_at').defaultNow().notNull(),
});

export const workspaceSnapshots = pgTable('workspace_snapshots', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull().default(''),
  iv: text('iv').notNull().default(''),
  wrappedWorkspaceKey: text('wrapped_workspace_key').notNull(),
  wrappedWorkspaceKeyRecovery: text('wrapped_workspace_key_recovery').notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  /** Last event sequence included in this ciphertext (replay events with seq > this). */
  snapshotSeq: bigint('snapshot_seq', { mode: 'number' }).notNull().default(0),
  updatedAt: tstz('updated_at').defaultNow().notNull(),
});

export const dataEvents = pgTable(
  'data_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    clientEventId: text('client_event_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    clientClaimedAt: tstz('client_claimed_at').notNull(),
    serverReceivedAt: tstz('server_received_at').defaultNow().notNull(),
    ipHash: text('ip_hash'),
    gpsLat: doublePrecision('gps_lat'),
    gpsLon: doublePrecision('gps_lon'),
    gpsAccuracyM: real('gps_accuracy_m'),
    gpsCapturedAt: tstz('gps_captured_at'),
    gpsStaleSeconds: integer('gps_stale_seconds'),
    isClinical: boolean('is_clinical').notNull(),
  },
  (t) => ({
    userClientUniq: uniqueIndex('data_events_user_client_event_id_unique').on(t.userId, t.clientEventId),
    userSeqIdx: index('data_events_user_id_seq_idx').on(t.userId, t.seq),
  }),
);

export const userEventChain = pgTable('user_event_chain', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  headSeq: bigint('head_seq', { mode: 'number' }).notNull().default(0),
  headHash: text('head_hash').notNull().default(''),
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
