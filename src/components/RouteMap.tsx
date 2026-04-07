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
}

export default function RouteMap({ workerAddress, workerCoords, visits, clients }: RouteMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<google.maps.Map | null>(null);
  const directionsRenderer = useRef<google.maps.DirectionsRenderer | null>(null);

  useEffect(() => {
    if (!mapRef.current || visits.length === 0) return;

    let cancelled = false;

    async function init() {
      const g = await waitForGoogle();
      if (cancelled || !mapRef.current) return;

      // Build waypoints from visit order
      const visitClients = visits.map(v => clients.find(c => c.id === v.clientId)).filter(Boolean) as Client[];

      // Create map
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

      // Directions
      const renderer = new g.maps.DirectionsRenderer({
        map,
        suppressMarkers: true,
        polylineOptions: { strokeColor: '#0891b2', strokeWeight: 4, strokeOpacity: 0.8 },
      });
      directionsRenderer.current = renderer;

      const directionsService = new g.maps.DirectionsService();

      const origin = workerAddress;
      const destination = workerAddress; // return home
      const waypoints: google.maps.DirectionsWaypoint[] = visitClients.map(c => ({
        location: c.address,
        stopover: true,
      }));

      try {
        const result = await directionsService.route({
          origin,
          destination,
          waypoints,
          optimizeWaypoints: false, // keep our optimized order
          travelMode: g.maps.TravelMode.DRIVING,
        });
        renderer.setDirections(result);

        // Add home marker at start
        const route = result.routes[0];
        if (route?.legs?.[0]?.start_location) {
          new g.maps.Marker({
            position: route.legs[0].start_location,
            map,
            label: { text: '🏠', fontSize: '18px' },
            title: 'Home',
          });
        }
        // Add numbered stop markers
        if (route?.legs) {
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
              }
            }
          });
        }
      } catch (err) {
        console.error('Directions request failed:', err);
        // Fallback: just show markers without route
        if (workerCoords) {
          new g.maps.Marker({
            position: { lat: workerCoords.lat, lng: workerCoords.lon },
            map,
            label: '🏠',
          });
        }
        visitClients.forEach((c, i) => {
          if (c.coords) {
            new g.maps.Marker({
              position: { lat: c.coords.lat, lng: c.coords.lon },
              map,
              label: String(i + 1),
            });
          }
        });
      }
    }

    init();

    return () => {
      cancelled = true;
      if (directionsRenderer.current) {
        directionsRenderer.current.setMap(null);
        directionsRenderer.current = null;
      }
      mapInstance.current = null;
    };
  }, [workerAddress, workerCoords, visits, clients]);

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
