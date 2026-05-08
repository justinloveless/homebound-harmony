import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

interface DataEventRow {
  workspaceId: string;
  seq: number;
  clientEventId: string;
  serverReceivedAt: string;
  clientClaimedAt: string;
  isClinical: boolean;
  authorUserId: string;
  authorEmail: string | null;
  hasGps: boolean;
}

const PAGE_OPTIONS = [25, 50, 100, 200] as const;

export default function AdminAuditPage() {
  const [userId, setUserId] = useState('');
  const [auditLimit, setAuditLimit] = useState<number>(100);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLoading, setAuditLoading] = useState(true);

  const [wsFilter, setWsFilter] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [deLimit, setDeLimit] = useState<number>(100);
  const [deOffset, setDeOffset] = useState(0);
  const [deRows, setDeRows] = useState<DataEventRow[]>([]);
  const [deTotal, setDeTotal] = useState(0);
  const [deLoading, setDeLoading] = useState(true);

  const loadAudit = useCallback(async (offset: number, limit: number) => {
    setAuditLoading(true);
    try {
      const uid = userId.trim();
      const q = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (uid) q.set('userId', uid);
      const res = await api.get<{
        events: AuditRow[];
        total: number;
      }>(`/api/admin/audit?${q.toString()}`);
      setAuditRows(res.events ?? []);
      setAuditTotal(res.total ?? 0);
      setAuditOffset(offset);
    } catch {
      toast.error('Failed to load security audit');
    } finally {
      setAuditLoading(false);
    }
  }, [userId]);

  const loadDataEvents = useCallback(async (offset: number, limit: number) => {
    setDeLoading(true);
    try {
      const q = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      const w = wsFilter.trim();
      const a = authorFilter.trim();
      if (w) q.set('workspaceId', w);
      if (a) q.set('authorUserId', a);
      const res = await api.get<{
        events: DataEventRow[];
        total: number;
      }>(`/api/admin/data-events?${q.toString()}`);
      setDeRows(res.events ?? []);
      setDeTotal(res.total ?? 0);
      setDeOffset(offset);
    } catch {
      toast.error('Failed to load workspace events');
    } finally {
      setDeLoading(false);
    }
  }, [authorFilter, wsFilter]);

  useEffect(() => {
    void loadAudit(0, 100);
    // Filters require "Apply"; avoid refiring when typing in the filter field
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadDataEvents(0, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const auditRangeLabel =
    auditTotal === 0
      ? '0 of 0'
      : `${auditOffset + 1}–${Math.min(auditOffset + auditRows.length, auditTotal)} of ${auditTotal}`;

  const deRangeLabel =
    deTotal === 0
      ? '0 of 0'
      : `${deOffset + 1}–${Math.min(deOffset + deRows.length, deTotal)} of ${deTotal}`;

  return (
    <AdminGate>
      <div className="space-y-6 max-w-6xl">
        <Link to="/admin/users" className="text-sm text-muted-foreground hover:underline">
          ← Accounts
        </Link>

        <Tabs defaultValue="security" className="w-full">
          <TabsList>
            <TabsTrigger value="security">Security audit</TabsTrigger>
            <TabsTrigger value="workspace">Workspace events</TabsTrigger>
          </TabsList>

          <TabsContent value="security" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Security audit log</CardTitle>
                <p className="text-sm text-muted-foreground font-normal">
                  Server-side actions (auth, sharing, admin operations, team changes). Paginate to review the full history.
                </p>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                <div className="flex-1 min-w-[200px]">
                  <label className="text-xs text-muted-foreground block mb-1">Filter by user id</label>
                  <Input
                    placeholder="Optional user UUID"
                    value={userId}
                    onChange={e => setUserId(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Page size</label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={auditLimit}
                    onChange={e => {
                      const n = Number(e.target.value);
                      setAuditLimit(n);
                      void loadAudit(0, n);
                    }}
                  >
                    {PAGE_OPTIONS.map(n => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  type="button"
                  onClick={() => {
                    void loadAudit(0, auditLimit);
                  }}
                >
                  Apply
                </Button>
              </CardContent>
            </Card>

            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>{auditLoading ? 'Loading…' : `Showing ${auditRangeLabel}`}</span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={auditLoading || auditOffset === 0}
                  onClick={() => {
                    void loadAudit(Math.max(0, auditOffset - auditLimit), auditLimit);
                  }}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={auditLoading || auditOffset + auditRows.length >= auditTotal}
                  onClick={() => {
                    void loadAudit(auditOffset + auditLimit, auditLimit);
                  }}
                >
                  Next
                </Button>
              </div>
            </div>

            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-2">Time</th>
                    <th className="text-left p-2">Action</th>
                    <th className="text-left p-2">User</th>
                    <th className="text-left p-2">Artifact</th>
                    <th className="text-left p-2">IP (hashed)</th>
                    <th className="text-left p-2 max-w-[14rem]">User agent</th>
                  </tr>
                </thead>
                <tbody>
                  {auditRows.map(e => (
                    <tr key={e.id} className="border-b">
                      <td className="p-2 whitespace-nowrap">{e.occurredAt}</td>
                      <td className="p-2">{e.action}</td>
                      <td className="p-2">{e.userEmail ?? e.userId ?? '—'}</td>
                      <td className="p-2 font-mono text-xs break-all">{e.artifactId ?? '—'}</td>
                      <td className="p-2">{e.hasIpHash ? 'yes' : '—'}</td>
                      <td className="p-2 max-w-[14rem] truncate text-xs text-muted-foreground" title={e.userAgent ?? ''}>
                        {e.userAgent ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>

          <TabsContent value="workspace" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Workspace sync events</CardTitle>
                <p className="text-sm text-muted-foreground font-normal">
                  Encrypted clinical/workspace events (metadata only — no payloads). Timeline across all workspaces.
                </p>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                <div className="flex-1 min-w-[200px]">
                  <label className="text-xs text-muted-foreground block mb-1">Workspace id</label>
                  <Input
                    placeholder="Optional workspace UUID"
                    value={wsFilter}
                    onChange={e => setWsFilter(e.target.value)}
                  />
                </div>
                <div className="flex-1 min-w-[200px]">
                  <label className="text-xs text-muted-foreground block mb-1">Author user id</label>
                  <Input
                    placeholder="Optional author UUID"
                    value={authorFilter}
                    onChange={e => setAuthorFilter(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Page size</label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={deLimit}
                    onChange={e => {
                      const n = Number(e.target.value);
                      setDeLimit(n);
                      void loadDataEvents(0, n);
                    }}
                  >
                    {PAGE_OPTIONS.map(n => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  type="button"
                  onClick={() => {
                    void loadDataEvents(0, deLimit);
                  }}
                >
                  Apply
                </Button>
              </CardContent>
            </Card>

            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>{deLoading ? 'Loading…' : `Showing ${deRangeLabel}`}</span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={deLoading || deOffset === 0}
                  onClick={() => {
                    void loadDataEvents(Math.max(0, deOffset - deLimit), deLimit);
                  }}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={deLoading || deOffset + deRows.length >= deTotal}
                  onClick={() => {
                    void loadDataEvents(deOffset + deLimit, deLimit);
                  }}
                >
                  Next
                </Button>
              </div>
            </div>

            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-2">Received</th>
                    <th className="text-left p-2">Workspace</th>
                    <th className="text-left p-2">Seq</th>
                    <th className="text-left p-2">Clinical</th>
                    <th className="text-left p-2">Author</th>
                    <th className="text-left p-2">GPS</th>
                    <th className="text-left p-2 font-mono text-xs">Client event id</th>
                  </tr>
                </thead>
                <tbody>
                  {deRows.map(e => (
                    <tr key={`${e.workspaceId}-${e.seq}`} className="border-b">
                      <td className="p-2 whitespace-nowrap">{e.serverReceivedAt}</td>
                      <td className="p-2 font-mono text-xs break-all">{e.workspaceId}</td>
                      <td className="p-2">{e.seq}</td>
                      <td className="p-2">{e.isClinical ? 'yes' : 'no'}</td>
                      <td className="p-2">{e.authorEmail ?? e.authorUserId}</td>
                      <td className="p-2">{e.hasGps ? 'yes' : '—'}</td>
                      <td className="p-2 font-mono text-xs break-all">{e.clientEventId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </AdminGate>
  );
}
