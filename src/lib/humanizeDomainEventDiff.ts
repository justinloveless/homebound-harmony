/**
 * Turns structured diff entries into plain-language lines for the admin audit UI.
 */

export type DiffKind = 'add' | 'remove' | 'change';

export interface PayloadDiffEntry {
  path: string;
  kind: DiffKind;
  before?: unknown;
  after?: unknown;
}

const KIND_LABELS: Record<string, string> = {
  client_added: 'New client added',
  client_updated: 'Client information updated',
  client_removed: 'Client removed from roster',
  clients_set: 'Client list replaced',
  worker_updated: 'Caregiver / territory settings updated',
  travel_times_set: 'Drive times between stops updated',
  travel_time_errors_set: 'Drive time warnings updated',
  schedule_set: 'Weekly schedule updated',
  saved_schedule_added: 'Saved schedule added',
  saved_schedule_loaded: 'A saved schedule was opened as the active week',
  saved_schedule_removed: 'Saved schedule deleted',
  saved_schedule_renamed: 'Saved schedule renamed',
  workspace_imported: 'Workspace imported from a file',
  share_create: 'Share link created',
  visit_started: 'Visit started',
  visit_completed: 'Visit completed',
  visit_note_added: 'Visit note added',
  visit_note: 'Visit note added',
};

/** Short label for the event type row in the dialog. */
export function humanizeEventKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');
}

const FIELD_LABELS: Record<string, string> = {
  lat: 'Latitude',
  lon: 'Longitude',
  start: 'Start',
  end: 'End',
  name: 'Name',
  address: 'Address',
  coords: 'Location on map (GPS)',
  visitDurationMinutes: 'Visit length (minutes)',
  visitsPerPeriod: 'Visits per period',
  period: 'How often visits repeat',
  priority: 'Priority',
  notes: 'Notes',
  excludedFromSchedule: 'Left off automatic schedules',
  timeWindows: 'Preferred visit time windows',
  homeAddress: 'Home address',
  homeCoords: 'Home location on map',
  workingHours: 'Working hours',
  daysOff: 'Days off',
  makeUpDays: 'Make-up days',
  breaks: 'Breaks during the day',
  schedulingStrategy: 'Scheduling style',
  weekStartDate: 'Week starting',
  totalTravelMinutes: 'Total travel time (minutes)',
  totalTimeAwayMinutes: 'Total time away (minutes)',
  clientGroups: 'Client groups for scheduling',
  unmetVisits: 'Visits that could not be placed',
  recommendedDrops: 'Suggested removals to fit the schedule',
  day: 'Day of week',
  date: 'Calendar date',
  leaveHomeTime: 'Leave home at',
  arriveHomeTime: 'Arrive home at',
  visits: 'Visits that day',
  clientId: 'Client',
  startTime: 'Start time',
  endTime: 'End time',
  travelTimeFromPrev: 'Drive time from previous stop (minutes)',
  travelDistanceMiFromPrev: 'Drive distance from previous stop (miles)',
  manuallyPlaced: 'Placed manually on the calendar',
  savedName: 'Saved name',
  savedAt: 'Saved at',
  artifactId: 'Share link id',
  scheduleVisitId: 'Visit record',
  note: 'Note text',
  id: 'Record id',
};

const MAX_VAL = 160;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCompositeValue(v: unknown): boolean {
  return Array.isArray(v) || isPlainRecord(v);
}

function appendPath(basePath: string, segment: string): string {
  if (!basePath || basePath === '.') return segment;
  if (segment.startsWith('[')) return `${basePath}${segment}`;
  return `${basePath}.${segment}`;
}

function looksLikeSerializedJson(text: string): boolean {
  const first = text[0];
  if (first !== '{' && first !== '[') return false;

  try {
    JSON.parse(text);
    return true;
  } catch {
    return text.includes('chars JSON') || text.includes('longer data hidden');
  }
}

function flattenCompositeValue(value: unknown, basePath: string, kind: DiffKind): PayloadDiffEntry[] {
  if (!isCompositeValue(value)) {
    return kind === 'remove'
      ? [{ path: basePath || '.', kind, before: value }]
      : [{ path: basePath || '.', kind, after: value }];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return kind === 'remove'
        ? [{ path: basePath || '.', kind, before: 'empty list' }]
        : [{ path: basePath || '.', kind, after: 'empty list' }];
    }
    return value.flatMap((item, index) => flattenCompositeValue(item, appendPath(basePath, `[${index}]`), kind));
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    return kind === 'remove'
      ? [{ path: basePath || '.', kind, before: 'no fields' }]
      : [{ path: basePath || '.', kind, after: 'no fields' }];
  }

  return keys.flatMap((key) => flattenCompositeValue(value[key], appendPath(basePath, key), kind));
}

