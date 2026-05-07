import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AdminGate } from '@/components/AdminGate';
import { toast } from 'sonner';

export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{
    id: string;
    email: string;
    createdAt: string;
    memberships: { workspaceId: string; role: string; createdAt: string; revokedAt: string | null }[];
  } | null>(null);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const res = await api.get<typeof data>(`/api/admin/users/${id}`);
        setData(res);
      } catch {
        toast.error('Failed to load user');
      }
    })();
  }, [id]);

  const revokeSessions = async () => {
    if (!id) return;
    try {
      await api.post(`/api/admin/users/${id}/revoke-sessions`);
      toast.success('Sessions revoked');
    } catch {
      toast.error('Failed to revoke sessions');
    }
  };

  return (
    <AdminGate>
      <div className="space-y-6 max-w-3xl">
        <Link to="/admin/users" className="text-sm text-muted-foreground hover:underline">
          ← Accounts
        </Link>
        {data ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>{data.email}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">Joined {data.createdAt}</p>
                <Button variant="destructive" size="sm" onClick={() => void revokeSessions()}>
                  Revoke all sessions
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Workspace memberships</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="text-sm space-y-2">
                  {data.memberships.map(m => (
                    <li key={`${m.workspaceId}-${m.createdAt}`}>
                      <span className="font-mono text-xs">{m.workspaceId}</span> — {m.role}
                      {m.revokedAt ? (
                        <span className="text-destructive ml-2">revoked {m.revokedAt}</span>
                      ) : (
                        <span className="text-green-600 ml-2">active</span>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </div>
    </AdminGate>
  );
}
