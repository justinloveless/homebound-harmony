import { describe, expect, test } from 'vitest';
import { applyEvent, replayEvents, recalcTravelTimes } from '@/lib/events';
import { DEFAULT_WORKSPACE, type Client, type WeekSchedule } from '@/types/models';
import type { Event } from '@/types/events';

const sampleClient: Client = {
  id: 'c1',
  name: 'Alice',
  address: '1 Main',
  visitDurationMinutes: 60,
  visitsPerPeriod: 1,
  period: 'week',
  priority: 'medium',
  timeWindows: [],
  notes: '',
};

describe('applyEvent', () => {
  test('worker_updated recalculates travel matrix keys', () => {
    const ev: Event = {
      clientEventId: '1',
      kind: 'worker_updated',
      payload: {
        ...DEFAULT_WORKSPACE.worker,
        homeCoords: { lat: 40, lon: -74 },
      },
      claimedAt: new Date().toISOString(),
    };
    const next = applyEvent(
      { ...DEFAULT_WORKSPACE, clients: [{ ...sampleClient, coords: { lat: 40.1, lon: -74.1 } }] },
      ev,
    );
    expect(next.worker.homeCoords).toEqual({ lat: 40, lon: -74 });
    const keys = Object.keys(next.travelTimes);
    expect(keys.some(k => k.includes('home') && k.includes('c1'))).toBe(true);
  });

  test('clients_set', () => {
    const ev: Event = {
      clientEventId: 'cs',
      kind: 'clients_set',
      payload: [sampleClient],
      claimedAt: new Date().toISOString(),
    };
    const next = applyEvent(DEFAULT_WORKSPACE, ev);
    expect(next.clients).toHaveLength(1);
  });

  test('client_added', () => {
    const ev: Event = {
      clientEventId: '2',
      kind: 'client_added',
      payload: sampleClient,
      claimedAt: new Date().toISOString(),
    };
    const next = applyEvent(DEFAULT_WORKSPACE, ev);
    expect(next.clients).toHaveLength(1);
    expect(next.clients[0].id).toBe('c1');
  });

  test('client_updated', () => {
    const ws = { ...DEFAULT_WORKSPACE, clients: [sampleClient] };
    const ev: Event = {
      clientEventId: '3',
      kind: 'client_updated',
      payload: { ...sampleClient, name: 'Bob' },
      claimedAt: new Date().toISOString(),
    };
    const next = applyEvent(ws, ev);
    expect(next.clients[0].name).toBe('Bob');
  });

  test('client_removed', () => {
    const ws = { ...DEFAULT_WORKSPACE, clients: [sampleClient] };
    const ev: Event = {
      clientEventId: '4',
      kind: 'client_removed',
      payload: { id: 'c1' },
      claimedAt: new Date().toISOString(),
    };
    const next = applyEvent(ws, ev);
    expect(next.clients).toHaveLength(0);
  });

  test('schedule_set', () => {
    const sched: WeekSchedule = {
      weekStartDate: '2026-01-05',
      days: [],
      totalTravelMinutes: 0,
      totalTimeAwayMinutes: 0,
    };
    const ev: Event = {
      clientEventId: '5',
      kind: 'schedule_set',
      payload: sched,
      claimedAt: new Date().toISOString(),
    };
    const next = applyEvent(DEFAULT_WORKSPACE, ev);
    expect(next.lastSchedule).toEqual(sched);
  });

  test('workspace_imported replaces state', () => {
    const imported = {
      ...DEFAULT_WORKSPACE,
      worker: { ...DEFAULT_WORKSPACE.worker, name: 'Imported' },
    };
    const ev: Event = {
      clientEventId: '6',
      kind: 'workspace_imported',
      payload: imported,
      claimedAt: new Date().toISOString(),
    };
    const next = applyEvent({ ...DEFAULT_WORKSPACE, clients: [sampleClient] }, ev);
    expect(next.worker.name).toBe('Imported');
    expect(next.clients).toHaveLength(0);
  });

  test('visit_* is no-op on workspace', () => {
    const ws = { ...DEFAULT_WORKSPACE, clients: [sampleClient] };
    const ev: Event = {
      clientEventId: '7',
      kind: 'visit_started',
      payload: {
        dayDate: '2026-01-06',
        visitIndex: 0,
        clientId: 'c1',
        verifiedArrival: true,
        checkedInAt: new Date().toISOString(),
      },
      claimedAt: new Date().toISOString(),
    };
    expect(applyEvent(ws, ev)).toEqual(ws);
  });
});

describe('replayEvents', () => {
  test('chains events', () => {
    const e1: Event = {
      clientEventId: 'a',
      kind: 'client_added',
      payload: sampleClient,
      claimedAt: '2026-01-01T00:00:00Z',
    };
    const e2: Event = {
      clientEventId: 'b',
      kind: 'client_updated',
      payload: { ...sampleClient, name: 'Zed' },
      claimedAt: '2026-01-01T00:01:00Z',
    };
    const out = replayEvents(DEFAULT_WORKSPACE, [e1, e2]);
    expect(out.clients[0].name).toBe('Zed');
  });
});

describe('recalcTravelTimes', () => {
  test('empty when no coords', () => {
    const m = recalcTravelTimes(DEFAULT_WORKSPACE);
    expect(Object.keys(m).length).toBe(0);
  });
});
