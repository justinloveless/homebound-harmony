-- Drop encrypted workspace / share tables and remove user crypto columns

DROP TABLE IF EXISTS "share_artifacts" CASCADE;
DROP TABLE IF EXISTS "data_events" CASCADE;
DROP TABLE IF EXISTS "user_event_chain" CASCADE;
DROP TABLE IF EXISTS "workspace_key_wraps" CASCADE;
DROP TABLE IF EXISTS "workspace_snapshots" CASCADE;
DROP TABLE IF EXISTS "workspace_members" CASCADE;
DROP TABLE IF EXISTS "workspaces" CASCADE;

ALTER TABLE "users" DROP COLUMN IF EXISTS "pdk_salt";
ALTER TABLE "users" DROP COLUMN IF EXISTS "recovery_key_hash";
ALTER TABLE "users" DROP COLUMN IF EXISTS "master_public_key";
