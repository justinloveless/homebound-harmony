import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { authRouter } from './routes/auth';
import { workspaceRouter } from './routes/workspace';
import { shareRouter, shareDataHandler } from './routes/share';
import { runMigrations } from './db/migrate';

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
app.route('/api/workspace', workspaceRouter);
app.route('/api/share', shareRouter);

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

if (process.env.RUN_MIGRATIONS_ON_BOOT !== 'false') {
  await runMigrations().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

console.log(`Listening on http://0.0.0.0:${port}`);

export default {
  port,
  fetch: app.fetch,
};
