import { eventSource } from './api';

export interface EventStreamMessage {
  seq: number;
}

/** SSE subscription; invalidates workspace queries via `invalidateWorkspaceQueries` in callers. */
export function subscribeEventStream(onUpdate: (msg: EventStreamMessage) => void): () => void {
  const es = eventSource('/api/events/stream');
  const handler = (ev: MessageEvent) => {
    try {
      onUpdate(JSON.parse(ev.data) as EventStreamMessage);
    } catch {
      /* ignore */
    }
  };
  es.addEventListener('update', handler as EventListener);
  return () => {
    es.removeEventListener('update', handler as EventListener);
    es.close();
  };
}
