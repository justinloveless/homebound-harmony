import React, { useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { api } from '@/lib/api';
import {
  encryptJson,
  exportShareKeyAsHex,
  generateShareKey,
} from '@/lib/crypto';
import { buildSnapshotForClient } from '@/lib/share';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Copy, Trash2, Link as LinkIcon } from 'lucide-react';
import { toast } from 'sonner';

interface ServerArtifact {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
  fetchCount: number;
  lastFetchedAt: string | null;
  createdAt: string;
}

export default function ShareManagePage() {
  const { workspace } = useWorkspace();
  const [artifacts, setArtifacts] = useState<ServerArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [expiresInDays, setExpiresInDays] = useState<number>(30);
  const [issuing, setIssuing] = useState(false);
  const [latestUrl, setLatestUrl] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const rows = await api.get<ServerArtifact[]>('/api/share');
      setArtifacts(rows);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to load share links');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const generate = async () => {
    if (!selectedClientId) { toast.error('Pick a client'); return; }
    if (!workspace.lastSchedule) { toast.error('No current schedule to share — generate one first.'); return; }
    const client = workspace.clients.find(c => c.id === selectedClientId);
    if (!client) return;

    setIssuing(true);
    try {
      const snapshot = buildSnapshotForClient({
        workerName: workspace.worker.name || 'Your worker',
        clientId: client.id,
        clientName: client.name,
        clientAddress: client.address,
        schedule: workspace.lastSchedule,
      });

      const shareKey = await generateShareKey();
      const enc = await encryptJson(snapshot, shareKey);
      const keyHex = await exportShareKeyAsHex(shareKey);

      const { id } = await api.post<{ id: string }>('/api/share', {
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        expiresInDays,
      });

      const url = `${window.location.origin}/s/${id}#${keyHex}`;
      await navigator.clipboard.writeText(url).catch(() => {});
      setLatestUrl(url);
      toast.success('Share link created and copied');
      await refresh();
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to create share link');
    } finally {
      setIssuing(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api.del(`/api/share/${id}`);
      toast.success('Revoked');
      await refresh();
    } catch (err: any) {
      toast.error(err?.message ?? 'Revoke failed');
    }
  };

  const sortedArtifacts = useMemo(
    () => [...artifacts].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
    [artifacts],
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight">Share schedules</h1>
      <p className="text-sm text-muted-foreground">
        Send a client their upcoming visits as a one-shot link. The schedule is encrypted on this device;
        the server stores ciphertext only and the decryption key lives in the URL fragment.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Create a new link</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Client</Label>
              <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                <SelectTrigger><SelectValue placeholder="Choose a client" /></SelectTrigger>
                <SelectContent>
                  {workspace.clients.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name || '(unnamed)'}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="exp">Expires in (days)</Label>
              <Input id="exp" type="number" min={1} max={365} value={expiresInDays}
                onChange={e => setExpiresInDays(Math.max(1, Math.min(365, Number(e.target.value) || 30)))} />
            </div>
          </div>
          <Button onClick={generate} disabled={issuing}>
            <LinkIcon className="w-4 h-4 mr-2" />
            {issuing ? 'Generating…' : 'Generate share link'}
          </Button>
          {latestUrl && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <div className="text-xs text-muted-foreground">Latest link (copied to clipboard):</div>
              <div className="font-mono text-xs break-all">{latestUrl}</div>
              <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(latestUrl).then(() => toast.success('Copied'))}>
                <Copy className="w-3 h-3 mr-2" /> Copy again
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active links</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : sortedArtifacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No share links yet.</p>
          ) : (
            <ul className="divide-y">
              {sortedArtifacts.map(a => {
                const status = a.revokedAt
                  ? 'Revoked'
                  : new Date(a.expiresAt) < new Date()
                    ? 'Expired'
                    : 'Active';
                return (
                  <li key={a.id} className="py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs truncate">{a.id}</div>
                      <div className="text-xs text-muted-foreground">
                        {status} · created {new Date(a.createdAt).toLocaleDateString()} · expires {new Date(a.expiresAt).toLocaleDateString()} · viewed {a.fetchCount}×
                      </div>
                    </div>
                    {!a.revokedAt && (
                      <Button variant="ghost" size="sm" onClick={() => revoke(a.id)}>
                        <Trash2 className="w-4 h-4 mr-1" /> Revoke
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
