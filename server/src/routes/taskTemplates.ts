import { Hono } from 'hono';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';
import { requireRole } from '../auth/rbac';
import {
  getTaskTemplatesForTenant,
  createTaskTemplate,
  updateTaskTemplate,
} from '../services/visitNoteService';

const r = new Hono();
r.use('*', requireUser);
r.use('*', requireTenant);

r.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const templates = await getTaskTemplatesForTenant(tenantId);
  return c.json({ templates });
});

r.post('/', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId');
  const body = await c.req.json().catch(() => null);
  if (!body?.label) return c.json({ error: 'label required' }, 400);

  const template = await createTaskTemplate(tenantId, {
    label: body.label,
    category: body.category,
    sortOrder: body.sortOrder,
  });
  return c.json({ template }, 201);
});

r.put('/:id', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Body required' }, 400);

  try {
    const template = await updateTaskTemplate(tenantId, id, {
      label: body.label,
      category: body.category,
      sortOrder: body.sortOrder,
      isActive: body.isActive,
    });
    return c.json({ template });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Update failed';
    return c.json({ error: msg }, 404);
  }
});

r.delete('/:id', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');

  try {
    await updateTaskTemplate(tenantId, id, { isActive: false });
    return c.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Delete failed';
    return c.json({ error: msg }, 404);
  }
});

export { r as taskTemplatesRouter };
