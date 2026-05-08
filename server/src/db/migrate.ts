import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { resolveDatabaseUrl } from './connection';

export async function runMigrations() {
  const connectionString = resolveDatabaseUrl();
  const pg = postgres(connectionString, { max: 1 });
  const db = drizzle(pg);
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete');
  await pg.end();
}

// Allow running directly: bun src/db/migrate.ts
if (import.meta.main) {
  await runMigrations();
  process.exit(0);
}
