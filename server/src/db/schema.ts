import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  integer,
  boolean,
  doublePrecision,
  real,
  uniqueIndex,
  index,
  primaryKey,
  jsonb,
  date,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  totpSecretEncrypted: text('totp_secret_encrypted'),
  mfaDisabled: boolean('mfa_disabled').notNull().default(false),
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

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').unique().notNull(),
  name: text('name').notNull(),
  createdAt: tstz('created_at').defaultNow().notNull(),
  updatedAt: tstz('updated_at').defaultNow().notNull(),
});

export const tenantMembers = pgTable(
  'tenant_members',
  {
    tenantId: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    role: text('role').notNull(),
    createdAt: tstz('created_at').defaultNow().notNull(),
    revokedAt: tstz('revoked_at'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.userId] }),
    userIdx: index('tenant_members_user_id_idx').on(t.userId),
  }),
);

export const workers = pgTable(
  'workers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull().default(''),
    homeAddress: text('home_address').notNull().default(''),
    homeLat: doublePrecision('home_lat'),
    homeLon: doublePrecision('home_lon'),
    workStartTime: text('work_start_time').notNull().default('08:00'),
    workEndTime: text('work_end_time').notNull().default('17:00'),
    daysOff: text('days_off').array().notNull().default([]),
    makeUpDays: text('make_up_days').array().notNull().default([]),
    schedulingStrategy: text('scheduling_strategy').notNull().default('spread'),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    tenantUserUnique: uniqueIndex('workers_tenant_user_unique')
      .on(t.tenantId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    tenantIdx: index('workers_tenant_id_idx').on(t.tenantId),
  }),
);

export const workerBreaks = pgTable('worker_breaks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workerId: uuid('worker_id')
    .references(() => workers.id, { onDelete: 'cascade' })
    .notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  label: text('label').notNull().default(''),
});

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull().default(''),
    address: text('address').notNull().default(''),
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),
    visitDurationMinutes: integer('visit_duration_minutes').notNull().default(60),
    visitsPerPeriod: integer('visits_per_period').notNull().default(1),
    period: text('period').notNull().default('week'),
    priority: text('priority').notNull().default('medium'),
    notes: text('notes').notNull().default(''),
    excludedFromSchedule: boolean('excluded_from_schedule').notNull().default(false),
    createdAt: tstz('created_at').defaultNow().notNull(),
    updatedAt: tstz('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index('clients_tenant_id_idx').on(t.tenantId),
  }),
);

export const clientTimeWindows = pgTable('client_time_windows', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id')
    .references(() => clients.id, { onDelete: 'cascade' })
    .notNull(),
  day: text('day').notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
});

export const travelTimes = pgTable(
  'travel_times',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    locationAId: text('location_a_id').notNull(),
    locationBId: text('location_b_id').notNull(),
    minutes: integer('minutes').notNull(),
    error: text('error'),
  },
  (t) => ({
    uniq: uniqueIndex('travel_times_tenant_locations_unique').on(t.tenantId, t.locationAId, t.locationBId),
    tenantIdx: index('travel_times_tenant_id_idx').on(t.tenantId),
  }),
);

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    weekStartDate: date('week_start_date', { mode: 'string' }).notNull(),
    totalTravelMinutes: integer('total_travel_minutes').notNull().default(0),
    totalTimeAwayMinutes: integer('total_time_away_minutes').notNull().default(0),
    clientGroups: jsonb('client_groups'),
    unmetVisits: jsonb('unmet_visits'),
    recommendedDrops: jsonb('recommended_drops'),
    isCurrent: boolean('is_current').notNull().default(false),
    isSaved: boolean('is_saved').notNull().default(false),
    savedName: text('saved_name'),
    savedAt: tstz('saved_at'),
    createdAt: tstz('created_at').defaultNow().notNull(),
  },
  (t) => ({
    oneCurrent: uniqueIndex('schedules_one_current_per_tenant')
      .on(t.tenantId)
      .where(sql`${t.isCurrent} = true`),
    tenantIdx: index('schedules_tenant_id_idx').on(t.tenantId),
  }),
);

export const scheduleDays = pgTable('schedule_days', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduleId: uuid('schedule_id')
    .references(() => schedules.id, { onDelete: 'cascade' })
    .notNull(),
  day: text('day').notNull(),
  date: date('date', { mode: 'string' }).notNull(),
  totalTravelMinutes: integer('total_travel_minutes').notNull().default(0),
  leaveHomeTime: text('leave_home_time').notNull(),
  arriveHomeTime: text('arrive_home_time').notNull(),
});

export const scheduleVisits = pgTable('schedule_visits', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduleDayId: uuid('schedule_day_id')
    .references(() => scheduleDays.id, { onDelete: 'cascade' })
    .notNull(),
  clientId: uuid('client_id')
    .references(() => clients.id, { onDelete: 'cascade' })
    .notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  travelTimeFromPrev: integer('travel_time_from_prev').notNull().default(0),
  travelDistanceMiFromPrev: doublePrecision('travel_distance_mi_from_prev'),
  manuallyPlaced: boolean('manually_placed').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const tenantDomainChain = pgTable('tenant_domain_chain', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  headSeq: bigint('head_seq', { mode: 'number' }).notNull().default(0),
});

export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    authorUserId: uuid('author_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    clientEventId: text('client_event_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    clientClaimedAt: tstz('client_claimed_at').notNull(),
    serverReceivedAt: tstz('server_received_at').defaultNow().notNull(),
    ipHash: text('ip_hash'),
    gpsLat: doublePrecision('gps_lat'),
    gpsLon: doublePrecision('gps_lon'),
    gpsAccuracyM: real('gps_accuracy_m'),
    gpsCapturedAt: tstz('gps_captured_at'),
    gpsStaleSeconds: integer('gps_stale_seconds'),
    isClinical: boolean('is_clinical').notNull().default(false),
  },
  (t) => ({
    tenantClientUniq: uniqueIndex('domain_events_tenant_client_event_unique').on(t.tenantId, t.clientEventId),
    tenantSeqUniq: uniqueIndex('domain_events_tenant_seq_unique').on(t.tenantId, t.seq),
    tenantSeqIdx: index('domain_events_tenant_seq_idx').on(t.tenantId, t.seq),
  }),
);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  artifactId: text('artifact_id'),
  action: text('action').notNull(),
  ipHash: text('ip_hash'),
  userAgent: text('user_agent'),
  occurredAt: tstz('occurred_at').defaultNow().notNull(),
});
