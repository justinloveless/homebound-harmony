import { sql } from 'drizzle-orm';
import { domainEvents } from '../db/schema';

/**
 * Short human-readable summary for admin domain event lists.
 * Built in SQL so large payloads (e.g. workspace_imported) are not fully transferred.
 */
export const domainEventListSummary = sql<string>`(
  CASE ${domainEvents.kind}
    WHEN 'client_added' THEN CONCAT(
      'Added client: ',
      COALESCE(${domainEvents.payload}->>'name', ${domainEvents.payload}->>'id', '(unknown)')
    )
    WHEN 'client_updated' THEN CONCAT(
      'Updated client: ',
      COALESCE(${domainEvents.payload}->>'name', ${domainEvents.payload}->>'id', '(unknown)')
    )
    WHEN 'client_removed' THEN CONCAT(
      'Removed client: ',
      COALESCE(${domainEvents.payload}->>'id', '(unknown)')
    )
    WHEN 'clients_set' THEN CONCAT(
      'Roster replaced: ',
      CASE
        WHEN jsonb_typeof(${domainEvents.payload}) = 'array'
        THEN jsonb_array_length(${domainEvents.payload})::text
        ELSE '?'
      END,
      ' client(s)'
    )
    WHEN 'worker_updated' THEN 'Worker / territory settings updated'
    WHEN 'travel_times_set' THEN 'Travel times matrix updated'
    WHEN 'travel_time_errors_set' THEN 'Travel time errors updated'
    WHEN 'schedule_set' THEN 'Weekly schedule updated'
    WHEN 'saved_schedule_added' THEN CONCAT(
      'Saved schedule added: ',
      COALESCE(${domainEvents.payload}->>'name', ${domainEvents.payload}->>'id', '?')
    )
    WHEN 'saved_schedule_loaded' THEN CONCAT(
      'Saved schedule loaded: ',
      COALESCE(${domainEvents.payload}->>'id', '?')
    )
    WHEN 'saved_schedule_removed' THEN CONCAT(
      'Saved schedule removed: ',
      COALESCE(${domainEvents.payload}->>'id', '?')
    )
    WHEN 'saved_schedule_renamed' THEN CONCAT(
      'Saved schedule renamed: ',
      COALESCE(${domainEvents.payload}->>'name', '?')
    )
    WHEN 'workspace_imported' THEN 'Workspace imported (full snapshot)'
    WHEN 'share_create' THEN CONCAT(
      'Share link created: ',
      COALESCE(${domainEvents.payload}->>'artifactId', '?')
    )
    WHEN 'visit_started' THEN CONCAT(
      'Visit started — client ',
      COALESCE(${domainEvents.payload}->>'clientId', '?'),
      ' (',
      COALESCE(${domainEvents.payload}->>'dayDate', '?'),
      ')'
    )
    WHEN 'visit_completed' THEN CONCAT(
      'Visit completed — client ',
      COALESCE(${domainEvents.payload}->>'clientId', '?'),
      ' (',
      COALESCE(${domainEvents.payload}->>'dayDate', '?'),
      ')'
    )
    WHEN 'visit_note_added' THEN CONCAT(
      'Visit note — client ',
      COALESCE(${domainEvents.payload}->>'clientId', '?'),
      ' (',
      COALESCE(${domainEvents.payload}->>'dayDate', '?'),
      ')'
    )
    ELSE ${domainEvents.kind}
  END
)`.as('summary');

export const CLIENT_DATA_EVENT_KINDS = [
  'client_added',
  'client_updated',
  'client_removed',
  'clients_set',
] as const;
