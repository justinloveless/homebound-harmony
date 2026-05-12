import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AuthorizationProgress } from '@/components/billing/AuthorizationProgress';
import { Plus, Calendar, Building2 } from 'lucide-react';
import { toast } from 'sonner';

interface Authorization {
  id: string;
  clientId: string;
  clientName: string;
  serviceCode: string;
  payerName: string;
  payerId: string;
  unitsAuthorized: number;
  unitsUsed: number;
  startDate: string;
  endDate: string;
  status: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  exhausted: 'bg-red-100 text-red-800',
  expired: 'bg-gray-100 text-gray-600',
};

const COMMON_SERVICE_CODES = ['T1019', 'S5125', 'S5130', 'T1020', 'S5126'];

function formatDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface AuthFormData {
  clientId: string;
  serviceCode: string;
  payerName: string;
  payerId: string;
  unitsAuthorized: string;
  startDate: string;
  endDate: string;
}

const EMPTY_FORM: AuthFormData = {
  clientId: '',
  serviceCode: 'T1019',
  payerName: '',
  payerId: '',
  unitsAuthorized: '',
  startDate: '',
  endDate: '',
};

export default function AuthorizationsList() {
  const { workspace } = useWorkspace();
  const [authorizations, setAuthorizations] = useState<Authorization[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Authorization | null>(null);
  const [form, setForm] = useState<AuthFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
      const data = await api.get<{ authorizations: Authorization[] }>(
        `/api/authorizations${params}`,
      );
      setAuthorizations(data.authorizations);
    } catch {
      toast.error('Failed to load authorizations');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const openCreate = () => {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (auth: Authorization) => {
    setEditTarget(auth);
    setForm({
      clientId: auth.clientId,
      serviceCode: auth.serviceCode,
      payerName: auth.payerName,
      payerId: auth.payerId,
      unitsAuthorized: String(auth.unitsAuthorized),
      startDate: auth.startDate,
      endDate: auth.endDate,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.clientId) { toast.error('Client is required'); return; }
    if (!form.serviceCode) { toast.error('Service code is required'); return; }
    const units = Number(form.unitsAuthorized);
    if (!units || units < 1) { toast.error('Units authorized must be at least 1'); return; }
    if (!form.startDate || !form.endDate) { toast.error('Date range is required'); return; }
    if (form.startDate > form.endDate) { toast.error('Start date must be before end date'); return; }

    setSaving(true);
    try {
      const payload = {
        clientId: form.clientId,
        serviceCode: form.serviceCode,
        payerName: form.payerName,
        payerId: form.payerId,
        unitsAuthorized: units,
        startDate: form.startDate,
        endDate: form.endDate,
      };

      if (editTarget) {
        await api.put(`/api/authorizations/${editTarget.id}`, payload);
        toast.success('Authorization updated');
      } else {
        await api.post('/api/authorizations', payload);
        toast.success('Authorization created');
      }

      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (auth: Authorization, newStatus: string) => {
    try {
      await api.put(`/api/authorizations/${auth.id}`, { status: newStatus });
      toast.success('Status updated');
      load();
    } catch {
      toast.error('Failed to update status');
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Service Authorizations</h1>
          <p className="text-sm text-muted-foreground">Manage client service authorizations and unit tracking</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" />
          Add Authorization
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Label className="text-sm shrink-0">Filter by status:</Label>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="exhausted">Exhausted</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32 text-muted-foreground">Loading...</div>
      ) : authorizations.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            <p className="text-sm">No authorizations found.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add the first one
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {authorizations.map((auth) => (
            <Card key={auth.id} className="hover:shadow-sm transition-shadow">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-sm font-semibold truncate">
                      {auth.clientName || 'Unknown Client'}
                    </CardTitle>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                        {auth.serviceCode}
                      </span>
                      {auth.payerName && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Building2 className="h-3 w-3" />
                          {auth.payerName}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge
                      variant="outline"
                      className={STATUS_COLORS[auth.status] ?? 'bg-gray-100 text-gray-600'}
                    >
                      {auth.status}
                    </Badge>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(auth)}>
                      Edit
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                <AuthorizationProgress
                  unitsUsed={auth.unitsUsed}
                  unitsAuthorized={auth.unitsAuthorized}
                />
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Calendar className="h-3 w-3" />
                  {formatDate(auth.startDate)} – {formatDate(auth.endDate)}
                </div>
                {auth.status === 'active' && auth.unitsUsed >= auth.unitsAuthorized && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => handleStatusChange(auth, 'exhausted')}
                  >
                    Mark Exhausted
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editTarget ? 'Edit Authorization' : 'New Authorization'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Client</Label>
              <Select
                value={form.clientId}
                onValueChange={(v) => setForm((f) => ({ ...f, clientId: v }))}
                disabled={!!editTarget}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select client..." />
                </SelectTrigger>
                <SelectContent>
                  {workspace.clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Service Code</Label>
              <Select
                value={form.serviceCode}
                onValueChange={(v) => setForm((f) => ({ ...f, serviceCode: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_SERVICE_CODES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Payer Name</Label>
                <Input
                  placeholder="MCO / Payer name"
                  value={form.payerName}
                  onChange={(e) => setForm((f) => ({ ...f, payerName: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Payer ID</Label>
                <Input
                  placeholder="Payer ID"
                  value={form.payerId}
                  onChange={(e) => setForm((f) => ({ ...f, payerId: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Units Authorized (15-min units)</Label>
              <Input
                type="number"
                min={1}
                placeholder="e.g. 96"
                value={form.unitsAuthorized}
                onChange={(e) => setForm((f) => ({ ...f, unitsAuthorized: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Start Date</Label>
                <Input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>End Date</Label>
                <Input
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : editTarget ? 'Save Changes' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
