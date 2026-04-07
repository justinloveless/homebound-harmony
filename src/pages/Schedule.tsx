import React, { useState, useMemo } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { generateWeekSchedule } from '@/lib/scheduler';
import { DAY_LABELS, DAYS_OF_WEEK, PERIOD_LABELS, type DayOfWeek } from '@/types/models';
import { CalendarDays, Clock, MapPin, RotateCw, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import RouteMap from '@/components/RouteMap';
import { formatTime } from '@/lib/format-time';

function getMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff)).toISOString().split('T')[0];
}

export default function Schedule() {
  const { workspace, setSchedule } = useWorkspace();
  const { worker, clients, travelTimes, lastSchedule } = workspace;
  const [selectedDay, setSelectedDay] = useState<DayOfWeek | null>(null);

  // Compute scheduled vs unscheduled clients
  const { scheduledClients, unscheduledClients } = useMemo(() => {
    if (!lastSchedule) return { scheduledClients: [] as typeof clients, unscheduledClients: [] as typeof clients };
    const scheduledIds = new Set(
      lastSchedule.days.flatMap(d => d.visits.map(v => v.clientId))
    );
    return {
      scheduledClients: clients.filter(c => scheduledIds.has(c.id)),
      unscheduledClients: clients.filter(c => !scheduledIds.has(c.id)),
    };
  }, [lastSchedule, clients]);

  const canGenerate = worker.name && worker.homeAddress && clients.length > 0;

  const handleGenerate = () => {
    const weekStart = getMonday();
    const schedule = generateWeekSchedule(worker, clients, travelTimes, weekStart);
    setSchedule(schedule);
    toast.success(`Schedule generated: ${schedule.days.length} days, ${schedule.totalTravelMinutes} min total travel`);
  };

  const selectedDaySchedule = lastSchedule?.days.find(d => d.day === selectedDay);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Schedule</h1>
          <p className="text-sm text-muted-foreground">
            {lastSchedule
              ? `Week of ${lastSchedule.weekStartDate} • ${lastSchedule.totalTravelMinutes} min total travel`
              : 'Generate an optimized weekly schedule'}
          </p>
        </div>
        <Button onClick={handleGenerate} disabled={!canGenerate}>
          <RotateCw className="w-4 h-4 mr-2" />
          {lastSchedule ? 'Regenerate' : 'Generate Schedule'}
        </Button>
      </div>

      {!canGenerate && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <p className="font-medium">Setup required</p>
            <p className="text-sm text-muted-foreground mt-1">Add your profile and clients before generating a schedule</p>
          </CardContent>
        </Card>
      )}

      {lastSchedule && (
        <Tabs defaultValue="weekly">
          <TabsList>
            <TabsTrigger value="weekly">Weekly View</TabsTrigger>
            <TabsTrigger value="daily">Daily View</TabsTrigger>
          </TabsList>

          <TabsContent value="weekly" className="space-y-4 mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {lastSchedule.days.length === 0 && (
                <p className="text-sm text-muted-foreground col-span-full">No visits could be scheduled. Check client availability windows and worker hours.</p>
              )}
              {lastSchedule.days.map(day => (
                <Card key={day.day} className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => setSelectedDay(day.day)}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{DAY_LABELS[day.day]}</CardTitle>
                      <Badge variant="secondary">{day.visits.length} visits</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {day.totalTravelMinutes}m travel</span>
                      <span>{formatTime(day.leaveHomeTime)} – {formatTime(day.arriveHomeTime)}</span>
                    </div>
                    <div className="mt-2 space-y-1">
                      {day.visits.map((v, i) => {
                        const client = clients.find(c => c.id === v.clientId);
                        return (
                          <div key={i} className="text-xs flex items-center gap-2">
                            <span className="w-4 h-4 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold shrink-0">{i + 1}</span>
                            <span className="truncate">{client?.name}</span>
                            <span className="text-muted-foreground ml-auto shrink-0">{v.startTime}</span>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card>
              <CardContent className="pt-5">
                <div className="flex flex-wrap gap-6 text-sm">
                  <div>
                    <p className="text-muted-foreground">Total Travel</p>
                    <p className="text-xl font-bold">{lastSchedule.totalTravelMinutes} min</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Total Time Away</p>
                    <p className="text-xl font-bold">{Math.floor(lastSchedule.totalTimeAwayMinutes / 60)}h {lastSchedule.totalTimeAwayMinutes % 60}m</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Scheduled Days</p>
                    <p className="text-xl font-bold">{lastSchedule.days.length}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Clients Scheduled</p>
                    <p className="text-xl font-bold">{scheduledClients.length} / {clients.length}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    Scheduled ({scheduledClients.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {scheduledClients.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No clients scheduled</p>
                  ) : (
                    <div className="space-y-1">
                      {scheduledClients.map(c => {
                        const day = lastSchedule.days.find(d => d.visits.some(v => v.clientId === c.id));
                        return (
                          <div key={c.id} className="text-xs flex items-center justify-between">
                            <span className="truncate">{c.name}</span>
                            <Badge variant="outline" className="text-[10px] shrink-0">{day ? DAY_LABELS[day.day] : ''}</Badge>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {unscheduledClients.length > 0 && (
                <Card className="border-destructive/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-destructive" />
                      Not Scheduled ({unscheduledClients.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1">
                      {unscheduledClients.map(c => (
                        <div key={c.id} className="text-xs flex items-center justify-between">
                          <span className="truncate">{c.name}</span>
                          <Badge variant="outline" className="text-[10px] shrink-0">{c.visitsPerPeriod}x {PERIOD_LABELS[c.period]}</Badge>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-2">These clients couldn't be fit into the schedule. Check their availability windows or worker hours.</p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="daily" className="space-y-4 mt-4">
            <div className="flex gap-2 flex-wrap">
              {lastSchedule.days.map(day => (
                <Button key={day.day} variant={selectedDay === day.day ? 'default' : 'outline'} size="sm"
                  onClick={() => setSelectedDay(day.day)}>
                  {DAY_LABELS[day.day]}
                </Button>
              ))}
            </div>

            {selectedDaySchedule ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <MapPin className="w-4 h-4" />
                      {DAY_LABELS[selectedDaySchedule.day]} Route
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold">🏠</div>
                      <div>
                        <p className="font-medium text-foreground">Leave Home</p>
                        <p>{selectedDaySchedule.leaveHomeTime}</p>
                      </div>
                    </div>
                    {selectedDaySchedule.visits.map((visit, i) => {
                      const client = clients.find(c => c.id === visit.clientId);
                      return (
                        <div key={i}>
                          <div className="flex items-center gap-2 ml-4 text-[10px] text-muted-foreground py-1">
                            <div className="w-px h-4 bg-border" />
                            <Clock className="w-3 h-3" /> {visit.travelTimeFromPrev} min drive
                          </div>
                          <div className="flex items-center gap-3 text-sm">
                            <div className="w-8 h-8 rounded-full bg-secondary/20 flex items-center justify-center text-secondary font-bold text-xs">{i + 1}</div>
                            <div className="flex-1">
                              <p className="font-medium">{client?.name}</p>
                              <p className="text-muted-foreground text-xs">{client?.address}</p>
                              <p className="text-muted-foreground text-xs">{visit.startTime} – {visit.endTime} ({client?.visitDurationMinutes}min visit)</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold">🏠</div>
                      <div>
                        <p className="font-medium text-foreground">Arrive Home</p>
                        <p>{selectedDaySchedule.arriveHomeTime}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <RouteMap
                  workerAddress={worker.homeAddress}
                  visits={selectedDaySchedule.visits}
                  clients={clients}
                />
              </div>
            ) : (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">Select a day to view the detailed route</p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
