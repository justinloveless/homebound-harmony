import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { AdminGate } from '@/components/AdminGate';
import { toast } from 'sonner';

interface AdminUserRow {
  id: string;
  email: string;
  createdAt: string;
  tenants: {
    tenantId: string;
    slug: string;
    name: string;
    role: string;
  }[];
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}

export default function AdminUsersPage() {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tenantsLoading, setTenantsLoading] = useState(true);
  const [newSlug, setNewSlug] = useState('');
  const [newName, setNewName] = useState('');
  const [creatingTenant, setCreatingTenant] = useState(false);

  const loadTenants = async () => {
    setTenantsLoading(true);
    try {
      const res = await api.get<{ tenants: TenantRow[] }>('/api/admin/tenants');
      setTenants(res.tenants ?? []);
    } catch {
      toast.error('Could not load tenants');
    } finally {
      setTenantsLoading(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get<{ users: AdminUserRow[] }>(
        `/api/admin/users?limit=50&q=${encodeURIComponent(q)}`,
      );
      setUsers(res.users ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void loadTenants();
  }, []);

  const createTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSlug.trim() || !newName.trim()) {
      toast.error('Slug and name are required');
      return;
    }
    setCreatingTenant(true);
    try {
      await api.post('/api/admin/tenants', { slug: newSlug.trim(), name: newName.trim() });
      toast.success('Tenant created');
      setNewSlug('');
      setNewName('');
      await loadTenants();
    } catch (err) {
      const msg =
        err instanceof ApiError ? String((err.body as { error?: string })?.error ?? err.message) : 'Create failed';
      toast.error(msg);
    } finally {
      setCreatingTenant(false);
    }
  };

  return (
    <AdminGate>
      <div className="space-y-6 max-w-5xl">
        <Card>
          <CardHeader>
            <CardTitle>Tenants</CardTitle>
            <p className="text-sm text-muted-foreground font-normal">
              Create a tenant first; users register at{' '}
              <span className="font-mono text-xs">https://&lt;slug&gt;…/register</span>.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {tenantsLoading ? (
              <p className="text-sm text-muted-foreground">Loading tenants…</p>
            ) : (
              <ul className="text-sm space-y-1 max-h-40 overflow-y-auto border rounded-md p-3 bg-muted/30">
                {tenants.length === 0 ? (
                  <li className="text-muted-foreground">No tenants yet.</li>
                ) : (
                  tenants.map((t) => (
                    <li key={t.id}>
                      <span className="font-mono text-xs">{t.slug}</span>
                      <span className="text-muted-foreground ml-2">— {t.name}</span>
                    </li>
                  ))
                )}
              </ul>
            )}
            <form className="grid gap-3 sm:grid-cols-2 items-end" onSubmit={createTenant}>
              <div>
                <Label htmlFor="tenant-slug">Slug (subdomain)</Label>
                <Input
                  id="tenant-slug"
                  placeholder="tenantx"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div>
                <Label htmlFor="tenant-name">Display name</Label>
                <Input
                  id="tenant-name"
                  placeholder="TenantX Clinic"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" disabled={creatingTenant}>
                  {creatingTenant ? 'Creating…' : 'Create tenant'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle>Accounts</CardTitle>
            <Link to="/admin/audit" className="text-sm text-primary hover:underline">
              Audit trail
            </Link>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input placeholder="Search email" value={q} onChange={e => setQ(e.target.value)} />
            <Button type="button" onClick={() => void load()}>
              Search
            </Button>
          </CardContent>
        </Card>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="space-y-2">
            {users.map(u => (
              <li key={u.id}>
                <Link className="text-primary hover:underline font-medium" to={`/admin/users/${u.id}`}>
                  {u.email}
                </Link>
                <span className="text-xs text-muted-foreground ml-2">
                  {u.tenants.length} active tenant(s)
                  {u.tenants.length === 0 && (
                    <span className="text-amber-600 dark:text-amber-400 ml-1">— needs assignment</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminGate>
  );
}
