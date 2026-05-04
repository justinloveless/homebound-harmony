import { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type Client, type ScheduledVisit, type Coords } from '@/types/models';
import { MapPin } from 'lucide-react';
import { waitForGoogle } from '@/lib/google-maps';
import { formatTime } from '@/lib/format-time';

interface RouteMapProps {
  workerAddress: string;
  workerCoords?: Coords;
  visits: ScheduledVisit[];
  clients: Client[];
  /** When set, highlight the leg FROM this visit index TO the next stop */
  highlightLegIndex?: number | null;
}

export default function RouteMap({ workerAddress, workerCoords, visits, clients, highlightLegIndex }: RouteMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<google.maps.Map | null>(null);
  const legPolylines = useRef<google.maps.Polyline[]>([]);
  const markersRef = useRef<google.maps.Marker[]>([]);

  // Draw the route once when visits change
  useEffect(() => {
    if (!mapRef.current || visits.length === 0) return;

    let cancelled = false;

    async function init() {
      const g = await waitForGoogle();
      if (cancelled || !mapRef.current) return;

      const visitClients = visits.map(v => clients.find(c => c.id === v.clientId)).filter(Boolean) as Client[];

      const center = workerCoords
        ? { lat: workerCoords.lat, lng: workerCoords.lon }
        : { lat: 40.0, lng: -74.0 };

      const map = new g.maps.Map(mapRef.current, {
        center,
        zoom: 12,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
      });
      mapInstance.current = map;

      const directionsService = new g.maps.DirectionsService();

      const origin = workerAddress;
      const destination = workerAddress;
      const waypoints: google.maps.DirectionsWaypoint[] = visitClients.map(c => ({
        location: c.address,
        stopover: true,
      }));

      try {
        const result = await directionsService.route({
          origin,
          destination,
          waypoints,
          optimizeWaypoints: false,
          travelMode: g.maps.TravelMode.DRIVING,
        });

        const route = result.routes[0];
        if (!route?.legs) return;

        // Draw each leg as a separate polyline
        const polylines: google.maps.Polyline[] = [];
        route.legs.forEach((leg, i) => {
          const path = leg.steps.flatMap(step => {
            const decoded = g.maps.geometry?.encoding?.decodePath(step.polyline?.points ?? '');
            return decoded ?? [];
          });

          // Fallback if geometry library isn't loaded: use start/end
          const finalPath = path.length > 0 ? path : [leg.start_location, leg.end_location].filter(Boolean) as google.maps.LatLng[];

          const polyline = new g.maps.Polyline({
            path: finalPath,
            strokeColor: '#0891b2',
            strokeWeight: 4,
            strokeOpacity: 0.5,
            map,
          });
          polylines.push(polyline);
        });
        legPolylines.current = polylines;

        // Fit bounds
        const bounds = new g.maps.LatLngBounds();
        route.legs.forEach(leg => {
          if (leg.start_location) bounds.extend(leg.start_location);
          if (leg.end_location) bounds.extend(leg.end_location);
        });
        map.fitBounds(bounds);

        // Home marker
        if (route.legs[0]?.start_location) {
          const marker = new g.maps.Marker({
            position: route.legs[0].start_location,
            map,
            label: { text: '🏠', fontSize: '18px' },
            title: 'Home',
          });
          markersRef.current.push(marker);
        }

        // Stop markers
        route.legs.forEach((leg, i) => {
          if (i < visits.length) {
            const visit = visits[i];
            const client = visitClients[i];
            if (client && leg.end_location) {
              const infoWindow = new g.maps.InfoWindow({
                content: `<div style="font-size:13px;max-width:200px;"><b>${i + 1}. ${client.name}</b><br/>${formatTime(visit.startTime)} – ${formatTime(visit.endTime)}<br/><span style="color:#666;">${client.address}</span></div>`,
              });
              const marker = new g.maps.Marker({
                position: leg.end_location,
                map,
                label: { text: String(i + 1), color: 'white', fontWeight: 'bold' },
              });
              marker.addListener('click', () => infoWindow.open(map, marker));
              markersRef.current.push(marker);
            }
          }
        });
      } catch (err) {
        console.error('Directions request failed:', err);
        if (workerCoords) {
          const m = new g.maps.Marker({
            position: { lat: workerCoords.lat, lng: workerCoords.lon },
            map,
            label: '🏠',
          });
          markersRef.current.push(m);
        }
        visitClients.forEach((c, i) => {
          if (c.coords) {
            const m = new g.maps.Marker({
              position: { lat: c.coords.lat, lng: c.coords.lon },
              map,
              label: String(i + 1),
            });
            markersRef.current.push(m);
          }
        });
      }
    }

    init();

    return () => {
      cancelled = true;
      legPolylines.current.forEach(p => p.setMap(null));
      legPolylines.current = [];
      markersRef.current.forEach(m => m.setMap(null));
      markersRef.current = [];
      mapInstance.current = null;
    };
  }, [workerAddress, workerCoords, visits, clients]);

  // Update polyline styles when highlightLegIndex changes
  useEffect(() => {
    const polylines = legPolylines.current;
    if (polylines.length === 0) return;

    const hasHighlight = highlightLegIndex != null && highlightLegIndex >= 0;

    polylines.forEach((p, i) => {
      if (hasHighlight) {
        // Leg i+1 = departing from visit i to the next stop
        const isHighlighted = i === highlightLegIndex! + 1;
        p.setOptions({
          strokeOpacity: isHighlighted ? 1.0 : 0.4,
          strokeWeight: isHighlighted ? 6 : 3,
          strokeColor: isHighlighted ? '#0ea5e9' : '#0891b2',
        });
      } else {
        p.setOptions({
          strokeOpacity: 0.5,
          strokeWeight: 4,
          strokeColor: '#0891b2',
        });
      }
    });
  }, [highlightLegIndex]);

  if (visits.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <MapPin className="w-4 h-4" /> Route Map
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div ref={mapRef} className="h-[350px] rounded-lg overflow-hidden border" />
      </CardContent>
    </Card>
  );
}
