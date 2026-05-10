import { and, asc, count, eq, lt } from 'drizzle-orm';
import { db } from '../db/client';
import { domainEvents } from '../db/schema';
import {
  applyDomainEventRow,
  DEFAULT_WORKSPACE,
  migrateWorkspace,
  replayWorkspaceFromEvents,
} from './workspaceReplay';
import { diffJsonValues, truncateDiffEntries, type PayloadDiffEntry } from './jsonValueDiff';
import type { Workspace } from './workspaceReplayTypes';

const MAX_PRIOR_EVENTS = 5000;
const MAX_DIFF_LINES = 400;

export type DomainEventDiffResult = {
  entries: PayloadDiffEntry[];
  replayEventCount?: number;
  replaySkipped?: boolean;
  replaySkipReason?: string;
  truncated?: boolean;
};

function projectBeforeAfter(
  kind: string,
  before: Workspace,
  after: Workspace,
  payload: unknown,
): { before: unknown; after: unknown } | null | 'workspace_import' {
  switch (kind) {
    case 'client_updated': {
      const id = (payload as { id?: string })?.id;
      if (!id) return { before: null, after: null };
      return {
        before: before.clients.find((c) => c.id === id) ?? null,
        after: after.clients.find((c) => c.id === id) ?? null,
      };
    }
    case 'client_added': {
      const id = (payload as { id?: string })?.id;
      return { before: null, after: id ? (after.clients.find((c) => c.id === id) ?? payload) : payload };
    }
    case 'client_removed': {
      const id = (payload as { id?: string })?.id;
      if (!id) return { before: null, after: null };
      return { before: before.clients.find((c) => c.id === id) ?? null, after: null };
    }
    case 'clients_set':
      return { before: before.clients, after: after.clients };
    case 'worker_updated':
      return { before: before.worker, after: payload };
    case 'travel_times_set':
      return { before: before.travelTimes, after: after.travelTimes };
    case 'travel_time_errors_set':
      return { before: before.travelTimeErrors ?? {}, after: after.travelTimeErrors ?? {} };
    case 'schedule_set':
      return { before: before.lastSchedule, after: after.lastSchedule };
    case 'saved_schedule_added':
      return { before: null, after: payload };
    case 'saved_schedule_loaded':
      return { before: before.lastSchedule, after: after.lastSchedule };
    case 'saved_schedule_removed': {
      const id = (payload as { id?: string })?.id;
      const removed = before.savedSchedules?.find((s) => s.id === id);
      return { before: removed ?? null, after: null };
    }
    case 'saved_schedule_renamed': {
      const id = (payload as { id?: string })?.id;
      const name = (payload as { name?: string })?.name;
      const prev = before.savedSchedules?.find((s) => s.id === id);
      return { before: prev?.name ?? null, after: name ?? null };
    }
    case 'workspace_imported':
      return 'workspace_import';
    default:
      return { before: null, after: payload };
  }
}

export async function computeDomainEventPayloadDiff(params: {
  tenantId: string;
  targetSeq: number;
  kind: string;
  payload: unknown;
}): Promise<DomainEventDiffResult> {
  const [countRow] = await db
    .select({ c: count() })
    .from(domainEvents)
    .where(and(eq(domainEvents.tenantId, params.tenantId), lt(domainEvents.seq, params.targetSeq)));
  const priorCount = Number(countRow?.c ?? 0);
  if (priorCount > MAX_PRIOR_EVENTS) {
    return {
      entries: [],
      replaySkipped: true,
      replaySkipReason: `More than ${MAX_PRIOR_EVENTS} prior events for this tenant; automatic field-by-field diff is disabled.`,
    };
  }

  const priorRows = await db
    .select({ kind: domainEvents.kind, payload: domainEvents.payload })
    .from(domainEvents)
    .where(and(eq(domainEvents.tenantId, params.tenantId), lt(domainEvents.seq, params.targetSeq)))
    .orderBy(asc(domainEvents.seq));

  const initial = migrateWorkspace(structuredClone(DEFAULT_WORKSPACE));
  const stateBefore = replayWorkspaceFromEvents(initial, priorRows);

  const stateAfter = applyDomainEventRow(structuredClone(stateBefore), {
    kind: params.kind,
    payload: params.payload,
  });

  const proj = projectBeforeAfter(params.kind, stateBefore, stateAfter, params.payload);
  if (proj === 'workspace_import') {
    return {
      entries: [
        {
          path: 'workspace',
          kind: 'change',
          before: '(prior workspace from replay — not shown in full)',
          after: '(imported workspace — details hidden)',
        },
      ],
      replayEventCount: priorRows.length,
    };
  }
  if (proj === null) {
    return { entries: [], replayEventCount: priorRows.length };
  }

  const raw = diffJsonValues(proj.before, proj.after, '');
  const { entries, truncated } = truncateDiffEntries(raw, MAX_DIFF_LINES);
  return {
    entries,
    replayEventCount: priorRows.length,
    truncated,
  };
}
