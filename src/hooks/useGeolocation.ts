import { useCallback, useRef } from 'react';
import type { EventGps } from '@/types/events';

function readPosition(pos: GeolocationPosition): EventGps {
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracyM: pos.coords.accuracy,
    capturedAt: new Date(pos.timestamp).toISOString(),
  };
}

/**
 * Best-effort GPS for clinical audit events. Call `ensureClinicalFix` before
 * enqueueing client/share/visit events.
 */
export function useGeolocation() {
  const lastRef = useRef<EventGps | null>(null);
  const watchIdRef = useRef<number | null>(null);

  const startWatching = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    if (watchIdRef.current != null) return;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        lastRef.current = readPosition(pos);
      },
      () => { /* denied or error — lastRef may stay null */ },
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 30_000 },
    );
  }, []);

  const stopWatching = useCallback(() => {
    if (watchIdRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  /** One-shot high-accuracy read, then update lastRef. */
  const ensureClinicalFix = useCallback((): Promise<EventGps | null> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const g = readPosition(pos);
          lastRef.current = g;
          resolve(g);
        },
        () => resolve(lastRef.current),
        { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
      );
    });
  }, []);

  const currentFix = useCallback((): EventGps | null => lastRef.current, []);

  return { startWatching, stopWatching, ensureClinicalFix, currentFix };
}