function expandCompositeChange(entry: PayloadDiffEntry): PayloadDiffEntry[] {
  const beforeIsComposite = isCompositeValue(entry.before);
  const afterIsComposite = isCompositeValue(entry.after);

  if (!beforeIsComposite && !afterIsComposite) return [entry];

  if ((entry.before == null || entry.before === undefined) && afterIsComposite) {
    return flattenCompositeValue(entry.after, entry.path, 'add');
  }

  if (beforeIsComposite && (entry.after == null || entry.after === undefined)) {
    return flattenCompositeValue(entry.before, entry.path, 'remove');
  }

  if (beforeIsComposite && afterIsComposite) {
    const before = Array.isArray(entry.before)
      ? Object.fromEntries(entry.before.map((value, index) => [`[${index}]`, value]))
      : entry.before;
    const after = Array.isArray(entry.after)
      ? Object.fromEntries(entry.after.map((value, index) => [`[${index}]`, value]))
      : entry.after;
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
    const expanded: PayloadDiffEntry[] = [];

    for (const key of keys) {
      const path = key.startsWith('[') ? appendPath(entry.path, key) : appendPath(entry.path, key);
      if (!(key in beforeRecord)) {
        expanded.push(...flattenCompositeValue(afterRecord[key], path, 'add'));
      } else if (!(key in afterRecord)) {
        expanded.push(...flattenCompositeValue(beforeRecord[key], path, 'remove'));
      } else if (isCompositeValue(beforeRecord[key]) || isCompositeValue(afterRecord[key])) {
        expanded.push(...expandCompositeChange({ path, kind: 'change', before: beforeRecord[key], after: afterRecord[key] }));
      } else if (beforeRecord[key] !== afterRecord[key]) {
        expanded.push({ path, kind: 'change', before: beforeRecord[key], after: afterRecord[key] });
      }
    }

    return expanded.length ? expanded : [entry];
  }

  return [entry];
}

export function expandPayloadDiffEntries(entries: PayloadDiffEntry[]): PayloadDiffEntry[] {
  return entries.flatMap(expandCompositeChange);
}

export function formatDisplayValue(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'none';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t.length) return '(empty)';
    if (looksLikeSerializedJson(t)) return '(structured data hidden)';
    if (t.length <= MAX_VAL) return t;
    return `${t.slice(0, MAX_VAL)}…`;
  }
  if (Array.isArray(v)) {
    return v.length === 1 ? '1 item' : `${v.length} items`;
  }
  if (isPlainRecord(v)) {
    const keys = Object.keys(v);
    return keys.length === 1 ? '1 field' : `${keys.length} fields`;
  }
  return '(could not display)';
}

function lastPathSegment(path: string): string {
  const parts = path.split('.');
  return parts[parts.length - 1] ?? path;
}

function labelFromPath(path: string, eventKind?: string): string {
  if (!path || path === '.') return 'Record';

  const tailSeg = lastPathSegment(path).replace(/\[\d+\]/g, '');

  if (
    (eventKind === 'client_updated' || eventKind === 'client_added') &&
    !path.includes('clients[') &&
    FIELD_LABELS[tailSeg]
  ) {
    return `Client — ${FIELD_LABELS[tailSeg]}`;
  }
  if (eventKind === 'worker_updated' && FIELD_LABELS[tailSeg] && !path.startsWith('worker.')) {
    return `Caregiver / territory — ${FIELD_LABELS[tailSeg]}`;
  }
  if (eventKind === 'schedule_set' && FIELD_LABELS[tailSeg] && !path.startsWith('days[')) {
    return `Schedule — ${FIELD_LABELS[tailSeg]}`;
  }

  const clientsMatch = path.match(/clients\[id:([^[\]]+)\]/);
  if (clientsMatch) {
    const tail = path.slice(path.indexOf(']') + 1).replace(/^\./, '');
    if (!tail) return 'This client (roster entry)';
    const seg = lastPathSegment(tail).replace(/\[\d+\]/g, '');
    const base = FIELD_LABELS[seg] ?? seg.replace(/_/g, ' ');
    return `Client — ${base}`;
  }

  if (path.includes('|') && !path.includes('.')) {
    return eventKind === 'travel_time_errors_set'
      ? 'Drive route warning'
      : 'Drive time between two stops (minutes)';
  }

  const seg = lastPathSegment(path).replace(/\[\d+\]/g, '');
  if (FIELD_LABELS[seg]) {
    if (path.includes('timeWindows'))
      return `Client — ${FIELD_LABELS[seg]}`;
    return FIELD_LABELS[seg];
  }

  if (path.startsWith('worker.')) {
    const sub = path.slice('worker.'.length);
    const s = lastPathSegment(sub).replace(/\[\d+\]/g, '');
    return `Caregiver / territory — ${FIELD_LABELS[s] ?? s.replace(/_/g, ' ')}`;
  }

  const daysMatch = path.match(/^days\[(\d+)\]\.?(.*)$/);
  if (daysMatch) {
    const rest = daysMatch[2] ?? '';
    const s = lastPathSegment(rest || path).replace(/\[\d+\]/g, '');
    return `Schedule — day ${Number(daysMatch[1]) + 1} — ${FIELD_LABELS[s] ?? s.replace(/_/g, ' ')}`;
  }

  return FIELD_LABELS[seg] ?? path.replace(/\./g, ' → ').replace(/_/g, ' ');
}

export function diffEntryToSentence(entry: PayloadDiffEntry, eventKind?: string): string {
  const label = labelFromPath(entry.path, eventKind);
  const before = formatDisplayValue(entry.before);
  const after = formatDisplayValue(entry.after);

  if (entry.kind === 'add') {
    if (after === '(empty)' || after === 'none') return `${label}: set.`;
    return `${label}: ${after}.`;
  }
  if (entry.kind === 'remove') {
    return `${label}: removed (was: ${before || '—'}).`;
  }
  if (before === after) return `${label}: updated.`;
  return `${label} changed from "${before}" to "${after}".`;
}

export function changeVerb(kind: DiffKind): string {
  if (kind === 'add') return 'Added';
  if (kind === 'remove') return 'Removed';
  return 'Updated';
}
