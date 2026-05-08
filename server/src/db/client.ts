import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { resolveDatabaseUrl } from './connection';

const connectionString = resolveDatabaseUrl();

export const pg = postgres(connectionString);
export const db = drizzle(pg, { schema });
