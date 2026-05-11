import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, CheckCircle, XCircle, Clock, DollarSign, Search, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { BillingStatusBadge } from '@/components/billing/BillingStatusBadge';
import { ValidationIssueList, type ValidationIssue } from '@/components/billing/ValidationIssueList';

interface DashboardSummary {
  billable: number;
  notBillable: number;
  pending: number;
  totalUnits: number;
}

interface VisitRow {
  id: string;
  checkInAt: string;
  checkOutAt: string | null;
  visitStatus: string;
  evvStatus: string;
  noteStatus: string;
  isBillable: boolean;
  billingIssues: ValidationIssue[];
  billableUnits: number | null;
  durationMinutes: number | null;
  serviceCode: string | null;
  clientName: string | null;
  workerName: string | null;
}

interface DashboardData {
  summary: DashboardSummary;
  issueBreakdown: Record<string, number>;
  visits: VisitRow[];
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const ISSUE_CODE_LABELS: Record<string, string> = {
  EVV_PENDING: 'EVV Pending',
  EVV_REJECTED: 'EVV Rejected',
  NOTE_INCOMPLETE: 'Note Incomplete',
  NOTE_UNSIGNED: 'Note Unsigned',
  NO_AUTHORIZATION: 'No Authorization',
  AUTH_EXCEEDED: 'Auth Exceeded',
  AUTH_EXPIRED: 'Auth Expired',
  DURATION_TOO_SHORT: 'Duration Too Short',
  INVALID_TIMESTAMPS: 'Invalid Timestamps',
};

export default function BillingDashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [revalidating, setRevalidating] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'billable' | 'not_billable' | 'pending'>('billable');

