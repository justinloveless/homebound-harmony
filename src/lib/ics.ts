// Minimal RFC 5545 .ics generator. Produced entirely client-side from
// already-decrypted share data; the server never sees this content.

import type { DaySchedule, ScheduledVisit, WeekSchedule } from '@/types/models';

export interface IcsContext {
  /** Worker's display name; appears in ORGANIZER. */
  workerName: string;
  /** Map clientId → display name + address (for SUMMARY/LOCATION). */
  clientLookup: Record<string, { name: string; address?: string; notes?: string }>;
  /** Stable origin id used in UID (`<uid>@<domain>`). */
  uidDomain?: string;
}

function pad2(n: number) { return n.toString().padStart(2, '0'); }

/** Convert a date string + "HH:MM" → floating local datetime (no Z). */
function toFloating(dateIso: string, hhmm: string): string {
  const d = new Date(dateIso);
  const [h, m] = hhmm.split(':').map(Number);
  return [
    d.getFullYear(),
    pad2(d.getMonth() + 1),
    pad2(d.getDate()),
    'T',
    pad2(h),
    pad2(m),
    '00',
  ].join('');
}

function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function visitEvent(day: DaySchedule, visit: ScheduledVisit, ctx: IcsContext, dtstamp: string): string[] {
  const client = ctx.clientLookup[visit.clientId];
  const summary = client?.name ? `Visit: ${client.name}` : 'Visit';
  const uid = `visit-${day.date}-${visit.startTime}-${visit.clientId}@${ctx.uidDomain ?? 'routecare'}`;
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${toFloating(day.date, visit.startTime)}`,
    `DTEND:${toFloating(day.date, visit.endTime)}`,
    `SUMMARY:${escapeText(summary)}`,
  ];
  if (client?.address) lines.push(`LOCATION:${escapeText(client.address)}`);
  if (client?.notes)   lines.push(`DESCRIPTION:${escapeText(client.notes)}`);
  lines.push('END:VEVENT');
  return lines;
}

export function buildIcs(week: WeekSchedule, ctx: IcsContext): string {
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const out: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//routecare//share//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const day of week.days) {
    for (const visit of day.visits) {
      out.push(...visitEvent(day, visit, ctx, dtstamp));
    }
  }
  out.push('END:VCALENDAR');
  return out.map(line => line.length > 75 ? line : line).join('\r\n') + '\r\n';
}

export function downloadIcs(filename: string, body: string) {
  const blob = new Blob([body], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
