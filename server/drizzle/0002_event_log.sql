ALTER TABLE "workspace_blobs" RENAME TO "workspace_snapshots";
ALTER TABLE "workspace_snapshots" ADD COLUMN "snapshot_seq" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "data_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_event_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"client_claimed_at" timestamp with time zone NOT NULL,
	"server_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"gps_lat" double precision,
	"gps_lon" double precision,
	"gps_accuracy_m" real,
	"gps_captured_at" timestamp with time zone,
	"gps_stale_seconds" integer,
	"is_clinical" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_events" ADD CONSTRAINT "data_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "data_events_user_client_event_id_unique" ON "data_events" USING btree ("user_id","client_event_id");
--> statement-breakpoint
CREATE INDEX "data_events_user_id_seq_idx" ON "data_events" USING btree ("user_id","seq");
--> statement-breakpoint
CREATE TABLE "user_event_chain" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"head_seq" bigint DEFAULT 0 NOT NULL,
	"head_hash" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_event_chain" ADD CONSTRAINT "user_event_chain_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "user_event_chain" ("user_id", "head_seq", "head_hash")
SELECT "user_id", 0, '' FROM "workspace_snapshots"
ON CONFLICT ("user_id") DO NOTHING;
