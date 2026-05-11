import { MapPin } from 'lucide-react';
import type { EventGps } from '@/types/events';

interface Props {
  gps: EventGps | null;
  acquiring?: boolean;
}

export function GpsStatusIndicator({ gps, acquiring }: Props) {
  if (acquiring) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-600">
        <MapPin className="h-3.5 w-3.5 animate-pulse" />
        <span>Acquiring GPS...</span>
      </div>
    );
  }

  if (!gps) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-destructive">
        <MapPin className="h-3.5 w-3.5" />
        <span>No GPS signal</span>
      </div>
    );
  }

  const quality = gps.accuracyM <= 10 ? 'high' : gps.accuracyM <= 50 ? 'medium' : 'low';
  const color = quality === 'high' ? 'text-green-600' : quality === 'medium' ? 'text-amber-600' : 'text-destructive';

  return (
    <div className={`flex items-center gap-1.5 text-xs ${color}`}>
      <MapPin className="h-3.5 w-3.5" />
      <span>{Math.round(gps.accuracyM)}m accuracy</span>
    </div>
  );
}
