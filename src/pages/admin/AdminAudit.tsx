import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getActiveWorkspaceId } from '@/lib/api';
import { decryptJson } from '@/lib/crypto';
import type { Event } from '@/types/events';
import { useAuth } from '@/contexts/AuthContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

interface DataEventDetail {
  id: string;
  workspaceId: string;
  seq: number;
  clientEventId: string;
  prevHash: string;
  hash: string;
  serverReceivedAt: string;
  clientClaimedAt: string;
  isClinical: boolean;
  authorUserId: string;
  authorEmail: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAccuracyM: number | null;
  gpsCapturedAt: string | null;
  gpsStaleSeconds: number | null;
  hasIpHash: boolean;
  ciphertextCharLength: number;
  ivCharLength: number;
  ciphertext: string;
  iv: string;
}

interface DataEventRow {
  id: string;
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

type PayloadDecode =
  | { state: 'idle' }
  | { state: 'wrong_workspace'; eventWs: string; activeWs: string | null }
  | { state: 'decrypting' }
  | { state: 'ok'; payload: Event }
  | { state: 'fail'; message: string };

export default function AdminAuditPage() {
  const auth = useAuth();
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
  const [deDetailOpen, setDeDetailOpen] = useState(false);
  const [deDetail, setDeDetail] = useState<DataEventDetail | null>(null);
  const [deDetailLoading, setDeDetailLoading] = useState(false);
  const [payloadDecode, setPayloadDecode] = useState<PayloadDecode>({ state: 'idle' });

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

  const openDataEventDetail = async (id: string) => {
    setDeDetailOpen(true);
    setDeDetailLoading(true);
    setDeDetail(null);
    setPayloadDecode({ state: 'idle' });
    try {
      const res = await api.get<{ event: DataEventDetail }>(`/api/admin/data-events/${id}`);
      setDeDetail(res.event);
    } catch {
      toast.error('Failed to load event detail');
      setDeDetailOpen(false);
    } finally {
      setDeDetailLoading(false);
    }
  };

  useEffect(() => {
    if (!deDetail?.ciphertext || !deDetail?.iv) {
      setPayloadDecode({ state: 'idle' });
      return;
    }
    const activeWs = getActiveWorkspaceId();
    if (deDetail.workspaceId !== activeWs) {
      setPayloadDecode({ state: 'wrong_workspace', eventWs: deDetail.workspaceId, activeWs });
      return;
    }
    const wk = auth.workspaceKey;
    if (!wk) {
      setPayloadDecode({
        state: 'fail',
        message: 'No workspace key in memory. Unlock with your password from the unlock screen.',
      });
      return;
    }
    setPayloadDecode({ state: 'decrypting' });
    let cancelled = false;
    void decryptJson<Event>({ ciphertext: deDetail.ciphertext, iv: deDetail.iv }, wk).then(
      (payload) => {
        if (!cancelled) setPayloadDecode({ state: 'ok', payload });
      },
      () => {
        if (!cancelled) {
          setPayloadDecode({
            state: 'fail',
            message:
              'Decryption failed. The event might use an older workspace key (after rotation), your session targets another workspace key wrap, or the ciphertext is corrupted.',
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [auth.workspaceKey, deDetail]);

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
                  Encrypted workspace events across all workspaces. Summary in the table; Details includes chain hashes, GPS, ciphertext
                  sizes, and (when your unlocked workspace AES key matches) a JSON payload decrypted in this browser only.
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
                    <th className="text-right p-2 whitespace-nowrap"> </th>
                  </tr>
                </thead>
                <tbody>
                  {deRows.map(e => (
                    <tr key={e.id} className="border-b">
                      <td className="p-2 whitespace-nowrap">{e.serverReceivedAt}</td>
                      <td className="p-2 font-mono text-xs break-all">{e.workspaceId}</td>
                      <td className="p-2">{e.seq}</td>
                      <td className="p-2">{e.isClinical ? 'yes' : 'no'}</td>
                      <td className="p-2">{e.authorEmail ?? e.authorUserId}</td>
                      <td className="p-2">{e.hasGps ? 'yes' : '—'}</td>
                      <td className="p-2 font-mono text-xs break-all">{e.clientEventId}</td>
                      <td className="p-2 text-right whitespace-nowrap">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2"
                          onClick={() => void openDataEventDetail(e.id)}
                        >
                          Details
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Dialog open={deDetailOpen} onOpenChange={(open) => {
              setDeDetailOpen(open);
              if (!open) {
                setDeDetail(null);
                setDeDetailLoading(false);
              }
            }}>
              <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Workspace event detail</DialogTitle>
                  <DialogDescription>
                    Metadata from the database. ciphertext and iv are included for admins; decryption happens only here in the browser
                    using your unlocked workspace key when the event&apos;s workspace matches your session.
                  </DialogDescription>
                </DialogHeader>
                {deDetailLoading ? (
                  <p className="text-sm text-muted-foreground py-6">Loading…</p>
                ) : deDetail ? (
                  <div className="space-y-4 text-sm">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="text-xs text-muted-foreground">Row id</p>
                        <p className="font-mono text-xs break-all">{deDetail.id}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Sequence</p>
                        <p className="font-mono">{deDetail.seq}</p>
                      </div>
                      <div className="sm:col-span-2">
                        <p className="text-xs text-muted-foreground">Workspace</p>
                        <p className="font-mono text-xs break-all">{deDetail.workspaceId}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Clinical flag</p>
                        <p>{deDetail.isClinical ? 'yes' : 'no'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Author</p>
                        <p>{deDetail.authorEmail ?? deDetail.authorUserId}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Client claimed at</p>
                        <p className="font-mono text-xs">{deDetail.clientClaimedAt}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Server received at</p>
                        <p className="font-mono text-xs">{deDetail.serverReceivedAt}</p>
                      </div>
                      <div className="sm:col-span-2">
                        <p className="text-xs text-muted-foreground">Client event id</p>
                        <p className="font-mono text-xs break-all">{deDetail.clientEventId}</p>
                      </div>
                    </div>

                    <div className="border-t pt-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Integrity chain</p>
                      <div>
                        <p className="text-xs text-muted-foreground">Previous hash</p>
                        <p className="font-mono text-xs break-all leading-relaxed">{deDetail.prevHash || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Event hash</p>
                        <p className="font-mono text-xs break-all leading-relaxed">{deDetail.hash}</p>
                      </div>
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs pt-1">
                        <span>
                          IP hash captured:{' '}
                          <span className="text-foreground">{deDetail.hasIpHash ? 'yes' : 'no'}</span>
                        </span>
                        <span>
                          Ciphertext length (chars):{' '}
                          <span className="font-mono text-foreground">{deDetail.ciphertextCharLength}</span>
                        </span>
                        <span>
                          IV length (chars): <span className="font-mono text-foreground">{deDetail.ivCharLength}</span>
                        </span>
                      </div>
                    </div>

                    <div className="border-t pt-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">GPS (when supplied)</p>
                      {deDetail.gpsLat != null && deDetail.gpsLon != null ? (
                        <div className="grid gap-2 sm:grid-cols-2 text-xs font-mono">
                          <span>Latitude: {deDetail.gpsLat}</span>
                          <span>Longitude: {deDetail.gpsLon}</span>
                          {deDetail.gpsAccuracyM != null && <span>Accuracy (m): {deDetail.gpsAccuracyM}</span>}
                          <span>Captured at: {deDetail.gpsCapturedAt ?? '—'}</span>
                          {deDetail.gpsStaleSeconds != null && (
                            <span>Stale (seconds): {deDetail.gpsStaleSeconds}</span>
                          )}
                        </div>
                      ) : (
                        <p className="text-muted-foreground text-xs">None stored for this event.</p>
                      )}
                    </div>

                    <div className="border-t pt-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Decrypted payload (this browser)</p>
                      <p className="text-xs text-muted-foreground">
                        Uses the same AES-256-GCM workspace key as RouteCare sync (&quot;/api/events&quot;). Your session remembers one
                        workspace id after unlock when the snapshot response includes it; decryption succeeds only when that id equals
                        the event workspace. The server never sees plaintext events.
                      </p>
                      {payloadDecode.state === 'idle' && (
                        <p className="text-xs text-muted-foreground">Waiting for event blob…</p>
                      )}
                      {payloadDecode.state === 'decrypting' && (
                        <p className="text-xs text-muted-foreground">Decrypting…</p>
                      )}
                      {payloadDecode.state === 'wrong_workspace' && (
                        <div className="text-xs space-y-1 rounded-md bg-muted/50 p-3">
                          <p className="font-medium text-foreground">Workspace mismatch — cannot decrypt with the current key</p>
                          <p>
                            <span className="text-muted-foreground">Event workspace: </span>
                            <span className="font-mono break-all">{payloadDecode.eventWs}</span>
                          </p>
                          <p>
                            <span className="text-muted-foreground">Unlocked workspace: </span>
                            <span className="font-mono break-all">
                              {payloadDecode.activeWs ?? 'unknown — unlock again after resolving your membership workspace'}
                            </span>
                          </p>
                          <p className="text-muted-foreground pt-1">
                            You need the workspace key wrap for this UUID (membership plus unlock). If you administer another
                            tenant&apos;s data, log in as a user who belongs to that workspace, or expose a workspace switcher that sets
                            <code className="mx-1 rounded bg-muted px-1 py-px text-[11px]">X-Workspace-Id</code> before unlock.
                          </p>
                        </div>
                      )}
                      {payloadDecode.state === 'fail' && (
                        <p className="text-xs text-destructive">{payloadDecode.message}</p>
                      )}
                      {payloadDecode.state === 'ok' && (
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed">
                          {JSON.stringify(payloadDecode.payload, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                ) : null}
              </DialogContent>
            </Dialog>
          </TabsContent>
        </Tabs>
      </div>
    </AdminGate>
  );
}
