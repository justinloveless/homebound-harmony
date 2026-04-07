import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Clock, MapPin, CalendarDays, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { DAY_LABELS, type DayOfWeek, DAYS_OF_WEEK } from '@/types/models';

export default function Dashboard() {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const { worker, clients, lastSchedule } = workspace;

  const today = DAYS_OF_WEEK[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1] as DayOfWeek;
  const todaySchedule = lastSchedule?.days.find(d => d.day === today);

  const needsSetup = !worker.name || !worker.homeAddress || clients.length === 0;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
          {worker.name ? `Hey, ${worker.name.split(' ')[0]}` : 'Welcome to RouteCare'}
        </h1>
        <p className="text-muted-foreground mt-1">
          {todaySchedule
            ? `${todaySchedule.visits.length} visits today • ${todaySchedule.totalTravelMinutes} min travel`
            : 'No schedule generated yet'}
        </p>
      </div>

      {needsSetup && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex items-start gap-3 pt-5">
            <AlertCircle className="w-5 h-5 text-primary mt-0.5 shrink-0" />
            <div className="space-y-2">
              <p className="text-sm font-medium">Complete your setup</p>
              <div className="flex flex-wrap gap-2">
                {!worker.name && (
                  <Button size="sm" variant="outline" onClick={() => navigate('/settings')}>
                    Add your profile
                  </Button>
                )}
                {clients.length === 0 && (
                  <Button size="sm" variant="outline" onClick={() => navigate('/clients')}>
                    Add clients
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => navigate('/clients')}>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Users className="w-4 h-4" />
              <span className="text-xs font-medium">Clients</span>
            </div>
            <p className="text-2xl font-bold">{clients.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Clock className="w-4 h-4" />
              <span className="text-xs font-medium">Travel Today</span>
            </div>
            <p className="text-2xl font-bold">{todaySchedule?.totalTravelMinutes ?? '—'}<span className="text-sm font-normal text-muted-foreground"> min</span></p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <MapPin className="w-4 h-4" />
              <span className="text-xs font-medium">Visits Today</span>
            </div>
            <p className="text-2xl font-bold">{todaySchedule?.visits.length ?? 0}</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => navigate('/schedule')}>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <CalendarDays className="w-4 h-4" />
              <span className="text-xs font-medium">Week Travel</span>
            </div>
            <p className="text-2xl font-bold">{lastSchedule?.totalTravelMinutes ?? '—'}<span className="text-sm font-normal text-muted-foreground"> min</span></p>
          </CardContent>
        </Card>
      </div>

      {todaySchedule && todaySchedule.visits.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Today's Route</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs">🏠</div>
                <div>
                  <p className="font-medium text-foreground">Leave Home</p>
                  <p>{todaySchedule.leaveHomeTime}</p>
                </div>
              </div>
              {todaySchedule.visits.map((visit, i) => {
                const client = clients.find(c => c.id === visit.clientId);
                return (
                  <div key={i} className="flex items-center gap-3 text-sm">
                    <div className="w-8 h-8 rounded-full bg-secondary/20 flex items-center justify-center text-secondary font-bold text-xs">{i + 1}</div>
                    <div className="flex-1">
                      <p className="font-medium">{client?.name ?? 'Unknown'}</p>
                      <p className="text-muted-foreground">{visit.startTime} – {visit.endTime} • {visit.travelTimeFromPrev} min drive</p>
                    </div>
                  </div>
                );
              })}
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs">🏠</div>
                <div>
                  <p className="font-medium text-foreground">Arrive Home</p>
                  <p>{todaySchedule.arriveHomeTime}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {!todaySchedule && !needsSetup && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <CalendarDays className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="font-medium">No schedule for today</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4">Generate a schedule to see your optimized route</p>
            <Button onClick={() => navigate('/schedule')}>Generate Schedule</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
