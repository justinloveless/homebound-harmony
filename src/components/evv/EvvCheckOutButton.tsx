import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';
import { GpsStatusIndicator } from './GpsStatusIndicator';
import { useGeolocation } from '@/hooks/useGeolocation';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import type { EventGps } from '@/types/events';

interface Props {
  visitId: string;
  clientName: string;
  onCheckOut: (result: { durationMinutes: number; billableUnits: number }) => void;
}

export function EvvCheckOutButton({ visitId, clientName, onCheckOut }: Props) {
  const [loading, setLoading] = useState(false);
  const [acquiring, setAcquiring] = useState(false);
  const [gps, setGps] = useState<EventGps | null>(null);
  const { ensureClinicalFix } = useGeolocation();

  const handleCheckOut = async () => {
    setAcquiring(true);
    const fix = await ensureClinicalFix();
    setGps(fix);
    setAcquiring(false);

    if (!fix) {
      toast.error('GPS required for check-out. Please enable location services.');
      return;
    }

    setLoading(true);
    try {
      const result = await api.post<{ durationMinutes: number; billableUnits: number }>(
        `/api/evv/${visitId}/check-out`,
        {
          gps: {
            lat: fix.lat,
            lon: fix.lon,
            accuracyM: fix.accuracyM,
            capturedAt: fix.capturedAt,
            staleSeconds: fix.staleSeconds,
          },
        },
      );
      toast.success(`Checked out from ${clientName} — ${result.durationMinutes} min, ${result.billableUnits} units`);
      onCheckOut(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Check-out failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        size="lg"
        variant="destructive"
        className="h-16 w-full text-lg font-semibold"
        onClick={handleCheckOut}
        disabled={loading || acquiring}
      >
        <LogOut className="h-5 w-5 mr-2" />
        {acquiring ? 'Getting GPS...' : loading ? 'Checking out...' : 'Check Out'}
      </Button>
      <GpsStatusIndicator gps={gps} acquiring={acquiring} />
    </div>
  );
}
