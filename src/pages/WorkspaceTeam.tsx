import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';

interface MemberRow {
  userId: string;
  email: string;
  role: string;
  active: boolean;
}

export default function WorkspaceTeamPage() {
  const auth = useAuth();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<string>('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'caregiver'>('caregiver');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const res = await api.get<{ members: MemberRow[] }>('/api/tenant/members');
    const tid = auth.me?.tenants.find((t) => t.id === auth.activeTenantId)?.id ?? auth.me?.tenants[0]?.id;
    setTenantId(tid ?? null);
    const mine = auth.me?.tenants.find((t) => t.id === auth.activeTenantId);
    setMyRole(mine?.role ?? '');
    setMembers(res.members ?? []);
  };

  useEffect(() => {
    void refresh().catch(() => toast.error('Could not load team'));
  }, [auth.activeTenantId, auth.me]);

  const invite = async () => {
    setBusy(true);
    try {
      await api.post('/api/tenant/members', {
        email: email.trim().toLowerCase(),
        role,
      });
      toast.success('Member invited');
      setEmail('');
      await refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Invite failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId: string) => {
    if (!confirm('Remove this member from the tenant?')) return;
    try {
      await api.del(`/api/tenant/members/${userId}`);
      toast.success('Member removed');
      await refresh();
    } catch {
      toast.error('Remove failed');
    }
  };

  const canManage = myRole === 'admin';

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          {tenantId && (
            <p>
              Tenant ID: <span className="font-mono text-xs">{tenantId}</span>
            </p>
          )}
          <p>
            Your role: <strong className="text-foreground">{myRole || '…'}</strong>
          </p>
          <p>Members: {members.filter((m) => m.active).length}</p>
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Invite member</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>Email</Label>
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@example.com"
              />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as 'admin' | 'caregiver')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="caregiver">Caregiver</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => void invite()} disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Invite'}
            </Button>
            <p className="text-xs text-muted-foreground">
              The person must already have registered an account with this email.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {members
            .filter((m) => m.active)
            .map((m) => (
              <div key={m.userId} className="flex items-center justify-between gap-2 border-b pb-2">
                <div>
                  <div className="font-medium">{m.email}</div>
                  <div className="text-xs text-muted-foreground">{m.role}</div>
                </div>
                {canManage && m.userId !== auth.me?.id && (
                  <Button variant="outline" size="sm" onClick={() => void remove(m.userId)}>
                    Remove
                  </Button>
                )}
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
