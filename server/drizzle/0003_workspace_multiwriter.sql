CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "workspaces" ("id")
SELECT "user_id" FROM "workspace_snapshots";
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "workspace_members_user_active_idx" ON "workspace_members" ("user_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
SELECT "user_id", "user_id", 'owner' FROM "workspace_snapshots";
--> statement-breakpoint
CREATE TABLE "workspace_key_wraps" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key_epoch" integer DEFAULT 0 NOT NULL,
	"wrapped_workspace_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_key_wraps_pk" PRIMARY KEY("workspace_id","user_id","key_epoch")
);
--> statement-breakpoint
INSERT INTO "workspace_key_wraps" ("workspace_id", "user_id", "key_epoch", "wrapped_workspace_key")
SELECT "user_id", "user_id", 0, "wrapped_workspace_key" FROM "workspace_snapshots";
--> statement-breakpoint
ALTER TABLE "workspace_snapshots" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
UPDATE "workspace_snapshots" SET "workspace_id" = "user_id";
--> statement-breakpoint
ALTER TABLE "workspace_snapshots" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_snapshots" ADD COLUMN "key_epoch" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_snapshots" DROP CONSTRAINT IF EXISTS "workspace_snapshots_pkey";
ALTER TABLE "workspace_snapshots" DROP CONSTRAINT IF EXISTS "workspace_blobs_pkey";
--> statement-breakpoint
ALTER TABLE "workspace_snapshots" DROP CONSTRAINT IF EXISTS "workspace_snapshots_user_id_users_id_fk";
ALTER TABLE "workspace_snapshots" DROP CONSTRAINT IF EXISTS "workspace_blobs_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_snapshots" DROP COLUMN "user_id";
--> statement-breakpoint
ALTER TABLE "workspace_snapshots" DROP COLUMN "wrapped_workspace_key";
--> statement-breakpoint
ALTER TABLE "workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_pkey" PRIMARY KEY("workspace_id");
--> statement-breakpoint
ALTER TABLE "workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_key_wraps" ADD CONSTRAINT "workspace_key_wraps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_key_wraps" ADD CONSTRAINT "workspace_key_wraps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_event_chain" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
UPDATE "user_event_chain" SET "workspace_id" = "user_id";
--> statement-breakpoint
ALTER TABLE "user_event_chain" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_event_chain" DROP CONSTRAINT "user_event_chain_pkey";
--> statement-breakpoint
ALTER TABLE "user_event_chain" DROP CONSTRAINT "user_event_chain_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_event_chain" DROP COLUMN "user_id";
--> statement-breakpoint
ALTER TABLE "user_event_chain" ADD CONSTRAINT "user_event_chain_pkey" PRIMARY KEY("workspace_id");
--> statement-breakpoint
ALTER TABLE "user_event_chain" ADD CONSTRAINT "user_event_chain_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_events" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "data_events" ADD COLUMN "author_user_id" uuid;
--> statement-breakpoint
UPDATE "data_events" SET "workspace_id" = "user_id", "author_user_id" = "user_id";
--> statement-breakpoint
ALTER TABLE "data_events" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "data_events" ALTER COLUMN "author_user_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX "data_events_user_client_event_id_unique";
--> statement-breakpoint
DROP INDEX "data_events_user_id_seq_idx";
--> statement-breakpoint
ALTER TABLE "data_events" DROP CONSTRAINT "data_events_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "data_events" DROP COLUMN "user_id";
--> statement-breakpoint
CREATE UNIQUE INDEX "data_events_workspace_client_event_id_unique" ON "data_events" ("workspace_id","client_event_id");
--> statement-breakpoint
CREATE INDEX "data_events_workspace_id_seq_idx" ON "data_events" ("workspace_id","seq");
--> statement-breakpoint
ALTER TABLE "data_events" ADD CONSTRAINT "data_events_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_events" ADD CONSTRAINT "data_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
