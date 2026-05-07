import { Hono } from 'hono';

/** Legacy /api/workspace — removed; coordinated clients use /api/snapshot and /api/events. */
const workspace = new Hono();

const MIN = process.env.MIN_CLIENT_VERSION ?? '2026.5.6';

workspace.all('*', (c) =>
  c.json({ error: 'Endpoint removed; please update the app', minClientVersion: MIN }, 410),
);

export { workspace as workspaceRouter };
