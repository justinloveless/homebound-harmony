/** Shared SSE fan-out for tenant-scoped domain events (avoid circular imports). */
const sseEventConnections = new Map<string, Set<(msg: { seq: number }) => void>>();

export function notifyDomainEventAppend(tenantId: string, seq: number) {
  const conns = sseEventConnections.get(tenantId);
  if (conns) for (const send of conns) send({ seq });
}

export function subscribeTenantEventSends(tenantId: string, send: (msg: { seq: number }) => void): () => void {
  if (!sseEventConnections.has(tenantId)) sseEventConnections.set(tenantId, new Set());
  sseEventConnections.get(tenantId)!.add(send);
  return () => {
    sseEventConnections.get(tenantId)?.delete(send);
  };
}
