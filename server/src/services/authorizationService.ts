import { eq, and, lte, gte } from 'drizzle-orm';
import { db } from '../db/client';
import { serviceAuthorizations, evvVisits, clients } from '../db/schema';

export interface ServiceAuthorization {
  id: string;
  tenantId: string;
  clientId: string;
  clientName?: string;
  serviceCode: string;
  payerName: string;
  payerId: string;
  unitsAuthorized: number;
  unitsUsed: number;
  startDate: string;
  endDate: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAuthorizationInput {
  clientId: string;
  serviceCode: string;
  payerName?: string;
  payerId?: string;
  unitsAuthorized: number;
  startDate: string;
  endDate: string;
}

export interface AuthorizationUsageDetail {
  authorization: ServiceAuthorization;
  linkedVisits: Array<{
    id: string;
    checkInAt: Date;
    checkOutAt: Date | null;
    billableUnits: number | null;
    visitStatus: string;
  }>;
}

export async function listAuthorizations(
  tenantId: string,
  filters?: { clientId?: string; status?: string; serviceCode?: string },
): Promise<ServiceAuthorization[]> {
  const conditions = [eq(serviceAuthorizations.tenantId, tenantId)];
  if (filters?.clientId) conditions.push(eq(serviceAuthorizations.clientId, filters.clientId));
  if (filters?.status) conditions.push(eq(serviceAuthorizations.status, filters.status));
  if (filters?.serviceCode) conditions.push(eq(serviceAuthorizations.serviceCode, filters.serviceCode));

  const rows = await db
    .select({
      auth: serviceAuthorizations,
      clientName: clients.name,
    })
    .from(serviceAuthorizations)
    .leftJoin(clients, eq(clients.id, serviceAuthorizations.clientId))
    .where(and(...conditions))
    .orderBy(serviceAuthorizations.endDate);

  return rows.map((r) => ({ ...r.auth, clientName: r.clientName ?? '' }));
}

export async function getAuthorizationDetail(
  tenantId: string,
  id: string,
): Promise<AuthorizationUsageDetail | null> {
  const authRows = await db
    .select({ auth: serviceAuthorizations, clientName: clients.name })
    .from(serviceAuthorizations)
    .leftJoin(clients, eq(clients.id, serviceAuthorizations.clientId))
    .where(and(eq(serviceAuthorizations.id, id), eq(serviceAuthorizations.tenantId, tenantId)))
    .limit(1);

  if (!authRows[0]) return null;

  const visitRows = await db
    .select({
      id: evvVisits.id,
      checkInAt: evvVisits.checkInAt,
      checkOutAt: evvVisits.checkOutAt,
      billableUnits: evvVisits.billableUnits,
      visitStatus: evvVisits.visitStatus,
    })
    .from(evvVisits)
    .where(and(eq(evvVisits.authorizationId, id), eq(evvVisits.tenantId, tenantId)))
    .orderBy(evvVisits.checkInAt);

  return {
    authorization: { ...authRows[0].auth, clientName: authRows[0].clientName ?? '' },
    linkedVisits: visitRows,
  };
}

export async function createAuthorization(
  tenantId: string,
  data: CreateAuthorizationInput,
): Promise<ServiceAuthorization> {
  const rows = await db
    .insert(serviceAuthorizations)
    .values({
      tenantId,
      clientId: data.clientId,
      serviceCode: data.serviceCode,
      payerName: data.payerName ?? '',
      payerId: data.payerId ?? '',
      unitsAuthorized: data.unitsAuthorized,
      unitsUsed: 0,
      startDate: data.startDate,
      endDate: data.endDate,
      status: 'active',
    })
    .returning();

  return rows[0] as ServiceAuthorization;
}

export async function updateAuthorization(
  tenantId: string,
  id: string,
  data: Partial<CreateAuthorizationInput> & { status?: string },
): Promise<ServiceAuthorization | null> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.serviceCode !== undefined) patch.serviceCode = data.serviceCode;
  if (data.payerName !== undefined) patch.payerName = data.payerName;
  if (data.payerId !== undefined) patch.payerId = data.payerId;
  if (data.unitsAuthorized !== undefined) patch.unitsAuthorized = data.unitsAuthorized;
  if (data.startDate !== undefined) patch.startDate = data.startDate;
  if (data.endDate !== undefined) patch.endDate = data.endDate;
  if (data.status !== undefined) patch.status = data.status;

  const rows = await db
    .update(serviceAuthorizations)
    .set(patch)
    .where(and(eq(serviceAuthorizations.id, id), eq(serviceAuthorizations.tenantId, tenantId)))
    .returning();

  return (rows[0] as ServiceAuthorization) ?? null;
}

export async function autoMatchAuthorization(
  tenantId: string,
  clientId: string,
  serviceCode: string,
  visitDate: Date,
): Promise<string | null> {
  const dateStr = visitDate.toISOString().slice(0, 10);

  const rows = await db
    .select({ id: serviceAuthorizations.id })
    .from(serviceAuthorizations)
    .where(
      and(
        eq(serviceAuthorizations.tenantId, tenantId),
        eq(serviceAuthorizations.clientId, clientId),
        eq(serviceAuthorizations.serviceCode, serviceCode),
        eq(serviceAuthorizations.status, 'active'),
        lte(serviceAuthorizations.startDate, dateStr),
        gte(serviceAuthorizations.endDate, dateStr),
      ),
    )
    .orderBy(serviceAuthorizations.endDate)
    .limit(1);

  return rows[0]?.id ?? null;
}

export async function incrementUnitsUsed(
  tenantId: string,
  authId: string,
  units: number,
): Promise<void> {
  const rows = await db
    .select({
      unitsUsed: serviceAuthorizations.unitsUsed,
      unitsAuthorized: serviceAuthorizations.unitsAuthorized,
    })
    .from(serviceAuthorizations)
    .where(and(eq(serviceAuthorizations.id, authId), eq(serviceAuthorizations.tenantId, tenantId)))
    .limit(1);

  if (!rows[0]) return;

  const newUsed = rows[0].unitsUsed + units;
  const newStatus = newUsed >= rows[0].unitsAuthorized ? 'exhausted' : 'active';

  await db
    .update(serviceAuthorizations)
    .set({ unitsUsed: newUsed, status: newStatus, updatedAt: new Date() })
    .where(eq(serviceAuthorizations.id, authId));
}
