import { Hono } from 'hono';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';
import { requireRole } from '../auth/rbac';
import { appendDomainEvent } from '../services/appendDomainEvent';
import { hashIp } from '../services/ipHash';
import {
  listAuthorizations,
  getAuthorizationDetail,
  createAuthorization,
  updateAuthorization,
} from '../services/authorizationService';

const r = new Hono();
r.use('*', requireUser);
r.use('*', requireTenant);
r.use('*', requireRole('admin'));

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

r.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const clientId = c.req.query('clientId') ?? undefined;
  const status = c.req.query('status') ?? undefined;
  const serviceCode = c.req.query('serviceCode') ?? undefined;

  const auths = await listAuthorizations(tenantId, { clientId, status, serviceCode });
  return c.json({ authorizations: auths });
});

r.post('/', async (c) => {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);

  if (!body?.clientId) return c.json({ error: 'clientId required' }, 400);
  if (!body?.serviceCode) return c.json({ error: 'serviceCode required' }, 400);
  if (!body?.unitsAuthorized || body.unitsAuthorized < 1)
    return c.json({ error: 'unitsAuthorized must be >= 1' }, 400);
  if (!body?.startDate) return c.json({ error: 'startDate required' }, 400);
  if (!body?.endDate) return c.json({ error: 'endDate required' }, 400);

  const auth = await createAuthorization(tenantId, {
    clientId: body.clientId,
    serviceCode: body.serviceCode,
    payerName: body.payerName ?? '',
    payerId: body.payerId ?? '',
    unitsAuthorized: Number(body.unitsAuthorized),
    startDate: body.startDate,
    endDate: body.endDate,
  });

  const ip = getClientIp(c);
  const ipHash = ip !== 'unknown' ? await hashIp(ip) : null;
  await appendDomainEvent({
    tenantId,
    authorUserId: userId,
    kind: 'authorization_created',
    payload: {
      authorizationId: auth.id,
      clientId: auth.clientId,
      serviceCode: auth.serviceCode,
      unitsAuthorized: auth.unitsAuthorized,
      startDate: auth.startDate,
      endDate: auth.endDate,
    },
    ipHash,
    isClinical: false,
  });

  return c.json({ authorization: auth }, 201);
});

r.put('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);

  if (!body) return c.json({ error: 'Request body required' }, 400);

  const changes: Record<string, unknown> = {};
  const patch: Parameters<typeof updateAuthorization>[2] = {};

  if (body.serviceCode !== undefined) { patch.serviceCode = body.serviceCode; changes.serviceCode = body.serviceCode; }
  if (body.payerName !== undefined) { patch.payerName = body.payerName; changes.payerName = body.payerName; }
  if (body.payerId !== undefined) { patch.payerId = body.payerId; changes.payerId = body.payerId; }
  if (body.unitsAuthorized !== undefined) { patch.unitsAuthorized = Number(body.unitsAuthorized); changes.unitsAuthorized = patch.unitsAuthorized; }
  if (body.startDate !== undefined) { patch.startDate = body.startDate; changes.startDate = body.startDate; }
  if (body.endDate !== undefined) { patch.endDate = body.endDate; changes.endDate = body.endDate; }
  if (body.status !== undefined) { patch.status = body.status; changes.status = body.status; }

  const auth = await updateAuthorization(tenantId, id, patch);
  if (!auth) return c.json({ error: 'Not found' }, 404);

  const ip = getClientIp(c);
  const ipHash = ip !== 'unknown' ? await hashIp(ip) : null;
  await appendDomainEvent({
    tenantId,
    authorUserId: userId,
    kind: 'authorization_updated',
    payload: { authorizationId: id, changes },
    ipHash,
    isClinical: false,
  });

  return c.json({ authorization: auth });
});

r.get('/:id/usage', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');

  const detail = await getAuthorizationDetail(tenantId, id);
  if (!detail) return c.json({ error: 'Not found' }, 404);

  return c.json(detail);
});

export { r as authorizationsRouter };