  const refresh = useCallback(async () => {
    try {
      const result = await api.get('/api/billing/dashboard') as DashboardData;
      setData(result);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load billing dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const revalidateAll = async () => {
    setRevalidating(true);
    try {
      const result = await api.post('/api/billing/validate', {}) as { validated: number; billable: number };
      toast.success(`Re-validated ${result.validated} visits — ${result.billable} billable`);
      await refresh();
    } catch {
      toast.error('Re-validation failed');
    } finally {
      setRevalidating(false);
    }
  };

  const allVisits = data?.visits ?? [];
  const searchLower = search.toLowerCase();
  const filtered = allVisits.filter((v) => {
    if (!searchLower) return true;
    return (
      v.clientName?.toLowerCase().includes(searchLower) ||
      v.workerName?.toLowerCase().includes(searchLower) ||
      v.serviceCode?.toLowerCase().includes(searchLower)
    );
  });

  const billableVisits = filtered.filter((v) => v.visitStatus === 'completed' && v.isBillable);
  const notBillableVisits = filtered.filter((v) => v.visitStatus === 'completed' && !v.isBillable);
  const pendingVisits = filtered.filter((v) => v.visitStatus === 'in_progress');

  const tabVisits = tab === 'billable' ? billableVisits : tab === 'not_billable' ? notBillableVisits : pendingVisits;
  const summary = data?.summary;
  const issueBreakdown = data?.issueBreakdown ?? {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Billing Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review visit billability and manage claims
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => void revalidateAll()} disabled={revalidating}>
            <RotateCcw className={`h-4 w-4 mr-2 ${revalidating ? 'animate-spin' : ''}`} />
            Re-validate All
          </Button>
          <Button size="sm" onClick={() => navigate('/billing/claims')}>
            <DollarSign className="h-4 w-4 mr-2" />
            Generate Claims
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card
          className="border-green-200 bg-green-50 cursor-pointer hover:border-green-400 transition-colors"
          onClick={() => setTab('billable')}
        >
          <CardContent className="p-4">
            <div className="flex items-center gap-1.5 text-xs font-medium text-green-700 mb-1">
              <CheckCircle className="h-3.5 w-3.5" />
              Billable Visits
            </div>
            <div className="text-2xl font-bold text-green-700">{summary?.billable ?? '—'}</div>
          </CardContent>
        </Card>
        <Card
          className="border-red-200 bg-red-50 cursor-pointer hover:border-red-400 transition-colors"
          onClick={() => setTab('not_billable')}
        >
          <CardContent className="p-4">
            <div className="flex items-center gap-1.5 text-xs font-medium text-red-700 mb-1">
              <XCircle className="h-3.5 w-3.5" />
              Not Billable
            </div>
            <div className="text-2xl font-bold text-red-700">{summary?.notBillable ?? '—'}</div>
          </CardContent>
        </Card>
        <Card
          className="border-blue-200 bg-blue-50 cursor-pointer hover:border-blue-400 transition-colors"
          onClick={() => setTab('pending')}
        >
          <CardContent className="p-4">
            <div className="flex items-center gap-1.5 text-xs font-medium text-blue-700 mb-1">
              <Clock className="h-3.5 w-3.5" />
              In Progress
            </div>
            <div className="text-2xl font-bold text-blue-700">{summary?.pending ?? '—'}</div>
          </CardContent>
        </Card>
        <Card className="border-purple-200 bg-purple-50">
          <CardContent className="p-4">
            <div className="flex items-center gap-1.5 text-xs font-medium text-purple-700 mb-1">
              <DollarSign className="h-3.5 w-3.5" />
              Billable Units
            </div>
            <div className="text-2xl font-bold text-purple-700">{summary?.totalUnits ?? '—'}</div>
          </CardContent>
        </Card>
      </div>

      {/* Issue Breakdown */}
      {Object.keys(issueBreakdown).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Issue Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(issueBreakdown)
                .sort((a, b) => b[1] - a[1])
                .map(([code, count]) => (
                  <Badge
                    key={code}
                    variant="outline"
                    className="bg-red-50 text-red-700 border-red-200 cursor-pointer hover:bg-red-100"
                    onClick={() => setTab('not_billable')}
                  >
                    {ISSUE_CODE_LABELS[code] ?? code}: {count}
                  </Badge>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Visit List */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex gap-2">
              {(['billable', 'not_billable', 'pending'] as const).map((t) => {
                const labels = { billable: `Billable (${billableVisits.length})`, not_billable: `Not Billable (${notBillableVisits.length})`, pending: `In Progress (${pendingVisits.length})` };
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`text-sm px-3 py-1 rounded-md transition-colors ${
                      tab === t
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {labels[t]}
                  </button>
                );
              })}
            </div>
            <div className="relative w-56">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Filter by client or worker…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>
          ) : tabVisits.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No visits in this category.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground text-xs">
                    <th className="pb-2 pr-3 font-medium">Client</th>
                    <th className="pb-2 pr-3 font-medium">Caregiver</th>
                    <th className="pb-2 pr-3 font-medium">Check-in</th>
                    <th className="pb-2 pr-3 font-medium">Duration</th>
                    <th className="pb-2 pr-3 font-medium">Units</th>
                    <th className="pb-2 pr-3 font-medium">Status</th>
                    {tab === 'not_billable' && <th className="pb-2 font-medium">Issues</th>}
                  </tr>
                </thead>
                <tbody>
                  {tabVisits.map((v) => (
                    <tr key={v.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 pr-3 font-medium">{v.clientName ?? '—'}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{v.workerName ?? '—'}</td>
                      <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">
                        {formatDateTime(v.checkInAt)}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {v.durationMinutes != null ? `${v.durationMinutes}m` : '—'}
                      </td>
                      <td className="py-2 pr-3">
                        {v.billableUnits != null ? (
                          <Badge variant="outline" className="text-xs">{v.billableUnits}</Badge>
                        ) : '—'}
                      </td>
                      <td className="py-2 pr-3">
                        <BillingStatusBadge isBillable={v.isBillable} visitStatus={v.visitStatus} />
                      </td>
                      {tab === 'not_billable' && (
                        <td className="py-2">
                          <ValidationIssueList issues={v.billingIssues} visitId={v.id} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
