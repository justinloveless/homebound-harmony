import { describe, expect, it } from 'vitest';
import { generateWeekSchedule } from '@/lib/scheduler';
import type { Client, WorkerProfile, TravelTimeMatrix } from '@/types/models';

function baseWorker(overrides: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    name: 'Care Worker',
    homeAddress: '100 Main St',
    workingHours: { startTime: '08:00', endTime: '17:00' },
    daysOff: ['saturday', 'sunday'],
    makeUpDays: [],
    breaks: [],
    schedulingStrategy: 'spread',
    ...overrides,
  };
}

describe('generateWeekSchedule', () => {
  it('skips make-up weekdays for automatic placement', () => {
    const worker = baseWorker({ makeUpDays: ['monday'] });
    const client: Client = {
      id: 'c1',
      name: 'Client',
      address: '1 St',
      visitDurationMinutes: 60,
      visitsPerPeriod: 1,
      period: 'week',
      priority: 'medium',
      timeWindows: [{ day: 'monday', startTime: '09:00', endTime: '12:00' }],
      notes: '',
    };
    const travel: TravelTimeMatrix = {};
    const schedule = generateWeekSchedule(worker, [client], travel, '2026-05-04');
    expect(schedule.days.some(d => d.day === 'monday')).toBe(false);
    expect(schedule.unmetVisits?.some(u => u.clientId === 'c1')).toBe(true);
  });

  it('still places visits on regular working days when make-up is another weekday', () => {
    const worker = baseWorker({ makeUpDays: ['friday'] });
    const client: Client = {
      id: 'c1',
      name: 'Client',
      address: '1 St',
      visitDurationMinutes: 60,
      visitsPerPeriod: 1,
      period: 'week',
      priority: 'medium',
      timeWindows: [{ day: 'monday', startTime: '09:00', endTime: '12:00' }],
      notes: '',
    };
    const schedule = generateWeekSchedule(worker, [client], {}, '2026-05-04');
    expect(schedule.days.some(d => d.day === 'monday')).toBe(true);
    expect(schedule.days.some(d => d.day === 'friday')).toBe(false);
  });
});
