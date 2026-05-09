import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AdminGate } from '@/components/AdminGate';

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

export default function AdminUsersPage() {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);

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
  }, []);

  return (
    <AdminGate>
      <div className="space-y-6 max-w-5xl">
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
                  {u.tenants.length} tenant(s)
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminGate>
  );
}
