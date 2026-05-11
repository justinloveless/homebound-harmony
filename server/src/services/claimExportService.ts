import { and, eq, gte, lte, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { evvVisits, clients, workers, claimBatches, serviceAuthorizations } from '../db/schema';

export interface ClaimFilters {
  dateRangeStart: string; // YYYY-MM-DD
  dateRangeEnd: string;
  clientId?: string;
  workerId?: string;
}

interface ClaimRow {
  patientName: string;
  medicaidId: string;
  caregiverName: string;
  caregiverNpi: string;
  serviceCode: string;
  serviceDate: string;
  startTime: string;
  endTime: string;
  units: number;
  authorizationNumber: string;
}

function toCentral(date: Date): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: parts.hour === '24' ? `00:${parts.minute}` : `${parts.hour}:${parts.minute}`,
  };
}

function buildCsv(rows: ClaimRow[]): string {
  const header = 'PatientName,MedicaidID,CaregiverName,CaregiverNPI,ServiceCode,ServiceDate,StartTime,EndTime,Units,AuthorizationNumber';
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      escape(r.patientName),
      escape(r.medicaidId),
      escape(r.caregiverName),
      escape(r.caregiverNpi),
      escape(r.serviceCode),
      escape(r.serviceDate),
      escape(r.startTime),
      escape(r.endTime),
      String(r.units),
      escape(r.authorizationNumber),
    ].join(','),
  );
  return [header, ...lines].join('\r\n');
}

export async function generateClaimBatch(
  tenantId: string,
  generatedByUserId: string,
  filters: ClaimFilters,
): Promise<{ batchId: string; visitCount: number; totalUnits: number; csvContent: string }> {
  const conditions = [
    eq(evvVisits.tenantId, tenantId),
    eq(evvVisits.visitStatus, 'completed'),
    eq(evvVisits.isBillable, true),
    isNull(evvVisits.claimBatchId),
  ];

  // Filter by check-in date in Central Time using UTC-equivalent range (naive: use checkInAt directly)
  // Add 6h buffer for CT offset; precise filtering is done post-query
  const startUtc = new Date(`${filters.dateRangeStart}T00:00:00-06:00`);
  const endUtc = new Date(`${filters.dateRangeEnd}T23:59:59-05:00`);
  conditions.push(gte(evvVisits.checkInAt, startUtc));
  conditions.push(lte(evvVisits.checkInAt, endUtc));

  if (filters.clientId) conditions.push(eq(evvVisits.clientId, filters.clientId));
  if (filters.workerId) conditions.push(eq(evvVisits.workerId, filters.workerId));

  const visitRows = await db
    .select({
      id: evvVisits.id,
      checkInAt: evvVisits.checkInAt,
      checkOutAt: evvVisits.checkOutAt,
      serviceCode: evvVisits.serviceCode,
      billableUnits: evvVisits.billableUnits,
      authorizationId: evvVisits.authorizationId,
      clientId: evvVisits.clientId,
      workerId: evvVisits.workerId,
      clientName: clients.name,
      clientMedicaidId: clients.medicaidId,
      workerName: workers.name,
      workerNpi: workers.npi,
    })
    .from(evvVisits)
    .leftJoin(clients, eq(clients.id, evvVisits.clientId))
    .leftJoin(workers, eq(workers.id, evvVisits.workerId))
    .where(and(...conditions));

  if (visitRows.length === 0) {
    return { batchId: '', visitCount: 0, totalUnits: 0, csvContent: '' };
  }

  // Fetch authorization numbers for visits that have one
  const authIds = [...new Set(visitRows.map((v) => v.authorizationId).filter(Boolean) as string[])];
  const authMap = new Map<string, string>();
  if (authIds.length > 0) {
    const authRows = await db
      .select({ id: serviceAuthorizations.id, payerId: serviceAuthorizations.payerId })
      .from(serviceAuthorizations)
      .where(eq(serviceAuthorizations.tenantId, tenantId));
    for (const a of authRows) {
      authMap.set(a.id, a.payerId);
    }
  }

  const claimRows: ClaimRow[] = visitRows.map((v) => {
    const checkIn = toCentral(v.checkInAt);
    const checkOut = v.checkOutAt ? toCentral(v.checkOutAt) : { date: checkIn.date, time: checkIn.time };
    return {
      patientName: v.clientName ?? '',
      medicaidId: v.clientMedicaidId ?? '',
      caregiverName: v.workerName ?? '',
      caregiverNpi: v.workerNpi ?? '',
      serviceCode: v.serviceCode ?? 'T1019',
      serviceDate: checkIn.date,
      startTime: checkIn.time,
      endTime: checkOut.time,
      units: v.billableUnits ?? 0,
      authorizationNumber: v.authorizationId ? (authMap.get(v.authorizationId) ?? '') : '',
    };
  });

  const csvContent = buildCsv(claimRows);
  const totalUnits = claimRows.reduce((sum, r) => sum + r.units, 0);

  const [batch] = await db
    .insert(claimBatches)
    .values({
      tenantId,
      generatedBy: generatedByUserId,
      visitCount: visitRows.length,
      totalUnits,
      dateRangeStart: filters.dateRangeStart,
      dateRangeEnd: filters.dateRangeEnd,
      csvContent,
      status: 'generated',
    })
    .returning({ id: claimBatches.id });

  // Mark visits as claimed
  for (const v of visitRows) {
    await db
      .update(evvVisits)
      .set({ claimBatchId: batch.id, claimedAt: new Date() })
      .where(eq(evvVisits.id, v.id));
  }

  return { batchId: batch.id, visitCount: visitRows.length, totalUnits, csvContent };
}

export async function listClaimBatches(tenantId: string) {
  return db
    .select({
      id: claimBatches.id,
      visitCount: claimBatches.visitCount,
      totalUnits: claimBatches.totalUnits,
      dateRangeStart: claimBatches.dateRangeStart,
      dateRangeEnd: claimBatches.dateRangeEnd,
      status: claimBatches.status,
      createdAt: claimBatches.createdAt,
    })
    .from(claimBatches)
    .where(eq(claimBatches.tenantId, tenantId))
    .orderBy(claimBatches.createdAt);
}

export async function getClaimBatchCsv(tenantId: string, batchId: string): Promise<string | null> {
  const rows = await db
    .select({ csvContent: claimBatches.csvContent })
    .from(claimBatches)
    .where(and(eq(claimBatches.tenantId, tenantId), eq(claimBatches.id, batchId)))
    .limit(1);
  return rows[0]?.csvContent ?? null;
}
