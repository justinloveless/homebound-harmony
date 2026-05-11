-- Phase 1: EVV Core schema additions

-- Add EVV/billing columns to tenants
ALTER TABLE "tenants" ADD COLUMN "evv_vendor_id" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "evv_api_key_encrypted" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "billing_config" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_service_code" text NOT NULL DEFAULT 'T1019';
--> statement-breakpoint

-- Add EVV identifiers to workers
ALTER TABLE "workers" ADD COLUMN "npi" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "employee_id" text NOT NULL DEFAULT '';
--> statement-breakpoint

-- Add payer identifiers to clients
ALTER TABLE "clients" ADD COLUMN "medicaid_id" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "payer_member_id" text NOT NULL DEFAULT '';
--> statement-breakpoint

-- EVV visits: materialized projection for visit lifecycle + billing
CREATE TABLE IF NOT EXISTS "evv_visits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "worker_id" uuid NOT NULL REFERENCES "workers"("id") ON DELETE CASCADE,
  "authorization_id" uuid,
  "schedule_visit_id" uuid REFERENCES "schedule_visits"("id") ON DELETE SET NULL,
  "check_in_at" timestamp with time zone NOT NULL,
  "check_out_at" timestamp with time zone,
  "check_in_lat" double precision NOT NULL,
  "check_in_lon" double precision NOT NULL,
  "check_in_accuracy_m" real NOT NULL,
  "check_out_lat" double precision,
  "check_out_lon" double precision,
  "check_out_accuracy_m" real,
  "verification_method" text NOT NULL DEFAULT 'gps',
  "service_code" text,
  "duration_minutes" integer,
  "billable_units" integer,
  "visit_status" text NOT NULL DEFAULT 'in_progress',
  "evv_status" text NOT NULL DEFAULT 'pending',
  "evv_rejection_reason" text,
  "evv_submitted_at" timestamp with time zone,
  "evv_response_at" timestamp with time zone,
  "evv_external_id" text,
  "note_status" text NOT NULL DEFAULT 'pending',
  "is_billable" boolean NOT NULL DEFAULT false,
  "billing_issues" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "claim_batch_id" uuid,
  "claimed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evv_visits_tenant_status_idx" ON "evv_visits" ("tenant_id", "visit_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evv_visits_tenant_evv_status_idx" ON "evv_visits" ("tenant_id", "evv_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evv_visits_tenant_billable_idx" ON "evv_visits" ("tenant_id", "is_billable");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evv_visits_tenant_worker_status_idx" ON "evv_visits" ("tenant_id", "worker_id", "visit_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evv_visits_tenant_client_idx" ON "evv_visits" ("tenant_id", "client_id");
