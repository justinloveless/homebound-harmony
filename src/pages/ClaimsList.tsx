import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Download, FilePlus } from 'lucide-react';
import { toast } from 'sonner';

interface ClaimBatch {
  id: string;
  visitCount: number;
  totalUnits: number;
  dateRangeStart: string;
  dateRangeEnd: string;
  status: string;
  createdAt: string;
}

export default function ClaimsList() {
  const navigate = useNavigate();
  const [batches, setBatches] = useState<ClaimBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/api/billing/claims') as { batches: ClaimBatch[] };
      setBatches(data.batches.slice().reverse());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load claim batches');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Default date range: current month
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
    setDateStart(`${y}-${m}-01`);
    setDateEnd(`${y}-${m}-${String(lastDay).padStart(2, '0')}`);
    void refresh();
  }, [refresh]);

  const generate = async () => {
    if (!dateStart || !dateEnd) {
      toast.error('Select a date range first');
      return;
    }
    setGenerating(true);
    try {
      const result = await api.post('/api/billing/claims/generate', {
        dateRangeStart: dateStart,
        dateRangeEnd: dateEnd,
      }) as { batchId: string; visitCount: number; totalUnits: number };
      toast.success(`Generated batch: ${result.visitCount} visits, ${result.totalUnits} units`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const downloadCsv = (batch: ClaimBatch) => {
    const url = `/api/billing/claims/${batch.id}/csv`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `claims-${batch.dateRangeStart}-to-${batch.dateRangeEnd}.csv`;
    a.click();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Claim Exports</h1>
          <p className="text-sm text-muted-foreground mt-1">Generate and download CMS-compliant claim CSV files</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate('/billing')}>
            ← Billing Dashboard
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Generate New Batch */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generate New Batch</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Exports all billable, unclaimed visits in the selected date range to CSV. Visits are marked as claimed
            and won't appear in future batches.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Start Date</label>
              <Input
                type="date"
                value={dateStart}
                onChange={(e) => setDateStart(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">End Date</label>
              <Input
                type="date"
                value={dateEnd}
                onChange={(e) => setDateEnd(e.target.value)}
                className="w-40"
              />
            </div>
            <Button onClick={() => void generate()} disabled={generating || !dateStart || !dateEnd}>
              <FilePlus className={`h-4 w-4 mr-2 ${generating ? 'animate-spin' : ''}`} />
              {generating ? 'Generating…' : 'Generate Claims'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Batch History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Export History</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>
          ) : batches.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No exports yet. Generate your first claim batch above.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground text-xs">
                    <th className="pb-2 pr-4 font-medium">Date Range</th>
                    <th className="pb-2 pr-4 font-medium">Visits</th>
                    <th className="pb-2 pr-4 font-medium">Units</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Generated</th>
                    <th className="pb-2 font-medium">Download</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 pr-4 font-medium">
                        {b.dateRangeStart} → {b.dateRangeEnd}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline">{b.visitCount}</Badge>
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline">{b.totalUnits}</Badge>
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                          {b.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {new Date(b.createdAt).toLocaleString('en-US', {
                          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
                        })}
                      </td>
                      <td className="py-2">
                        <Button size="sm" variant="outline" onClick={() => downloadCsv(b)}>
                          <Download className="h-3.5 w-3.5 mr-1.5" />
                          CSV
                        </Button>
                      </td>
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
