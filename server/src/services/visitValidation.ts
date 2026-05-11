import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { evvVisits, serviceAuthorizations } from '../db/schema';

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidationResult {
  isBillable: boolean;
  issues: ValidationIssue[];
}

type VisitRow = typeof evvVisits.$inferSelect;
type AuthRow = typeof serviceAuthorizations.$inferSelect;

export function validateVisitData(
  visit: VisitRow,
  auth: AuthRow | null,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (visit.visitStatus !== 'completed') {
    return {
      isBillable: false,
      issues: [{ code: 'VISIT_INCOMPLETE', message: 'Visit is not yet completed' }],
    };
  }

  // EVV status
  if (visit.evvStatus === 'rejected') {
    issues.push({ code: 'EVV_REJECTED', message: 'EVV submission was rejected by the aggregator' });
  } else if (visit.evvStatus !== 'accepted' && visit.evvStatus !== 'pending') {
    issues.push({ code: 'EVV_PENDING', message: 'EVV has not been submitted or accepted' });
  }

  // Note status — 'complete' means signed note on file
  if (visit.noteStatus !== 'complete') {
    issues.push({ code: 'NOTE_INCOMPLETE', message: 'Visit note has not been signed and submitted' });
  }

  // Authorization
  if (!visit.authorizationId) {
    issues.push({ code: 'NO_AUTHORIZATION', message: 'No service authorization linked to this visit' });
  } else if (!auth) {
    issues.push({ code: 'NO_AUTHORIZATION', message: 'Linked authorization record not found' });
  } else {
    const visitDate = visit.checkInAt.toISOString().slice(0, 10);
    if (visitDate < auth.startDate || visitDate > auth.endDate) {
      issues.push({ code: 'AUTH_EXPIRED', message: 'Visit date falls outside the authorization period' });
    } else if (auth.status === 'expired' || auth.status === 'exhausted') {
      issues.push({ code: 'AUTH_EXPIRED', message: `Authorization is ${auth.status}` });
    }
    if (auth.unitsUsed > auth.unitsAuthorized) {
      issues.push({
        code: 'AUTH_EXCEEDED',
        message: `Authorization units exceeded (${auth.unitsUsed}/${auth.unitsAuthorized} used)`,
      });
    }
  }

  // Minimum duration
  if ((visit.durationMinutes ?? 0) < 8) {
    issues.push({ code: 'DURATION_TOO_SHORT', message: 'Visit duration is less than 8 minutes (minimum billable)' });
  }

  // Timestamp sanity
  if (!visit.checkOutAt) {
    issues.push({ code: 'INVALID_TIMESTAMPS', message: 'Visit has no check-out time' });
  } else if (visit.checkOutAt <= visit.checkInAt) {
    issues.push({ code: 'INVALID_TIMESTAMPS', message: 'Check-out time must be after check-in time' });
  } else {
    const durationHours = (visit.checkOutAt.getTime() - visit.checkInAt.getTime()) / 3_600_000;
    if (durationHours > 24) {
      issues.push({ code: 'INVALID_TIMESTAMPS', message: 'Visit duration exceeds 24 hours — likely a data error' });
    }
  }

  return { isBillable: issues.length === 0, issues };
}

export async function validateVisit(tenantId: string, visitId: string): Promise<ValidationResult> {
  const [visit] = await db
    .select()
    .from(evvVisits)
    .where(and(eq(evvVisits.id, visitId), eq(evvVisits.tenantId, tenantId)))
    .limit(1);

  if (!visit) throw new Error('Visit not found');

  let auth: AuthRow | null = null;
  if (visit.authorizationId) {
    const [row] = await db
      .select()
      .from(serviceAuthorizations)
      .where(eq(serviceAuthorizations.id, visit.authorizationId))
      .limit(1);
    auth = row ?? null;
  }

  return validateVisitData(visit, auth);
}

export async function validateAndSave(tenantId: string, visitId: string): Promise<ValidationResult> {
  const result = await validateVisit(tenantId, visitId);

  await db
    .update(evvVisits)
    .set({ isBillable: result.isBillable, billingIssues: result.issues, updatedAt: new Date() })
    .where(and(eq(evvVisits.id, visitId), eq(evvVisits.tenantId, tenantId)));

  return result;
}

export async function bulkValidateCompleted(
  tenantId: string,
  visitIds?: string[],
): Promise<{ validated: number; billable: number }> {
  const baseCondition = and(eq(evvVisits.tenantId, tenantId), eq(evvVisits.visitStatus, 'completed'));
  const condition =
    visitIds && visitIds.length > 0
      ? and(baseCondition, inArray(evvVisits.id, visitIds))
      : baseCondition;

  const visits = await db.select().from(evvVisits).where(condition);

  const authIds = [...new Set(visits.map((v) => v.authorizationId).filter((id): id is string => !!id))];
  const authMap = new Map<string, AuthRow>();
  if (authIds.length > 0) {
    const authRows = await db
      .select()
      .from(serviceAuthorizations)
      .where(inArray(serviceAuthorizations.id, authIds));
    for (const a of authRows) authMap.set(a.id, a);
  }

  let billable = 0;
  for (const visit of visits) {
    const auth = visit.authorizationId ? (authMap.get(visit.authorizationId) ?? null) : null;
    const result = validateVisitData(visit, auth);
    await db
      .update(evvVisits)
      .set({ isBillable: result.isBillable, billingIssues: result.issues, updatedAt: new Date() })
      .where(eq(evvVisits.id, visit.id));
    if (result.isBillable) billable++;
  }

  return { validated: visits.length, billable };
}
