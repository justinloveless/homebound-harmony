// Helpers shared between the worker-side share manager and the public viewer.

import type { DayOfWeek, WeekSchedule } from '@/types/models';

export interface ShareSnapshot {
  version: 1;
  workerName: string;
  /** Optional mailto:/tel: links the public viewer surfaces. */
  workerContact?: { email?: string; phone?: string };
  client: { name: string; address?: string };
  weekStartDate: string;
  visits: Array<{
    date: string;
    day: DayOfWeek;
    startTime: string;
    endTime: string;
  }>;
}

export function buildSnapshotForClient(args: {
  workerName: string;
  workerContact?: ShareSnapshot['workerContact'];
  clientId: string;
  clientName: string;
  clientAddress?: string;
  schedule: WeekSchedule;
}): ShareSnapshot {
  const visits: ShareSnapshot['visits'] = [];
  for (const day of args.schedule.days) {
    for (const v of day.visits) {
      if (v.clientId === args.clientId) {
        visits.push({
          date: day.date,
          day: day.day,
          startTime: v.startTime,
          endTime: v.endTime,
        });
      }
    }
  }
  return {
    version: 1,
    workerName: args.workerName,
    workerContact: args.workerContact,
    client: { name: args.clientName, address: args.clientAddress },
    weekStartDate: args.schedule.weekStartDate,
    visits,
  };
}
