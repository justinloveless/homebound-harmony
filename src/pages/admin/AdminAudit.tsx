import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AdminGate } from '@/components/AdminGate';

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

export default function AdminAuditPage() {
  const [userId, setUserId] = useState('');
  const [events, setEvents] = useState<AuditRow[]>([]);

  const load = async () => {
    const q = userId.trim()
      ? `&userId=${encodeURIComponent(userId.trim())}`
      : '';
    const res = await api.get<{ events: AuditRow[] }>(`/api/admin/audit?limit=100${q}`);
    setEvents(res.events ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <AdminGate>
      <div className="space-y-6 max-w-5xl">
        <Link to="/admin/users" className="text-sm text-muted-foreground hover:underline">
          ← Accounts
        </Link>
        <Card>
          <CardHeader>
            <CardTitle>Audit log</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input
              placeholder="Filter by user id (optional)"
              value={userId}
              onChange={e => setUserId(e.target.value)}
            />
            <Button type="button" onClick={() => void load()}>
              Apply
            </Button>
          </CardContent>
        </Card>
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-2">Time</th>
                <th className="text-left p-2">Action</th>
                <th className="text-left p-2">User</th>
                <th className="text-left p-2">Artifact</th>
              </tr>
            </thead>
            <tbody>
              {events.map(e => (
                <tr key={e.id} className="border-b">
                  <td className="p-2 whitespace-nowrap">{e.occurredAt}</td>
                  <td className="p-2">{e.action}</td>
                  <td className="p-2">{e.userEmail ?? e.userId ?? '—'}</td>
                  <td className="p-2 font-mono text-xs">{e.artifactId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminGate>
  );
}
