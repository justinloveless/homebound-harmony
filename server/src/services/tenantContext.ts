import { and, eq, isNull } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { db } from '../db/client';
import { tenants, tenantMembers } from '../db/schema';

export type TenantRole = 'admin' | 'caregiver';

export type ResolvedTenant = {
  tenantId: string;
  tenantSlug: string;
  role: TenantRole;
};

const APP_DOMAIN = process.env.APP_DOMAIN ?? 'routecare.lovelesslabs.net';

function parseSubdomain(host: string, appDomain: string): string | null {
  const h = host.split(':')[0]?.toLowerCase() ?? '';
  const d = appDomain.toLowerCase();
  if (h === d || h === `www.${d}`) return null;
  if (h.endsWith(`.${d}`)) {
    const sub = h.slice(0, -(d.length + 1));
    if (sub && !sub.includes('.')) return sub;
  }
  return null;
}

/** Resolve tenant from query `tenantId`, Host subdomain, `X-Tenant-Id` / `X-Tenant-Slug`, or first membership. */
export async function resolveTenantForRequest(c: Context, userId: string): Promise<ResolvedTenant | null> {
  const queryTenantId = c.req.query('tenantId')?.trim();

  const host = c.req.header('host') ?? '';
  const fromSub = parseSubdomain(host, APP_DOMAIN);
  const headerTenantId = c.req.header('X-Tenant-Id')?.trim();
  const headerSlug = c.req.header('X-Tenant-Slug')?.trim();

  let tenantId: string | null = null;
  let tenantSlug: string | null = null;

  if (queryTenantId) {
    const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.id, queryTenantId)).limit(1);
    if (!rows[0]) return null;
    tenantId = rows[0].id;
    tenantSlug = rows[0].slug;
  } else if (fromSub) {
    const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.slug, fromSub)).limit(1);
    if (!rows[0]) return null;
    tenantId = rows[0].id;
    tenantSlug = rows[0].slug;
  } else if (headerTenantId) {
    const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.id, headerTenantId)).limit(1);
    if (!rows[0]) return null;
    tenantId = rows[0].id;
    tenantSlug = rows[0].slug;
  } else if (headerSlug) {
    const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.slug, headerSlug)).limit(1);
    if (!rows[0]) return null;
    tenantId = rows[0].id;
    tenantSlug = rows[0].slug;
  } else {
    const rows = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
      .where(and(eq(tenantMembers.userId, userId), isNull(tenantMembers.revokedAt)))
      .limit(1);
    if (!rows[0]) return null;
    tenantId = rows[0].id;
    tenantSlug = rows[0].slug;
    const role = rows[0].role === 'admin' ? 'admin' : 'caregiver';
    return { tenantId, tenantSlug, role };
  }

  const m = await db
    .select({ role: tenantMembers.role })
    .from(tenantMembers)
    .where(
      and(eq(tenantMembers.tenantId, tenantId!), eq(tenantMembers.userId, userId), isNull(tenantMembers.revokedAt)),
    )
    .limit(1);
  if (!m[0]) return null;
  const role = m[0].role === 'admin' ? 'admin' : 'caregiver';
  return { tenantId: tenantId!, tenantSlug: tenantSlug!, role };
}

export const requireTenant: MiddlewareHandler = async (c, next) => {
  const userId = (c as { get: (k: string) => unknown }).get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const t = await resolveTenantForRequest(c, userId);
  if (!t) return c.json({ error: 'Tenant not found or access denied' }, 404);

  (c as { set: (k: string, v: unknown) => void }).set('tenantId', t.tenantId);
  (c as { set: (k: string, v: unknown) => void }).set('tenantSlug', t.tenantSlug);
  (c as { set: (k: string, v: unknown) => void }).set('tenantRole', t.role);
  await next();
};
