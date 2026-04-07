/// <reference types="google.maps" />
import { useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { travelKey, DEFAULT_TRAVEL_TIME } from '@/types/models';
import { getDistanceMatrixBatched } from '@/lib/google-maps';
import { toast } from 'sonner';
import { RefreshCw, Loader2, AlertTriangle } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export default function TravelTimes() {
  const { workspace, setTravelTimes, setTravelTimeErrors } = useWorkspace();
  const { clients, travelTimes, travelTimeErrors } = workspace;
  const [calculating, setCalculating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [retryOnly, setRetryOnly] = useState(false);

  const locations = [
    { id: 'home', name: '🏠 Home', address: workspace.worker.homeAddress },
    ...clients.map(c => ({ id: c.id, name: c.name, address: c.address })),
  ];

  const getValue = (a: string, b: string) => travelTimes[travelKey(a, b)] ?? DEFAULT_TRAVEL_TIME;
  const getError = (a: string, b: string) => (travelTimeErrors ?? {})[travelKey(a, b)];

  const handleChange = (a: string, b: string, value: number) => {
    const key = travelKey(a, b);
    setTravelTimes({ ...travelTimes, [key]: value });
    // Clear error for manually edited cell
    if (travelTimeErrors?.[key]) {
      const { [key]: _, ...rest } = travelTimeErrors;
      setTravelTimeErrors(rest);
    }
  };

  const hasErrors = Object.keys(travelTimeErrors ?? {}).length > 0;

  const handleCalculateAll = async (onlyFailed = false) => {
    const withAddresses = locations.filter(l => l.address.trim());
    if (withAddresses.length < 2) {
      toast.error('Need at least 2 locations with addresses');
      return;
    }

    setCalculating(true);
    setProgress(0);
    setRetryOnly(onlyFailed);

    try {
      const addresses = withAddresses.map(l => l.address);

      // Build the pairs we need to calculate
      // For retry, only calculate pairs that have errors
      const pairsToCalc: { i: number; j: number }[] = [];
      for (let i = 0; i < withAddresses.length; i++) {
        for (let j = i + 1; j < withAddresses.length; j++) {
          const key = travelKey(withAddresses[i].id, withAddresses[j].id);
          if (!onlyFailed || (travelTimeErrors ?? {})[key]) {
            pairsToCalc.push({ i, j });
          }
        }
      }

      if (pairsToCalc.length === 0) {
        toast.info('No failed pairs to retry');
        setCalculating(false);
        return;
      }

      const results = await getDistanceMatrixBatched(
        addresses,
        addresses,
        (done, total) => setProgress(Math.round((done / total) * 100)),
      );

      const updated = { ...travelTimes };
      const errors = { ...(travelTimeErrors ?? {}) };
      let successCount = 0;
      let failCount = 0;

      for (const result of results) {
        const oi = result.originIndex;
        const di = result.destIndex;
        if (oi >= di) continue; // Only need upper triangle

        const key = travelKey(withAddresses[oi].id, withAddresses[di].id);

        // Skip if this pair wasn't in our target set
        if (onlyFailed && !pairsToCalc.some(p => p.i === oi && p.j === di)) continue;

        if (result.durationMinutes !== null) {
          updated[key] = result.durationMinutes;
          delete errors[key];
          successCount++;
        } else {
          errors[key] = result.error || 'Calculation failed';
          failCount++;
        }
      }

      setTravelTimes(updated);
      setTravelTimeErrors(errors);

      if (failCount > 0) {
        toast.warning(`Calculated ${successCount} travel times. ${failCount} failed — see warning icons.`);
      } else {
        toast.success(`Calculated ${successCount} travel times via Google Maps`);
      }
    } catch (err) {
      console.error(err);
      toast.error('Failed to calculate travel times. Check your API key and addresses.');
    } finally {
      setCalculating(false);
      setProgress(0);
    }
  };

  if (clients.length === 0) {
    return (
      <div className="space-y-6 max-w-4xl">
        <h1 className="text-2xl font-bold tracking-tight">Travel Times</h1>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <p className="font-medium">No clients yet</p>
            <p className="text-sm text-muted-foreground mt-1">Add clients first to set up travel times</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Travel Times</h1>
            <p className="text-sm text-muted-foreground">Estimated drive time in minutes between locations</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {hasErrors && (
              <Button variant="outline" onClick={() => handleCalculateAll(true)} disabled={calculating}>
                {calculating && retryOnly ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <AlertTriangle className="w-4 h-4 mr-2 text-warning" />}
                Retry Failed
              </Button>
            )}
            <Button onClick={() => handleCalculateAll(false)} disabled={calculating}>
              {calculating && !retryOnly ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              {calculating && !retryOnly ? 'Calculating...' : 'Calculate All'}
            </Button>
          </div>
        </div>

        {calculating && (
          <div className="space-y-1">
            <Progress value={progress} className="h-2" />
            <p className="text-xs text-muted-foreground text-center">{progress}% complete</p>
          </div>
        )}

        <Card>
          <CardContent className="pt-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left p-2 font-medium text-muted-foreground sticky left-0 bg-card z-10">From ↓ / To →</th>
                  {locations.map(loc => (
                    <th key={loc.id} className="p-2 text-center font-medium text-muted-foreground min-w-[80px]">
                      <span className="text-xs">{loc.name}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {locations.map(from => (
                  <tr key={from.id} className="border-t">
                    <td className="p-2 font-medium text-xs sticky left-0 bg-card z-10">{from.name}</td>
                    {locations.map(to => {
                      const error = from.id !== to.id ? getError(from.id, to.id) : undefined;
                      return (
                        <td key={to.id} className="p-1 text-center">
                          {from.id === to.id ? (
                            <span className="text-muted-foreground/30">—</span>
                          ) : (
                            <div className="relative inline-flex items-center">
                              <Input
                                type="number"
                                min={1}
                                value={getValue(from.id, to.id)}
                                onChange={e => handleChange(from.id, to.id, Number(e.target.value))}
                                className={`w-16 h-8 text-xs text-center mx-auto ${error ? 'border-destructive/50' : ''}`}
                              />
                              {error && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <AlertTriangle className="w-3.5 h-3.5 text-destructive absolute -top-1 -right-1 cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[200px]">
                                    <p className="text-xs">{error}</p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          Default: {DEFAULT_TRAVEL_TIME} minutes. Click "Calculate All" to auto-fill using real Google Maps driving times. You can still manually override any value.
        </p>
      </div>
    </TooltipProvider>
  );
}
