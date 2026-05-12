CREATE TABLE "claim_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "generated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "visit_count" integer NOT NULL DEFAULT 0,
  "total_units" integer NOT NULL DEFAULT 0,
  "date_range_start" date NOT NULL,
  "date_range_end" date NOT NULL,
  "csv_content" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'generated',
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "claim_batches_tenant_id_idx" ON "claim_batches" ("tenant_id");
