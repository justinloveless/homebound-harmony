/// <reference types="google.maps" />
import { useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { travelKey, DEFAULT_TRAVEL_TIME } from '@/types/models';
import { getDistanceMatrixSDK } from '@/lib/google-maps';
import { toast } from 'sonner';
import { RefreshCw, Loader2 } from 'lucide-react';

export default function TravelTimes() {
  const { workspace, setTravelTimes } = useWorkspace();
  const { clients, travelTimes } = workspace;
  const [calculating, setCalculating] = useState(false);

  const locations = [
    { id: 'home', name: '🏠 Home', address: workspace.worker.homeAddress },
    ...clients.map(c => ({ id: c.id, name: c.name, address: c.address })),
  ];

  const getValue = (a: string, b: string) => travelTimes[travelKey(a, b)] ?? DEFAULT_TRAVEL_TIME;

  const handleChange = (a: string, b: string, value: number) => {
    const key = travelKey(a, b);
    setTravelTimes({ ...travelTimes, [key]: value });
  };

  const handleCalculateAll = async () => {
    const withAddresses = locations.filter(l => l.address.trim());
    if (withAddresses.length < 2) {
      toast.error('Need at least 2 locations with addresses');
      return;
    }

    setCalculating(true);
    try {
      const addresses = withAddresses.map(l => l.address);
      // Use the same list for origins and destinations to get the full matrix
      const results = await getDistanceMatrixSDK(addresses, addresses);

      const updated = { ...travelTimes };
      for (let i = 0; i < withAddresses.length; i++) {
        for (let j = i + 1; j < withAddresses.length; j++) {
          const duration = results[i][j];
          if (duration !== null) {
            updated[travelKey(withAddresses[i].id, withAddresses[j].id)] = duration;
          }
        }
      }

      setTravelTimes(updated);
      toast.success(`Calculated ${withAddresses.length * (withAddresses.length - 1) / 2} travel times via Google Maps`);
    } catch (err) {
      console.error(err);
      toast.error('Failed to calculate travel times. Check your API key and addresses.');
    } finally {
      setCalculating(false);
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
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Travel Times</h1>
          <p className="text-sm text-muted-foreground">Estimated drive time in minutes between locations</p>
        </div>
        <Button onClick={handleCalculateAll} disabled={calculating}>
          {calculating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          {calculating ? 'Calculating...' : 'Calculate via Google Maps'}
        </Button>
      </div>

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
                  {locations.map(to => (
                    <td key={to.id} className="p-1 text-center">
                      {from.id === to.id ? (
                        <span className="text-muted-foreground/30">—</span>
                      ) : (
                        <Input
                          type="number"
                          min={1}
                          value={getValue(from.id, to.id)}
                          onChange={e => handleChange(from.id, to.id, Number(e.target.value))}
                          className="w-16 h-8 text-xs text-center mx-auto"
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Default: {DEFAULT_TRAVEL_TIME} minutes. Click "Calculate via Google Maps" to auto-fill using real driving times. You can still manually override any value.
      </p>
    </div>
  );
}
