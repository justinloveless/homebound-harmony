import { Hono } from 'hono';
import { and, eq, sql, desc } from 'drizzle-orm';
import { db } from '../db/client';
import { evvVisits, clients, workers } from '../db/schema';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';
import { requireRole } from '../auth/rbac';
import { bulkValidateCompleted, validateAndSave, type ValidationIssue } from '../services/visitValidation';
import { generateClaimBatch, listClaimBatches, getClaimBatchCsv } from '../services/claimExportService';

const r = new Hono();
r.use('*', requireUser);
r.use('*', requireTenant);
r.use('*', requireRole('admin'));

r.get('/dashboard', async (c) => {
  const tenantId = c.get('tenantId');

  const [summaryRows, pendingRow, visitRows] = await Promise.all([
    db
      .select({
        isBillable: evvVisits.isBillable,
        count: sql<number>`cast(count(*) as int)`,
        totalUnits: sql<number>`cast(coalesce(sum(${evvVisits.billableUnits}), 0) as int)`,
      })
      .from(evvVisits)
      .where(and(eq(evvVisits.tenantId, tenantId), eq(evvVisits.visitStatus, 'completed')))
      .groupBy(evvVisits.isBillable),

    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(evvVisits)
      .where(and(eq(evvVisits.tenantId, tenantId), eq(evvVisits.visitStatus, 'in_progress'))),

    db
      .select({
        id: evvVisits.id,
        checkInAt: evvVisits.checkInAt,
        checkOutAt: evvVisits.checkOutAt,
        visitStatus: evvVisits.visitStatus,
        evvStatus: evvVisits.evvStatus,
        noteStatus: evvVisits.noteStatus,
        isBillable: evvVisits.isBillable,
        billingIssues: evvVisits.billingIssues,
        billableUnits: evvVisits.billableUnits,
        durationMinutes: evvVisits.durationMinutes,
        serviceCode: evvVisits.serviceCode,
        clientName: clients.name,
        workerName: workers.name,
      })
      .from(evvVisits)
      .leftJoin(clients, eq(clients.id, evvVisits.clientId))
      .leftJoin(workers, eq(workers.id, evvVisits.workerId))
      .where(and(eq(evvVisits.tenantId, tenantId), eq(evvVisits.visitStatus, 'completed')))
      .orderBy(desc(evvVisits.checkInAt))
      .limit(100),
  ]);

  const billableRow = summaryRows.find((r) => r.isBillable);
  const notBillableRow = summaryRows.find((r) => !r.isBillable);

  const summary = {
    billable: billableRow?.count ?? 0,
    notBillable: notBillableRow?.count ?? 0,
    pending: pendingRow[0]?.count ?? 0,
    totalUnits: billableRow?.totalUnits ?? 0,
  };

  // Aggregate issue codes from not-billable visits
  const issueBreakdown: Record<string, number> = {};
  for (const v of visitRows) {
    if (!v.isBillable && Array.isArray(v.billingIssues)) {
      for (const issue of v.billingIssues as ValidationIssue[]) {
        issueBreakdown[issue.code] = (issueBreakdown[issue.code] ?? 0) + 1;
      }
    }
  }

  return c.json({ summary, issueBreakdown, visits: visitRows });
});

r.post('/validate', async (c) => {
  const tenantId = c.get('tenantId');
  const body = await c.req.json().catch(() => ({}));
  const visitIds: string[] | undefined = Array.isArray(body?.visitIds) ? body.visitIds : undefined;

  if (visitIds && visitIds.length === 1) {
    const result = await validateAndSave(tenantId, visitIds[0]);
    return c.json({ validated: 1, billable: result.isBillable ? 1 : 0, result });
  }

  const stats = await bulkValidateCompleted(tenantId, visitIds);
  return c.json(stats);
});

r.post('/claims/generate', async (c) => {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));

  const { dateRangeStart, dateRangeEnd, clientId, workerId } = body;
  if (!dateRangeStart || !dateRangeEnd) {
    return c.json({ error: 'dateRangeStart and dateRangeEnd are required' }, 400);
  }

  const result = await generateClaimBatch(tenantId, userId, {
    dateRangeStart,
    dateRangeEnd,
    clientId: clientId ?? undefined,
    workerId: workerId ?? undefined,
  });

  if (result.visitCount === 0) {
    return c.json({ error: 'No billable visits found for the selected range' }, 404);
  }

  return c.json({ batchId: result.batchId, visitCount: result.visitCount, totalUnits: result.totalUnits });
});

r.get('/claims', async (c) => {
  const tenantId = c.get('tenantId');
  const batches = await listClaimBatches(tenantId);
  return c.json({ batches });
});

r.get('/claims/:id/csv', async (c) => {
  const tenantId = c.get('tenantId');
  const batchId = c.req.param('id');
  const csv = await getClaimBatchCsv(tenantId, batchId);
  if (!csv) return c.json({ error: 'Not found' }, 404);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="claims-${batchId.slice(0, 8)}.csv"`,
    },
  });
});

export { r as billingRouter };
