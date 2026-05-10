import React, { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AdminGate } from '@/components/AdminGate';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type UserDetail = {
  id: string;
  email: string;
  createdAt: string;
  memberships: { tenantId: string; role: string; createdAt: string; revokedAt: string | null }[];
};

type TenantRow = { id: string; slug: string; name: string };

export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<UserDetail | null>(null);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [assignTenantId, setAssignTenantId] = useState<string>('');
  const [assignRole, setAssignRole] = useState<'admin' | 'caregiver'>('caregiver');
  const [assigning, setAssigning] = useState(false);

  const loadUser = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.get<UserDetail>(`/api/admin/users/${id}`);
      setData(res);
    } catch {
      toast.error('Failed to load user');
    }
  }, [id]);

  const loadTenants = useCallback(async () => {
    try {
      const res = await api.get<{ tenants: TenantRow[] }>('/api/admin/tenants');
      setTenants(res.tenants ?? []);
    } catch {
      toast.error('Failed to load tenants');
    }
  }, []);

  useEffect(() => {
    void loadUser();
    void loadTenants();
  }, [loadUser, loadTenants]);

  const revokeSessions = async () => {
    if (!id) return;
    try {
      await api.post(`/api/admin/users/${id}/revoke-sessions`);
      toast.success('Sessions revoked');
    } catch {
      toast.error('Failed to revoke sessions');
    }
  };

  const assignTenant = async () => {
    if (!id || !assignTenantId) {
      toast.error('Select a tenant');
      return;
    }
    setAssigning(true);
    try {
      await api.post(`/api/admin/users/${id}/tenant`, { tenantId: assignTenantId, role: assignRole });
      toast.success('Tenant assigned');
      await loadUser();
    } catch (err) {
      const msg =
        err instanceof ApiError ? String((err.body as { error?: string })?.error ?? err.message) : 'Assign failed';
      toast.error(msg);
    } finally {
      setAssigning(false);
    }
  };

  const slugForTenant = (tenantId: string) => tenants.find((t) => t.id === tenantId)?.slug ?? tenantId;

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
                <CardTitle>Tenant memberships</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="text-sm space-y-2">
                  {data.memberships.map((m) => (
                    <li key={`${m.tenantId}-${m.createdAt}`}>
                      <span className="font-mono text-xs">{slugForTenant(m.tenantId)}</span> — {m.role}
                      {m.revokedAt ? (
                        <span className="text-destructive ml-2">revoked {m.revokedAt}</span>
                      ) : (
                        <span className="text-green-600 ml-2">active</span>
                      )}
                    </li>
                  ))}
                </ul>
                {data.memberships.filter((m) => !m.revokedAt).length === 0 && (
                  <p className="text-sm text-amber-600 dark:text-amber-400 mt-3">
                    No active workspace. Assign a tenant below so this user can use the app.
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Assign tenant</CardTitle>
                <p className="text-sm text-muted-foreground font-normal">
                  Sets this user&apos;s single active workspace (other active memberships are revoked).
                </p>
              </CardHeader>
              <CardContent className="space-y-4 max-w-md">
                <div>
                  <Label>Tenant</Label>
                  <Select value={assignTenantId || undefined} onValueChange={setAssignTenantId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose tenant" />
                    </SelectTrigger>
                    <SelectContent>
                      {tenants.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.slug} — {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Role</Label>
                  <Select value={assignRole} onValueChange={(v) => setAssignRole(v as 'admin' | 'caregiver')}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="caregiver">Caregiver</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" onClick={() => void assignTenant()} disabled={assigning}>
                  {assigning ? 'Assigning…' : 'Assign'}
                </Button>
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
