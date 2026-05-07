import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import { wrapWorkspaceKeyForPeer } from '@/lib/crypto';
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
  const wk = auth.workspaceKey;
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<string>('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const res = await api.get<{ workspaceId: string; role: string; members: MemberRow[] }>(
      '/api/workspace/members',
    );
    setWorkspaceId(res.workspaceId);
    setMyRole(res.role);
    setMembers(res.members ?? []);
  };

  useEffect(() => {
    void refresh().catch(() => toast.error('Could not load team'));
  }, []);

  const invite = async () => {
    if (!wk) {
      toast.error('Unlock workspace first');
      return;
    }
    setBusy(true);
    try {
      const lookup = await api.get<{ id: string; masterPublicKey: string | null }>(
        `/api/auth/lookup-user?email=${encodeURIComponent(email.trim().toLowerCase())}`,
      );
      if (!lookup.masterPublicKey) {
        toast.error('That user must enroll a device key in Settings first');
        return;
      }
      const wrappedWorkspaceKey = await wrapWorkspaceKeyForPeer(wk, lookup.masterPublicKey);
      await api.post('/api/workspace/members', {
        userId: lookup.id,
        role,
        wrappedWorkspaceKey,
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
    if (!confirm('Remove this member from the workspace?')) return;
    try {
      await api.del(`/api/workspace/members/${userId}`);
      toast.success('Member removed');
      await refresh();
    } catch {
      toast.error('Remove failed');
    }
  };

  const canManage = myRole === 'owner' || myRole === 'admin';

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Workspace team</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          {workspaceId && (
            <p>
              Workspace ID: <span className="font-mono text-xs">{workspaceId}</span>
            </p>
          )}
          <p>
            Your role: <strong className="text-foreground">{myRole || '…'}</strong>
          </p>
          <p>Members: {members.filter(m => m.active).length}</p>
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
              <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="colleague@example.com" />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="editor">editor</SelectItem>
                  <SelectItem value="viewer">viewer</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button disabled={busy || !email.trim()} onClick={() => void invite()}>
              Send invite
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {members.map(m => (
              <li key={m.userId} className="flex justify-between items-center gap-2">
                <span>
                  {m.email} — {m.role}
                  {!m.active && <span className="text-destructive ml-2">revoked</span>}
                </span>
                {canManage && m.active && m.userId !== auth.me?.id && (
                  <Button variant="outline" size="sm" onClick={() => void remove(m.userId)}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
