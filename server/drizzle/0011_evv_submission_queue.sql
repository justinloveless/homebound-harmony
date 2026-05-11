CREATE TABLE "evv_submission_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "evv_visit_id" uuid NOT NULL UNIQUE REFERENCES "evv_visits"("id") ON DELETE CASCADE,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "last_attempt_at" timestamptz,
  "next_retry_at" timestamptz,
  "error_message" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
-->statement-breakpoint
CREATE INDEX "evv_submission_queue_tenant_idx" ON "evv_submission_queue" ("tenant_id");
-->statement-breakpoint
CREATE INDEX "evv_submission_queue_status_idx" ON "evv_submission_queue" ("status");
-->statement-breakpoint
CREATE INDEX "evv_submission_queue_next_retry_idx" ON "evv_submission_queue" ("next_retry_at");
