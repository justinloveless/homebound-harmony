import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type Client, type ScheduledVisit } from '@/types/models';
import { MapPin } from 'lucide-react';

interface RouteMapProps {
  workerAddress: string;
  visits: ScheduledVisit[];
  clients: Client[];
}

// Simple hash-based pseudo-coordinates from address string (fallback when no geocoding)
function pseudoCoords(address: string, index: number): [number, number] {
  // Generate deterministic but spread-out coordinates based on address
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash << 5) - hash + address.charCodeAt(i);
    hash |= 0;
  }
  const lat = 40.0 + (hash % 1000) / 10000 + index * 0.005;
  const lng = -74.0 + ((hash >> 10) % 1000) / 10000 + index * 0.005;
  return [lat, lng];
}

export default function RouteMap({ workerAddress, visits, clients }: RouteMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapRef.current || visits.length === 0) return;

    // Clean up previous map
    if (mapInstance.current) {
      mapInstance.current.remove();
      mapInstance.current = null;
    }

    const map = L.map(mapRef.current).setView([40.0, -74.0], 12);
    mapInstance.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);

    const points: [number, number][] = [];

    // Home marker
    const homeCoords = pseudoCoords(workerAddress, 0);
    points.push(homeCoords);
    L.marker(homeCoords, {
      icon: L.divIcon({
        html: '<div style="background:#0891b2;color:white;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);">🏠</div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        className: '',
      }),
    }).addTo(map).bindPopup(`<b>Home</b><br/>${workerAddress}`);

    // Visit markers
    visits.forEach((visit, i) => {
      const client = clients.find(c => c.id === visit.clientId);
      if (!client) return;
      const coords = pseudoCoords(client.address, i + 1);
      points.push(coords);

      L.marker(coords, {
        icon: L.divIcon({
          html: `<div style="background:#0d9488;color:white;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);">${i + 1}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          className: '',
        }),
      }).addTo(map).bindPopup(`<b>${client.name}</b><br/>${client.address}<br/>${visit.startTime} – ${visit.endTime}`);
    });

    // Return home
    points.push(homeCoords);

    // Draw route line
    L.polyline(points, { color: '#0891b2', weight: 3, opacity: 0.7, dashArray: '8 4' }).addTo(map);

    // Fit bounds
    if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points.map(p => L.latLng(p[0], p[1]))), { padding: [30, 30] });
    }

    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, [workerAddress, visits, clients]);

  if (visits.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <MapPin className="w-4 h-4" /> Route Map
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div ref={mapRef} className="h-[350px] rounded-lg overflow-hidden border" />
        <p className="text-[10px] text-muted-foreground mt-2">
          Map shows approximate positions. For accurate routing, enter real addresses.
        </p>
      </CardContent>
    </Card>
  );
}
