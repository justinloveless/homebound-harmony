CREATE TABLE "visit_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "evv_visit_id" uuid NOT NULL REFERENCES "evv_visits"("id") ON DELETE CASCADE,
  "version" integer NOT NULL DEFAULT 1,
  "author_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "tasks_completed" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "free_text" text NOT NULL DEFAULT '',
  "caregiver_signature" text,
  "signed_at" timestamptz,
  "submitted_at" timestamptz,
  "is_final" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
-->statement-breakpoint
CREATE UNIQUE INDEX "visit_notes_visit_version_unique" ON "visit_notes" ("evv_visit_id", "version");
-->statement-breakpoint
CREATE INDEX "visit_notes_visit_id_idx" ON "visit_notes" ("evv_visit_id");
-->statement-breakpoint
CREATE TABLE "task_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "category" text NOT NULL DEFAULT 'general',
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
-->statement-breakpoint
CREATE INDEX "task_templates_tenant_id_idx" ON "task_templates" ("tenant_id");
