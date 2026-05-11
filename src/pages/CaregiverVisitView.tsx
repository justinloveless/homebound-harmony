import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useGeolocation } from '@/hooks/useGeolocation';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EvvCheckInButton } from '@/components/evv/EvvCheckInButton';
import { EvvCheckOutButton } from '@/components/evv/EvvCheckOutButton';
import { ActiveVisitBanner } from '@/components/evv/ActiveVisitBanner';
import { GpsStatusIndicator } from '@/components/evv/GpsStatusIndicator';
import { Calendar, MapPin, Clock, PenLine } from 'lucide-react';

interface ActiveVisit {
  id: string;
  clientId: string;
  clientName: string;
  clientAddress: string;
  checkInAt: string;
  visitStatus: string;
}

export default function CaregiverVisitView() {
  const navigate = useNavigate();
  const { workspace } = useWorkspace();
  const { startWatching, currentFix } = useGeolocation();
  const [activeVisit, setActiveVisit] = useState<ActiveVisit | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchActiveVisit = useCallback(async () => {
    try {
      const data = await api.get<{ visit: ActiveVisit | null }>('/api/evv/active');
      setActiveVisit(data.visit);
    } catch {
      setActiveVisit(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    startWatching();
    fetchActiveVisit();
  }, [startWatching, fetchActiveVisit]);

  const handleCheckIn = () => {
    fetchActiveVisit();
  };

  const handleCheckOut = () => {
    setActiveVisit(null);
  };

  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const clients = workspace.clients;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-lg mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Visits</h1>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" />
            {todayStr}
          </p>
        </div>
        <GpsStatusIndicator gps={currentFix()} />
      </div>

      {activeVisit && (
        <div className="space-y-3">
          <ActiveVisitBanner
            clientName={activeVisit.clientName}
            checkInAt={activeVisit.checkInAt}
          />
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="text-sm text-muted-foreground flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" />
                {activeVisit.clientAddress || 'No address'}
              </div>
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => navigate(`/visits/${activeVisit.id}`)}
                >
                  <PenLine className="h-4 w-4 mr-2" />
                  Document Visit
                </Button>
                <EvvCheckOutButton
                  visitId={activeVisit.id}
                  clientName={activeVisit.clientName}
                  onCheckOut={handleCheckOut}
                />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {!activeVisit && (
        <div className="space-y-3">
          {clients.length === 0 ? (
            <Card>
              <CardContent className="pt-6 text-center text-muted-foreground">
                <p className="text-sm">No clients assigned yet.</p>
              </CardContent>
            </Card>
          ) : (
            clients.map((client) => (
              <Card key={client.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold">
                      {client.name}
                    </CardTitle>
                    <Badge variant="outline" className="text-[10px]">
                      <Clock className="h-3 w-3 mr-1" />
                      {client.visitDurationMinutes}min
                    </Badge>
                  </div>
                  {client.address && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {client.address}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="pt-0">
                  <EvvCheckInButton
                    clientId={client.id}
                    clientName={client.name}
                    onCheckIn={handleCheckIn}
                  />
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
