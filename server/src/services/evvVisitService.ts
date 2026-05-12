import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import { evvVisits, workers } from '../db/schema';
import { calculateBillableUnits } from './billingCalculation';
import { autoMatchAuthorization, incrementUnitsUsed } from './authorizationService';
import { validateAndSave } from './visitValidation';
import { enqueueForSubmission } from './evvSubmissionWorker';

export interface CheckInInput {
  tenantId: string;
  workerId: string;
  clientId: string;
  scheduleVisitId?: string;
  verificationMethod?: 'gps' | 'telephony' | 'biometric';
  lat: number;
  lon: number;
  accuracyM: number;
  serviceCode?: string;
}

export interface CheckOutInput {
  tenantId: string;
  evvVisitId: string;
  lat: number;
  lon: number;
  accuracyM: number;
}

export interface EvvVisitRow {
  id: string;
  tenantId: string;
  clientId: string;
  workerId: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  visitStatus: string;
  durationMinutes: number | null;
  billableUnits: number | null;
  evvStatus: string;
  noteStatus: string;
  isBillable: boolean;
  billingIssues: unknown;
  serviceCode: string | null;
  verificationMethod: string;
  checkInLat: number;
  checkInLon: number;
  checkOutLat: number | null;
  checkOutLon: number | null;
}

export async function getWorkerIdForUser(tenantId: string, userId: string): Promise<string | null> {
  const rows = await db
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.tenantId, tenantId), eq(workers.userId, userId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function checkIn(input: CheckInInput): Promise<{ id: string }> {
  const existing = await getActiveVisit(input.tenantId, input.workerId);
  if (existing) {
    throw new Error('Worker already has an active visit');
  }

  const rows = await db
    .insert(evvVisits)
    .values({
      tenantId: input.tenantId,
      clientId: input.clientId,
      workerId: input.workerId,
      scheduleVisitId: input.scheduleVisitId ?? null,
      checkInAt: new Date(),
      checkInLat: input.lat,
      checkInLon: input.lon,
      checkInAccuracyM: input.accuracyM,
      verificationMethod: input.verificationMethod ?? 'gps',
      serviceCode: input.serviceCode ?? null,
      visitStatus: 'in_progress',
      evvStatus: 'pending',
      noteStatus: 'pending',
    })
    .returning({ id: evvVisits.id });

  return { id: rows[0].id };
}

export async function checkOut(input: CheckOutInput): Promise<{
  durationMinutes: number;
  billableUnits: number;
}> {
  const rows = await db
    .select()
    .from(evvVisits)
    .where(
      and(
        eq(evvVisits.id, input.evvVisitId),
        eq(evvVisits.tenantId, input.tenantId),
        eq(evvVisits.visitStatus, 'in_progress'),
      ),
    )
    .limit(1);

  const visit = rows[0];
  if (!visit) {
    throw new Error('Visit not found or already completed');
  }

  const now = new Date();
  const durationMinutes = Math.round(
    (now.getTime() - visit.checkInAt.getTime()) / 60_000,
  );
  const billableUnits = calculateBillableUnits(durationMinutes);

  const serviceCode = visit.serviceCode ?? 'T1019';
  const authId = await autoMatchAuthorization(
    input.tenantId,
    visit.clientId,
    serviceCode,
    now,
  );

  await db
    .update(evvVisits)
    .set({
      checkOutAt: now,
      checkOutLat: input.lat,
      checkOutLon: input.lon,
      checkOutAccuracyM: input.accuracyM,
      durationMinutes,
      billableUnits,
      visitStatus: 'completed',
      authorizationId: authId ?? null,
      updatedAt: now,
    })
    .where(eq(evvVisits.id, input.evvVisitId));

  if (authId && billableUnits > 0) {
    await incrementUnitsUsed(input.tenantId, authId, billableUnits);
  }

  await validateAndSave(input.tenantId, input.evvVisitId);
  await enqueueForSubmission(input.tenantId, input.evvVisitId);

  return { durationMinutes, billableUnits };
}

export async function getActiveVisit(
  tenantId: string,
  workerId: string,
): Promise<EvvVisitRow | null> {
  const rows = await db
    .select()
    .from(evvVisits)
    .where(
      and(
        eq(evvVisits.tenantId, tenantId),
        eq(evvVisits.workerId, workerId),
        eq(evvVisits.visitStatus, 'in_progress'),
      ),
    )
    .limit(1);
  return (rows[0] as EvvVisitRow) ?? null;
}

export async function cancelVisit(
  tenantId: string,
  evvVisitId: string,
): Promise<void> {
  await db
    .update(evvVisits)
    .set({ visitStatus: 'cancelled', updatedAt: new Date() })
    .where(
      and(
        eq(evvVisits.id, evvVisitId),
        eq(evvVisits.tenantId, tenantId),
      ),
    );
}

export async function getVisit(
  tenantId: string,
  evvVisitId: string,
): Promise<EvvVisitRow | null> {
  const rows = await db
    .select()
    .from(evvVisits)
    .where(
      and(eq(evvVisits.id, evvVisitId), eq(evvVisits.tenantId, tenantId)),
    )
    .limit(1);
  return (rows[0] as EvvVisitRow) ?? null;
}
