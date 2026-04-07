import React, { useState, useMemo } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { generateWeekSchedule, recalcDaySchedule } from '@/lib/scheduler';
import { DAY_LABELS, DAYS_OF_WEEK, PERIOD_LABELS, type DayOfWeek, type WeekSchedule, type DaySchedule, type ScheduledVisit } from '@/types/models';
import { CalendarDays, Clock, MapPin, RotateCw, CheckCircle2, AlertCircle, ArrowUp, ArrowDown, Trash2, Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import RouteMap from '@/components/RouteMap';
import { formatTime } from '@/lib/format-time';
import { getTimeDependentTravelTimes } from '@/lib/google-maps';

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
  const [refining, setRefining] = useState(false);
  const [refineProgress, setRefineProgress] = useState('');

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

  /** Refine a schedule's travel times using Google Maps with departure times */
  const refineWithGoogle = async (schedule: WeekSchedule) => {
    setRefining(true);
    const refinedDays = [...schedule.days];

    try {
      for (let di = 0; di < refinedDays.length; di++) {
        const day = refinedDays[di];
        setRefineProgress(`Refining ${DAY_LABELS[day.day]} (${di + 1}/${refinedDays.length})...`);

        // Build ordered address list: home → clients → home
        const addresses: string[] = [worker.homeAddress];
        const visitClients = day.visits.map(v => clients.find(c => c.id === v.clientId)).filter(Boolean);
        for (const c of visitClients) {
          if (c) addresses.push(c.address);
        }
        addresses.push(worker.homeAddress); // return home

        // Build departure time from schedule date + leave time
        const departureDate = new Date(`${day.date}T${day.leaveHomeTime}:00`);

        const { durationInTraffic } = await getTimeDependentTravelTimes(
          addresses,
          departureDate,
          (msg) => setRefineProgress(`${DAY_LABELS[day.day]}: ${msg}`),
        );

        // Rebuild the day schedule with refined travel times
        const workStart = worker.workingHours.startTime.split(':').map(Number);
        const workStartMin = workStart[0] * 60 + workStart[1];
        let currentTime = workStartMin;
        const refinedVisits: ScheduledVisit[] = [];

        for (let i = 0; i < day.visits.length; i++) {
          const visit = day.visits[i];
          const client = clients.find(c => c.id === visit.clientId);
          if (!client) continue;

          const travelMin = durationInTraffic[i] ?? visit.travelTimeFromPrev;
          const windowStart = (() => {
            const tw = client.timeWindows.find(tw => tw.day === day.day);
            return tw ? tw.startTime.split(':').map(Number).reduce((h, m) => h * 60 + m) : workStartMin;
          })();

          let arrival = Math.max(currentTime + travelMin, windowStart);

          // Skip over breaks
          for (const b of worker.breaks) {
            const bs = b.startTime.split(':').map(Number).reduce((h: number, m: number) => h * 60 + m);
            const be = b.endTime.split(':').map(Number).reduce((h: number, m: number) => h * 60 + m);
            if (arrival < be && arrival + client.visitDurationMinutes > bs) {
              arrival = be;
            }
          }

          const endMin = arrival + client.visitDurationMinutes;
          const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

          refinedVisits.push({
            clientId: visit.clientId,
            startTime: toTime(arrival),
            endTime: toTime(endMin),
            travelTimeFromPrev: travelMin,
          });

          currentTime = endMin;
        }

        // Travel home (last leg)
        const travelHome = durationInTraffic[day.visits.length] ?? (() => {
          const lastId = day.visits[day.visits.length - 1]?.clientId ?? 'home';
          return travelTimes[`${['home', lastId].sort().join('|')}`] ?? 15;
        })();

        const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const totalTravel = refinedVisits.reduce((s, v) => s + v.travelTimeFromPrev, 0) + travelHome;

        refinedDays[di] = {
          ...day,
          visits: refinedVisits,
          totalTravelMinutes: totalTravel,
          leaveHomeTime: refinedVisits.length > 0
            ? toTime(refinedVisits[0].startTime.split(':').map(Number).reduce((h, m) => h * 60 + m) - refinedVisits[0].travelTimeFromPrev)
            : day.leaveHomeTime,
          arriveHomeTime: toTime(currentTime + travelHome),
        };
      }

      const totalTravel = refinedDays.reduce((s, d) => s + d.totalTravelMinutes, 0);
      const totalAway = refinedDays.reduce((s, d) => {
        const leave = d.leaveHomeTime.split(':').map(Number);
        const arrive = d.arriveHomeTime.split(':').map(Number);
        return s + ((arrive[0] * 60 + arrive[1]) - (leave[0] * 60 + leave[1]));
      }, 0);

      const refined: WeekSchedule = { ...schedule, days: refinedDays, totalTravelMinutes: totalTravel, totalTimeAwayMinutes: totalAway };
      setSchedule(refined);
      toast.success(`Travel times refined with Google Maps traffic data`);
    } catch (err) {
      console.error('Refine failed:', err);
      toast.error('Failed to refine travel times with Google Maps');
    } finally {
      setRefining(false);
      setRefineProgress('');
    }
  };

  const handleGenerate = async () => {
    const weekStart = getMonday();
    const schedule = generateWeekSchedule(worker, clients, travelTimes, weekStart);
    setSchedule(schedule);
    toast.success(`Schedule generated — refining with Google Maps...`);
    await refineWithGoogle(schedule);
  };

  const selectedDaySchedule = lastSchedule?.days.find(d => d.day === selectedDay);

  // --- Manual editing helpers ---
  const updateDayInSchedule = (updatedDay: DaySchedule | null, originalDay: DayOfWeek) => {
    if (!lastSchedule) return;
    let newDays: DaySchedule[];
    if (updatedDay) {
      const exists = lastSchedule.days.some(d => d.day === originalDay);
      if (exists) {
        newDays = lastSchedule.days.map(d => d.day === originalDay ? updatedDay : d);
      } else {
        newDays = [...lastSchedule.days, updatedDay].sort(
          (a, b) => DAYS_OF_WEEK.indexOf(a.day) - DAYS_OF_WEEK.indexOf(b.day)
        );
      }
    } else {
      newDays = lastSchedule.days.filter(d => d.day !== originalDay);
    }

    const totalTravel = newDays.reduce((s, d) => s + d.totalTravelMinutes, 0);
    const totalAway = newDays.reduce((s, d) => {
      const leave = d.leaveHomeTime.split(':').map(Number);
      const arrive = d.arriveHomeTime.split(':').map(Number);
      return s + ((arrive[0] * 60 + arrive[1]) - (leave[0] * 60 + leave[1]));
    }, 0);

    setSchedule({ ...lastSchedule, days: newDays, totalTravelMinutes: totalTravel, totalTimeAwayMinutes: totalAway });
  };

  const moveVisit = (daySchedule: DaySchedule, visitIndex: number, direction: -1 | 1) => {
    const newVisits = [...daySchedule.visits];
    const targetIdx = visitIndex + direction;
    if (targetIdx < 0 || targetIdx >= newVisits.length) return;
    [newVisits[visitIndex], newVisits[targetIdx]] = [newVisits[targetIdx], newVisits[visitIndex]];

    const recalced = recalcDaySchedule(newVisits, daySchedule.day, daySchedule.date, worker, clients, travelTimes);
    updateDayInSchedule(recalced, daySchedule.day);
  };

  const removeVisit = (daySchedule: DaySchedule, visitIndex: number) => {
    const newVisits = daySchedule.visits.filter((_, i) => i !== visitIndex);
    if (newVisits.length === 0) {
      updateDayInSchedule(null, daySchedule.day);
    } else {
      const recalced = recalcDaySchedule(newVisits, daySchedule.day, daySchedule.date, worker, clients, travelTimes);
      updateDayInSchedule(recalced, daySchedule.day);
    }
    toast.success('Visit removed');
  };

  const addClientToDay = (clientId: string, day: DayOfWeek) => {
    if (!lastSchedule) return;
    const client = clients.find(c => c.id === clientId);
    if (!client) return;

    const existingDay = lastSchedule.days.find(d => d.day === day);
    const existingVisits = existingDay ? [...existingDay.visits] : [];

    // Add with placeholder times - recalc will fix them
    existingVisits.push({
      clientId,
      startTime: '00:00',
      endTime: '00:00',
      travelTimeFromPrev: 0,
    });

    const date = existingDay?.date ?? (() => {
      const dayIndex = DAYS_OF_WEEK.indexOf(day);
      const dateObj = new Date(lastSchedule.weekStartDate);
      dateObj.setDate(dateObj.getDate() + dayIndex);
      return dateObj.toISOString().split('T')[0];
    })();

    const recalced = recalcDaySchedule(existingVisits, day, date, worker, clients, travelTimes);
    updateDayInSchedule(recalced, day);
    toast.success(`${client.name} added to ${DAY_LABELS[day]}`);
  };

  // Clients not on the currently selected day
  const availableForDay = useMemo(() => {
    if (!selectedDay || !lastSchedule) return [];
    const daySchedule = lastSchedule.days.find(d => d.day === selectedDay);
    const onDay = new Set(daySchedule?.visits.map(v => v.clientId) ?? []);
    return clients.filter(c => !onDay.has(c.id));
  }, [selectedDay, lastSchedule, clients]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Schedule</h1>
          <p className="text-sm text-muted-foreground">
            {refining
              ? refineProgress
              : lastSchedule
                ? `Week of ${lastSchedule.weekStartDate} • ${lastSchedule.totalTravelMinutes} min total travel`
                : 'Generate an optimized weekly schedule'}
          </p>
        </div>
        <Button onClick={handleGenerate} disabled={!canGenerate || refining}>
          {refining ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Refining...</>
          ) : (
            <><RotateCw className="w-4 h-4 mr-2" /> {lastSchedule ? 'Regenerate' : 'Generate Schedule'}</>
          )}
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
                            <span className="text-muted-foreground ml-auto shrink-0">{formatTime(v.startTime)}</span>
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
                        <p>{formatTime(selectedDaySchedule.leaveHomeTime)}</p>
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
                            <div className="w-8 h-8 rounded-full bg-secondary/20 flex items-center justify-center text-secondary font-bold text-xs shrink-0">{i + 1}</div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium">{client?.name}</p>
                              <p className="text-muted-foreground text-xs truncate">{client?.address}</p>
                              <p className="text-muted-foreground text-xs">{formatTime(visit.startTime)} – {formatTime(visit.endTime)} ({client?.visitDurationMinutes}min)</p>
                            </div>
                            <div className="flex flex-col gap-1 shrink-0">
                              <Button variant="ghost" size="icon" className="h-6 w-6" disabled={i === 0}
                                onClick={() => moveVisit(selectedDaySchedule, i, -1)}>
                                <ArrowUp className="w-3 h-3" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-6 w-6" disabled={i === selectedDaySchedule.visits.length - 1}
                                onClick={() => moveVisit(selectedDaySchedule, i, 1)}>
                                <ArrowDown className="w-3 h-3" />
                              </Button>
                            </div>
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive shrink-0"
                              onClick={() => removeVisit(selectedDaySchedule, i)}>
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold">🏠</div>
                      <div>
                        <p className="font-medium text-foreground">Arrive Home</p>
                        <p>{formatTime(selectedDaySchedule.arriveHomeTime)}</p>
                      </div>
                    </div>

                    {availableForDay.length > 0 && (
                      <div className="pt-3 border-t">
                        <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                          <Plus className="w-3 h-3" /> Add a client to this day
                        </p>
                        <Select onValueChange={(id) => addClientToDay(id, selectedDaySchedule.day)}>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Select a client..." />
                          </SelectTrigger>
                          <SelectContent>
                            {availableForDay.map(c => (
                              <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <RouteMap
                  workerAddress={worker.homeAddress}
                  workerCoords={worker.homeCoords}
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
