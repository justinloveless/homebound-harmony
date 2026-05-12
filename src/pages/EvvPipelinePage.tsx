import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Clock, CheckCircle, XCircle, AlertTriangle, Send, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

interface QueueEntry {
  id: string;
  evvVisitId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

interface PipelineStatus {
  counts: Record<string, number>;
  deadLetters: QueueEntry[];
}

const STATUS_META: Record<string, { label: string; icon: React.ElementType; color: string; cardColor: string }> = {
  pending:    { label: 'Pending',    icon: Clock,         color: 'text-blue-700',   cardColor: 'bg-blue-50 border-blue-200' },
  processing: { label: 'Processing', icon: Send,          color: 'text-yellow-700', cardColor: 'bg-yellow-50 border-yellow-200' },
  retrying:   { label: 'Retrying',   icon: RotateCcw,     color: 'text-orange-700', cardColor: 'bg-orange-50 border-orange-200' },
  submitted:  { label: 'Accepted',   icon: CheckCircle,   color: 'text-green-700',  cardColor: 'bg-green-50 border-green-200' },
  rejected:   { label: 'Rejected',   icon: XCircle,       color: 'text-red-700',    cardColor: 'bg-red-50 border-red-200' },
  dead_letter:{ label: 'Dead Letter',icon: AlertTriangle, color: 'text-red-800',    cardColor: 'bg-red-100 border-red-300' },
};

const DISPLAY_ORDER = ['pending', 'processing', 'retrying', 'submitted', 'rejected', 'dead_letter'];

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function EvvPipelinePage() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [retryingAll, setRetryingAll] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/api/evv/admin/pipeline') as PipelineStatus;
      setStatus(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load pipeline status';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const retryEntry = async (entry: QueueEntry) => {
    setRetrying((prev) => new Set(prev).add(entry.id));
    try {
      await api.post('/api/evv/admin/retry', { ids: [entry.id] });
      toast.success('Queued for retry');
      await refresh();
    } catch {
      toast.error('Retry failed');
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  };

  const retryAll = async () => {
    setRetryingAll(true);
    try {
      const result = await api.post('/api/evv/admin/retry', {}) as { retried: number };
      toast.success(`${result.retried} entr${result.retried === 1 ? 'y' : 'ies'} queued for retry`);
      await refresh();
    } catch {
      toast.error('Retry failed');
    } finally {
      setRetryingAll(false);
    }
  };

  const deadLetterCount = status?.counts['dead_letter'] ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">EVV Submission Pipeline</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Texas HHSC EVV aggregator submission status — auto-refreshes every 30s
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Status Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {DISPLAY_ORDER.map((statusKey) => {
          const meta = STATUS_META[statusKey];
          const count = status?.counts[statusKey] ?? 0;
          const Icon = meta.icon;
          return (
            <Card key={statusKey} className={`border ${meta.cardColor}`}>
              <CardContent className="p-4">
                <div className={`flex items-center gap-1.5 text-xs font-medium ${meta.color} mb-1`}>
                  <Icon className="h-3.5 w-3.5" />
                  {meta.label}
                </div>
                <div className={`text-2xl font-bold ${meta.color}`}>{count}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Dead Letter Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Dead Letter Queue</CardTitle>
          {deadLetterCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void retryAll()}
              disabled={retryingAll}
            >
              <RotateCcw className={`h-4 w-4 mr-2 ${retryingAll ? 'animate-spin' : ''}`} />
              Retry All ({deadLetterCount})
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {!status || status.deadLetters.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {loading ? 'Loading…' : 'No dead-letter entries — all submissions are healthy.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Visit ID</th>
                    <th className="pb-2 pr-4 font-medium">Attempts</th>
                    <th className="pb-2 pr-4 font-medium">Last Attempt</th>
                    <th className="pb-2 pr-4 font-medium">Error</th>
                    <th className="pb-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {status.deadLetters.map((entry) => (
                    <tr key={entry.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                        {entry.evvVisitId.slice(0, 8)}…
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
                          {entry.attempts}/{entry.maxAttempts}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {formatRelative(entry.lastAttemptAt)}
                      </td>
                      <td className="py-2 pr-4 max-w-xs">
                        <span className="text-red-700 text-xs truncate block" title={entry.errorMessage ?? ''}>
                          {entry.errorMessage ?? '—'}
                        </span>
                      </td>
                      <td className="py-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void retryEntry(entry)}
                          disabled={retrying.has(entry.id)}
                        >
                          <RotateCcw className={`h-3.5 w-3.5 mr-1.5 ${retrying.has(entry.id) ? 'animate-spin' : ''}`} />
                          Retry
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

      {/* Pipeline explanation */}
      <Card className="bg-muted/30">
        <CardContent className="p-4 text-xs text-muted-foreground space-y-1">
          <p><strong>Pending</strong> — Awaiting first submission attempt.</p>
          <p><strong>Processing</strong> — Currently being submitted to the aggregator.</p>
          <p><strong>Retrying</strong> — Previous attempt failed; scheduled for exponential-backoff retry.</p>
          <p><strong>Accepted</strong> — Aggregator confirmed receipt. Visit is EVV-compliant.</p>
          <p><strong>Rejected</strong> — Aggregator rejected the record. Review billing issues on the visit.</p>
          <p><strong>Dead Letter</strong> — Exceeded {5} retry attempts. Manual intervention required.</p>
        </CardContent>
      </Card>
    </div>
  );
}
