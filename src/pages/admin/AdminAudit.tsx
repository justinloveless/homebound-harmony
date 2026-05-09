/**
 * Platform admin: audit log + domain events (plaintext payloads).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AdminGate } from '@/components/AdminGate';
import { toast } from 'sonner';

interface AuditRow {
  id: string;
  action: string;
  occurredAt: string;
  userId: string | null;
  userEmail: string | null;
  artifactId: string | null;
  userAgent: string | null;
  hasIpHash: boolean;
}

interface DomainEventRow {
  id: string;
  tenantId: string;
  seq: number | bigint;
  kind: string;
  /** Human-readable description derived from kind + payload (server-side). */
  summary: string;
  clientEventId: string;
  serverReceivedAt: string;
  clientClaimedAt: string;
  isClinical: boolean;
  authorUserId: string;
  authorEmail: string | null;
  hasGps: boolean;
}

interface DomainEventDetail {
  id: string;
  tenantId: string;
  seq: number | bigint;
  kind: string;
  payload: unknown;
  serverReceivedAt: string;
  clientClaimedAt: string;
  isClinical: boolean;
  authorUserId: string;
  authorEmail: string | null;
}

const PAGE_OPTIONS = [25, 50, 100, 200] as const;

export default function AdminAuditPage() {
  const [userId, setUserId] = useState('');
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLimit, setAuditLimit] = useState<number>(50);
  const [auditOffset, setAuditOffset] = useState(0);

  const [tenantFilter, setTenantFilter] = useState('');
  const [authorUserIdFilter, setAuthorUserIdFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [clientDataOnly, setClientDataOnly] = useState(false);
  const [domainRows, setDomainRows] = useState<DomainEventRow[]>([]);
  const [domainTotal, setDomainTotal] = useState(0);
  const [domainLimit, setDomainLimit] = useState<number>(50);
  const [domainOffset, setDomainOffset] = useState(0);

  const [detail, setDetail] = useState<DomainEventDetail | null>(null);

  const loadAudit = useCallback(async () => {
    const qs = new URLSearchParams({
      limit: String(auditLimit),
      offset: String(auditOffset),
    });
    if (userId.trim()) qs.set('userId', userId.trim());
    const res = await api.get<{ total: number; events: AuditRow[] }>(`/api/admin/audit?${qs}`);
    setAuditTotal(res.total);
    setAuditRows(res.events);
  }, [auditLimit, auditOffset, userId]);

  const loadDomain = useCallback(
    async (opts?: { resetPage?: boolean }) => {
      const offset = opts?.resetPage ? 0 : domainOffset;
      if (opts?.resetPage) setDomainOffset(0);
      const qs = new URLSearchParams({
        limit: String(domainLimit),
        offset: String(offset),
      });
      if (tenantFilter.trim()) qs.set('tenantId', tenantFilter.trim());
      if (authorUserIdFilter.trim()) qs.set('authorUserId', authorUserIdFilter.trim());
      if (kindFilter.trim()) qs.set('kind', kindFilter.trim());
      if (clientDataOnly) qs.set('clientDataOnly', 'true');
      const res = await api.get<{ total: number; events: DomainEventRow[] }>(`/api/admin/domain-events?${qs}`);
      setDomainTotal(res.total);
      setDomainRows(res.events);
    },
    [domainLimit, domainOffset, tenantFilter, authorUserIdFilter, kindFilter, clientDataOnly],
  );

  useEffect(() => {
    void loadAudit().catch(() => toast.error('Could not load audit log'));
  }, [loadAudit]);

  useEffect(() => {
    void loadDomain().catch(() => toast.error('Could not load domain events'));
  }, [loadDomain]);

  const openDetail = async (id: string) => {
    try {
      const res = await api.get<{ event: DomainEventDetail }>(`/api/admin/domain-events/${id}`);
      setDetail(res.event);
    } catch {
      toast.error('Could not load event');
    }
  };

  return (
    <AdminGate>
      <div className="space-y-8 max-w-5xl">
        <h1 className="text-2xl font-bold">Audit</h1>

        <Card>
          <CardHeader>
            <CardTitle>Audit log</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2 flex-wrap items-end">
              <div>
                <label className="text-xs text-muted-foreground">Filter by user id</label>
                <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="uuid" />
              </div>
              <Button type="button" onClick={() => void loadAudit()}>
                Apply
              </Button>
              <div>
                <label className="text-xs text-muted-foreground">Page size</label>
                <select
                  className="border rounded px-2 py-2 text-sm"
                  value={auditLimit}
                  onChange={(e) => setAuditLimit(Number(e.target.value))}
                >
                  {PAGE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={auditOffset === 0}
                onClick={() => setAuditOffset((o) => Math.max(0, o - auditLimit))}
              >
                Prev
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={auditOffset + auditLimit >= auditTotal}
                onClick={() => setAuditOffset((o) => o + auditLimit)}
              >
                Next
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Security and admin actions (sign-in, MFA, share links, admin views). Client roster edits and visits
              appear under Domain events below, not here.
            </p>
            <p className="text-xs text-muted-foreground">
              Total {auditTotal}. Showing {auditRows.length} rows.
            </p>
            <div className="overflow-x-auto text-sm border rounded-md">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-2">Time</th>
                    <th className="text-left p-2">Action</th>
                    <th className="text-left p-2">User</th>
                    <th className="text-left p-2">Artifact / target</th>
                  </tr>
                </thead>
                <tbody>
                  {auditRows.map((r) => (
                    <tr key={r.id} className="border-b">
                      <td className="p-2 whitespace-nowrap">{new Date(r.occurredAt).toLocaleString()}</td>
                      <td className="p-2">{r.action}</td>
                      <td className="p-2">{r.userEmail ?? r.userId ?? '—'}</td>
                      <td className="p-2 font-mono text-xs max-w-[14rem] truncate" title={r.artifactId ?? undefined}>
                        {r.artifactId ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Domain events</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Workspace changes synced from the app (clients, schedules, visits, etc.). Turn on &quot;Client data
              only&quot; or filter by author to see who changed roster or client records.
            </p>
            <div className="flex gap-2 flex-wrap items-end">
              <div>
                <label className="text-xs text-muted-foreground">Tenant id</label>
                <Input
                  value={tenantFilter}
                  onChange={(e) => setTenantFilter(e.target.value)}
                  placeholder="uuid"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Author user id</label>
                <Input
                  value={authorUserIdFilter}
                  onChange={(e) => setAuthorUserIdFilter(e.target.value)}
                  placeholder="uuid"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Event kind (exact)</label>
                <Input
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value)}
                  placeholder="e.g. client_updated"
                />
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={clientDataOnly}
                  onChange={(e) => setClientDataOnly(e.target.checked)}
                />
                Client data only
              </label>
              <Button type="button" onClick={() => void loadDomain({ resetPage: true })}>
                Apply
              </Button>
              <div>
                <label className="text-xs text-muted-foreground">Page size</label>
                <select
                  className="border rounded px-2 py-2 text-sm"
                  value={domainLimit}
                  onChange={(e) => setDomainLimit(Number(e.target.value))}
                >
                  {PAGE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={domainOffset === 0}
                onClick={() => setDomainOffset((o) => Math.max(0, o - domainLimit))}
              >
                Prev
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={domainOffset + domainLimit >= domainTotal}
                onClick={() => setDomainOffset((o) => o + domainLimit)}
              >
                Next
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Total {domainTotal}. Showing {domainRows.length} rows.
            </p>
            <div className="overflow-x-auto text-sm border rounded-md">
              <table className="w-full table-fixed">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-2 w-14">Seq</th>
                    <th className="text-left p-2 w-28">Received</th>
                    <th className="text-left p-2 w-36">Kind</th>
                    <th className="text-left p-2">Summary</th>
                    <th className="text-left p-2 w-24">Tenant</th>
                    <th className="text-left p-2 w-36">Author</th>
                    <th className="text-left p-2 w-24" />
                  </tr>
                </thead>
                <tbody>
                  {domainRows.map((r) => (
                    <tr key={r.id} className="border-b align-top">
                      <td className="p-2">{String(r.seq)}</td>
                      <td className="p-2 whitespace-nowrap text-xs">
                        {new Date(r.serverReceivedAt).toLocaleString()}
                      </td>
                      <td className="p-2 font-mono text-xs break-all">{r.kind}</td>
                      <td className="p-2">{r.summary ?? r.kind}</td>
                      <td className="p-2 font-mono text-xs break-all" title={r.tenantId}>
                        {r.tenantId.slice(0, 8)}…
                      </td>
                      <td className="p-2 break-all text-xs">{r.authorEmail ?? r.authorUserId}</td>
                      <td className="p-2">
                        <Button size="sm" variant="outline" onClick={() => void openDetail(r.id)}>
                          Detail
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Domain event</DialogTitle>
            </DialogHeader>
            {detail && (
              <pre className="text-xs overflow-auto max-h-[60vh] bg-muted p-3 rounded-md">
                {JSON.stringify(detail, null, 2)}
              </pre>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </AdminGate>
  );
}
