-- Tenants + normalized domain tables (additive; legacy workspace tables remain until 0007)

CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tenant_members" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "tenant_members_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "tenant_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "tenant_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "tenant_members_role_check" CHECK ("role" IN ('admin', 'caregiver'))
);

CREATE INDEX IF NOT EXISTS "tenant_members_user_id_idx" ON "tenant_members" ("user_id");

CREATE TABLE IF NOT EXISTS "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text DEFAULT '' NOT NULL,
	"home_address" text DEFAULT '' NOT NULL,
	"home_lat" double precision,
	"home_lon" double precision,
	"work_start_time" text DEFAULT '08:00' NOT NULL,
	"work_end_time" text DEFAULT '17:00' NOT NULL,
	"days_off" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"make_up_days" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"scheduling_strategy" text DEFAULT 'spread' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "workers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "workers_tenant_user_unique" ON "workers" ("tenant_id","user_id") WHERE "user_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "worker_breaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	CONSTRAINT "worker_breaks_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"lat" double precision,
	"lon" double precision,
	"visit_duration_minutes" integer DEFAULT 60 NOT NULL,
	"visits_per_period" integer DEFAULT 1 NOT NULL,
	"period" text DEFAULT 'week' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"excluded_from_schedule" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "clients_tenant_id_idx" ON "clients" ("tenant_id");

CREATE TABLE IF NOT EXISTS "client_time_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"day" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	CONSTRAINT "client_time_windows_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "travel_times" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_a_id" text NOT NULL,
	"location_b_id" text NOT NULL,
	"minutes" integer NOT NULL,
	"error" text,
	CONSTRAINT "travel_times_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "travel_times_tenant_locations_unique" UNIQUE("tenant_id","location_a_id","location_b_id")
);

CREATE INDEX IF NOT EXISTS "travel_times_tenant_id_idx" ON "travel_times" ("tenant_id");

CREATE TABLE IF NOT EXISTS "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"total_travel_minutes" integer DEFAULT 0 NOT NULL,
	"total_time_away_minutes" integer DEFAULT 0 NOT NULL,
	"client_groups" jsonb,
	"unmet_visits" jsonb,
	"recommended_drops" jsonb,
	"is_current" boolean DEFAULT false NOT NULL,
	"is_saved" boolean DEFAULT false NOT NULL,
	"saved_name" text,
	"saved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "schedules_one_current_per_tenant" ON "schedules" ("tenant_id") WHERE "is_current" = true;

CREATE INDEX IF NOT EXISTS "schedules_tenant_id_idx" ON "schedules" ("tenant_id");

CREATE TABLE IF NOT EXISTS "schedule_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"day" text NOT NULL,
	"date" date NOT NULL,
	"total_travel_minutes" integer DEFAULT 0 NOT NULL,
	"leave_home_time" text NOT NULL,
	"arrive_home_time" text NOT NULL,
	CONSTRAINT "schedule_days_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "schedule_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_day_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"travel_time_from_prev" integer DEFAULT 0 NOT NULL,
	"travel_distance_mi_from_prev" double precision,
	"manually_placed" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "schedule_visits_schedule_day_id_schedule_days_id_fk" FOREIGN KEY ("schedule_day_id") REFERENCES "public"."schedule_days"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "schedule_visits_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "tenant_domain_chain" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"head_seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_domain_chain_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"client_event_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_claimed_at" timestamp with time zone NOT NULL,
	"server_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"gps_lat" double precision,
	"gps_lon" double precision,
	"gps_accuracy_m" real,
	"gps_captured_at" timestamp with time zone,
	"gps_stale_seconds" integer,
	"is_clinical" boolean DEFAULT false NOT NULL,
	CONSTRAINT "domain_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "domain_events_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "domain_events_tenant_client_event_unique" UNIQUE("tenant_id","client_event_id"),
	CONSTRAINT "domain_events_tenant_seq_unique" UNIQUE("tenant_id","seq")
);

CREATE INDEX IF NOT EXISTS "domain_events_tenant_seq_idx" ON "domain_events" ("tenant_id","seq");
