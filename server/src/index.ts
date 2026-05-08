import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { authRouter } from './routes/auth';
import { workspaceRouter } from './routes/workspace';
import { snapshotRouter } from './routes/snapshot';
import { eventsRouter } from './routes/events';
import { shareRouter, shareDataHandler } from './routes/share';
import { adminRouter } from './routes/admin';
import { workspaceTeamRouter } from './routes/workspaceTeam';
import { adminAllowlistSize } from './auth/admin';
import { runMigrations } from './db/migrate';
import { resolveDatabaseUrl } from './db/connection';
import { runSeed } from './scripts/seed';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json',
};

const app = new Hono();

app.use('*', logger());
// secureHeaders adds X-Content-Type-Options, Referrer-Policy, etc. We leave
// the default CSP off because the Vite-built SPA uses inline styles; tighten
// once we ship a hashed-CSP pipeline.
app.use('*', secureHeaders());

app.get('/healthz', (c) => c.text('ok'));

app.route('/api/auth', authRouter);
// Team routes must register before the legacy catch-all `workspace.all('*')` 410 router.
app.route('/api/workspace', workspaceTeamRouter);
app.route('/api/workspace', workspaceRouter);
app.route('/api/snapshot', snapshotRouter);
app.route('/api/events', eventsRouter);
app.route('/api/share', shareRouter);
app.route('/api/admin', adminRouter);

// Public share data endpoint — anyone with the URL fragment key can read.
app.get('/s/:id/data', shareDataHandler);

// Static SPA fallback. The combined Docker image copies the web build into
// /app/public; locally we run `vite` separately and don't hit this branch.
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR ?? './public');

async function readIfExists(absPath: string): Promise<Buffer | null> {
  try {
    const s = await stat(absPath);
    if (!s.isFile()) return null;
    return await readFile(absPath);
  } catch {
    return null;
  }
}

app.get('*', async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);

  // Resolve under PUBLIC_DIR and reject any path traversal.
  const requested = path.resolve(PUBLIC_DIR, '.' + url.pathname);
  if (requested.startsWith(PUBLIC_DIR)) {
    const direct = await readIfExists(requested);
    if (direct) {
      const ext = path.extname(requested).toLowerCase();
      return new Response(direct as any, {
        headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' },
      });
    }
  }

  const index = await readIfExists(path.join(PUBLIC_DIR, 'index.html'));
  if (index) return new Response(index as any, { headers: { 'Content-Type': MIME['.html'] } });
  return c.text('SPA build not found', 404);
});

const port = Number(process.env.PORT ?? 3000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; errno?: number; message?: string };
  if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return true;
  if (e.errno === 103) return true;
  return typeof e.message === 'string' && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Failed to connect/i.test(e.message);
}

type ParsedDbTarget = { host: string; port: number; database: string };

function getDbTarget(): ParsedDbTarget | null {
  try {
    const raw = resolveDatabaseUrl();
    const u = new URL(raw);
    return {
      host: u.hostname || 'postgres',
      port: Number(u.port || 5432),
      database: u.pathname.replace(/^\//, '') || '<none>',
    };
  } catch {
    return null;
  }
}

async function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<string> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('ok'));
    socket.once('timeout', () => done(`timeout (${timeoutMs}ms)`));
    socket.once('error', (err) => done(`error: ${(err as Error).message}`));
  });
}

async function logDbConnectivitySnapshot(): Promise<void> {
  const target = getDbTarget();
  if (!target) {
    console.warn('DB connectivity check skipped: DATABASE_URL is missing or invalid');
    return;
  }

  const dnsResult = await lookup(target.host, { all: true }).then(
    (records) => records.map((r) => `${r.address}/${r.family}`).join(', ') || 'no records',
    (err) => `dns error: ${(err as Error).message}`,
  );
  const probe = await tcpProbe(target.host, target.port);
  console.warn(
    `DB connectivity snapshot host=${target.host} port=${target.port} db=${target.database} dns=[${dnsResult}] tcp=${probe}`,
  );
}

async function runMigrationsWithRetry(): Promise<void> {
  const attempts = Number(process.env.MIGRATION_RETRIES ?? 20);
  const delayMs = Number(process.env.MIGRATION_RETRY_DELAY_MS ?? 3000);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await runMigrations();
      return;
    } catch (err) {
      const retryable = isTransientDbError(err);
      if (!retryable || attempt === attempts) throw err;
      await logDbConnectivitySnapshot();
      console.warn(
        `Migration attempt ${attempt}/${attempts} failed; retrying in ${delayMs}ms`,
        err,
      );
      await sleep(delayMs);
    }
  }
}

if (process.env.RUN_MIGRATIONS_ON_BOOT !== 'false') {
  await runMigrationsWithRetry().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

if (process.env.RUN_SEED_ON_BOOT !== 'false') {
  try {
    console.log('Running seed…');
    await runSeed();
    console.log('Seed complete');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
}

console.log(`Listening on http://0.0.0.0:${port}`);
console.log(`ADMIN_EMAILS allowlist: ${adminAllowlistSize()} entr(y/ies) (set ADMIN_EMAILS=comma@emails)`);

export default {
  port,
  fetch: app.fetch,
};
