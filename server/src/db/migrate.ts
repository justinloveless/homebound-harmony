import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
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
