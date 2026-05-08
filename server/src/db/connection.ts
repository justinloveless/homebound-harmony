export function resolveDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required');

  const overrideHost = (process.env.POSTGRES_HOST ?? '').trim();
  if (!overrideHost) return raw;

  const parsed = new URL(raw);
  parsed.hostname = overrideHost;
  return parsed.toString();
}
