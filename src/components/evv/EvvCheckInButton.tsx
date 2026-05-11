import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { LogIn } from 'lucide-react';
import { GpsStatusIndicator } from './GpsStatusIndicator';
import { useGeolocation } from '@/hooks/useGeolocation';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import type { EventGps } from '@/types/events';

interface Props {
  clientId: string;
  clientName: string;
  scheduleVisitId?: string;
  onCheckIn: (visitId: string) => void;
}

export function EvvCheckInButton({ clientId, clientName, scheduleVisitId, onCheckIn }: Props) {
  const [loading, setLoading] = useState(false);
  const [acquiring, setAcquiring] = useState(false);
  const [gps, setGps] = useState<EventGps | null>(null);
  const { ensureClinicalFix } = useGeolocation();

  const handleCheckIn = async () => {
    setAcquiring(true);
    const fix = await ensureClinicalFix();
    setGps(fix);
    setAcquiring(false);

    if (!fix) {
      toast.error('GPS required for check-in. Please enable location services.');
      return;
    }

    setLoading(true);
    try {
      const result = await api.post<{ id: string }>('/api/evv/check-in', {
        clientId,
        scheduleVisitId,
        verificationMethod: 'gps',
        gps: {
          lat: fix.lat,
          lon: fix.lon,
          accuracyM: fix.accuracyM,
          capturedAt: fix.capturedAt,
          staleSeconds: fix.staleSeconds,
        },
      });
      toast.success(`Checked in for ${clientName}`);
      onCheckIn(result.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Check-in failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        size="lg"
        className="h-16 w-full text-lg font-semibold"
        onClick={handleCheckIn}
        disabled={loading || acquiring}
      >
        <LogIn className="h-5 w-5 mr-2" />
        {acquiring ? 'Getting GPS...' : loading ? 'Checking in...' : 'Check In'}
      </Button>
      <GpsStatusIndicator gps={gps} acquiring={acquiring} />
    </div>
  );
}
