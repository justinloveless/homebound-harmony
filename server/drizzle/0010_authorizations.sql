CREATE TABLE "service_authorizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "service_code" text NOT NULL,
  "payer_name" text NOT NULL DEFAULT '',
  "payer_id" text NOT NULL DEFAULT '',
  "units_authorized" integer NOT NULL,
  "units_used" integer NOT NULL DEFAULT 0,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
-->statement-breakpoint
CREATE INDEX "service_authorizations_tenant_id_idx" ON "service_authorizations" ("tenant_id");
-->statement-breakpoint
CREATE INDEX "service_authorizations_tenant_client_idx" ON "service_authorizations" ("tenant_id", "client_id");
-->statement-breakpoint
CREATE INDEX "service_authorizations_tenant_status_idx" ON "service_authorizations" ("tenant_id", "status");
-->statement-breakpoint
ALTER TABLE "evv_visits" ADD CONSTRAINT "evv_visits_authorization_id_fk"
  FOREIGN KEY ("authorization_id") REFERENCES "service_authorizations"("id") ON DELETE SET NULL;
