import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { generateWeekSchedule, recalcDaySchedule } from '@/lib/scheduler';
import { DAY_LABELS, DAYS_OF_WEEK, PERIOD_LABELS, type DayOfWeek, type WeekSchedule, type DaySchedule, type ScheduledVisit, type SavedSchedule } from '@/types/models';
import { CalendarDays, Clock, MapPin, RotateCw, CheckCircle2, AlertCircle, ArrowUp, ArrowDown, Trash2, Plus, Loader2, Save, FolderOpen, X, Eye, Pencil } from 'lucide-react';
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
  const { workspace, setSchedule, saveSchedule, loadSavedSchedule, deleteSavedSchedule, renameSavedSchedule } = useWorkspace();
  const { worker, clients, travelTimes, lastSchedule } = workspace;
  const savedSchedules = workspace.savedSchedules ?? [];
  const [selectedDay, setSelectedDay] = useState<DayOfWeek | null>(null);
  const [refining, setRefining] = useState(false);
  const [refineProgress, setRefineProgress] = useState('');
  const calendarScrollRef = useRef<HTMLDivElement>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [compareId, setCompareId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

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

  // Auto-scroll calendar to working hours
  const scrollToWorkHours = useCallback(() => {
    if (calendarScrollRef.current) {
      const whStart = worker.workingHours.startTime.split(':').map(Number);
      const scrollTo = Math.max(0, (whStart[0] - 1) * 48); // 1 hour before work start
      calendarScrollRef.current.scrollTop = scrollTo;
    }
  }, [worker.workingHours.startTime]);

  useEffect(() => {
    if (lastSchedule) {
      // Small delay to let the DOM render
      setTimeout(scrollToWorkHours, 100);
    }
  }, [lastSchedule, scrollToWorkHours]);

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

        const { durationInTraffic, distanceMiles } = await getTimeDependentTravelTimes(
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
            travelDistanceMiFromPrev: distanceMiles[i] ?? undefined,
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

  const handleCreateBlank = () => {
    const weekStart = getMonday();
    const workDays = DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d));
    const days: DaySchedule[] = workDays.map((day, i) => {
      const dateObj = new Date(weekStart);
      dateObj.setDate(dateObj.getDate() + DAYS_OF_WEEK.indexOf(day));
      return {
        day,
        date: dateObj.toISOString().split('T')[0],
        visits: [],
        totalTravelMinutes: 0,
        leaveHomeTime: worker.workingHours.startTime,
        arriveHomeTime: worker.workingHours.startTime,
      };
    });
    const blank: WeekSchedule = {
      weekStartDate: weekStart,
      days,
      totalTravelMinutes: 0,
      totalTimeAwayMinutes: 0,
    };
    setSchedule(blank);
    setSelectedDay(workDays[0] ?? null);
    toast.success('Blank schedule created — add clients to each day in the Daily View');
  };

  const selectedDaySchedule = lastSchedule?.days.find(d => d.day === selectedDay);

  // --- Manual editing helpers ---
  /** Refine a single day's travel times via Google Maps */
  const refineSingleDay = async (daySchedule: DaySchedule) => {
    if (daySchedule.visits.length === 0) return daySchedule;

    try {
      const addresses: string[] = [worker.homeAddress];
      const visitClients = daySchedule.visits.map(v => clients.find(c => c.id === v.clientId)).filter(Boolean);
      for (const c of visitClients) {
        if (c) addresses.push(c.address);
      }
      addresses.push(worker.homeAddress);

      const departureDate = new Date(`${daySchedule.date}T${daySchedule.leaveHomeTime}:00`);
      const { durationInTraffic, distanceMiles } = await getTimeDependentTravelTimes(addresses, departureDate);

      const workStart = worker.workingHours.startTime.split(':').map(Number);
      const workStartMin = workStart[0] * 60 + workStart[1];
      let currentTime = workStartMin;
      const refinedVisits: ScheduledVisit[] = [];

      for (let i = 0; i < daySchedule.visits.length; i++) {
        const visit = daySchedule.visits[i];
        const client = clients.find(c => c.id === visit.clientId);
        if (!client) continue;

        const travelMin = durationInTraffic[i] ?? visit.travelTimeFromPrev;
        const windowStart = (() => {
          const tw = client.timeWindows.find(tw => tw.day === daySchedule.day);
          return tw ? tw.startTime.split(':').map(Number).reduce((h, m) => h * 60 + m) : workStartMin;
        })();

        let arrival = Math.max(currentTime + travelMin, windowStart);
        for (const b of worker.breaks) {
          const bs = b.startTime.split(':').map(Number).reduce((h: number, m: number) => h * 60 + m);
          const be = b.endTime.split(':').map(Number).reduce((h: number, m: number) => h * 60 + m);
          if (arrival < be && arrival + client.visitDurationMinutes > bs) arrival = be;
        }

        const endMin = arrival + client.visitDurationMinutes;
        const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        refinedVisits.push({
          clientId: visit.clientId,
          startTime: toTime(arrival),
          endTime: toTime(endMin),
          travelTimeFromPrev: travelMin,
          travelDistanceMiFromPrev: distanceMiles[i] ?? undefined,
        });
        currentTime = endMin;
      }

      const travelHome = durationInTraffic[daySchedule.visits.length] ?? 15;
      const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const totalTravel = refinedVisits.reduce((s, v) => s + v.travelTimeFromPrev, 0) + travelHome;

      return {
        ...daySchedule,
        visits: refinedVisits,
        totalTravelMinutes: totalTravel,
        leaveHomeTime: refinedVisits.length > 0
          ? toTime(refinedVisits[0].startTime.split(':').map(Number).reduce((h, m) => h * 60 + m) - refinedVisits[0].travelTimeFromPrev)
          : daySchedule.leaveHomeTime,
        arriveHomeTime: toTime(currentTime + travelHome),
      };
    } catch (err) {
      console.error('Single day refine failed:', err);
      return daySchedule;
    }
  };

  const updateDayInSchedule = async (updatedDay: DaySchedule | null, originalDay: DayOfWeek) => {
    if (!lastSchedule) return;
    let newDays: DaySchedule[];
    if (updatedDay) {
      // Refine this day via Google Maps
      const refined = await refineSingleDay(updatedDay);
      const exists = lastSchedule.days.some(d => d.day === originalDay);
      if (exists) {
        newDays = lastSchedule.days.map(d => d.day === originalDay ? refined : d);
      } else {
        newDays = [...lastSchedule.days, refined].sort(
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
        <div className="flex gap-2">
          {lastSchedule && (
            <Button variant="outline" onClick={() => { setSaveName(`Schedule ${savedSchedules.length + 1}`); setShowSaveDialog(true); }}>
              <Save className="w-4 h-4 mr-2" /> Save
            </Button>
          )}
          <Button onClick={handleGenerate} disabled={!canGenerate || refining}>
            {refining ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Refining...</>
            ) : (
              <><RotateCw className="w-4 h-4 mr-2" /> {lastSchedule ? 'Regenerate' : 'Generate Schedule'}</>
            )}
          </Button>
        </div>
      </div>

      {/* Save dialog */}
      {showSaveDialog && (
        <Card>
          <CardContent className="py-3 flex items-center gap-3">
            <input
              className="flex-1 h-8 rounded border border-input bg-background px-3 text-sm"
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              placeholder="Schedule name..."
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter' && saveName.trim()) {
                  saveSchedule(saveName.trim());
                  setShowSaveDialog(false);
                  toast.success(`Schedule saved as "${saveName.trim()}"`);
                }
              }}
            />
            <Button size="sm" onClick={() => {
              if (saveName.trim()) {
                saveSchedule(saveName.trim());
                setShowSaveDialog(false);
                toast.success(`Schedule saved as "${saveName.trim()}"`);
              }
            }}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowSaveDialog(false)}>
              <X className="w-4 h-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Saved schedules */}
      {savedSchedules.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <FolderOpen className="w-4 h-4" /> Saved Schedules ({savedSchedules.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {savedSchedules.map(s => (
                <div key={s.id} className="flex items-center gap-2 text-sm">
                  {renamingId === s.id ? (
                    <input
                      className="flex-1 h-7 rounded border border-input bg-background px-2 text-xs"
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter') { renameSavedSchedule(s.id, renameValue); setRenamingId(null); }
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => { renameSavedSchedule(s.id, renameValue); setRenamingId(null); }}
                    />
                  ) : (
                    <span className="flex-1 truncate">{s.name}</span>
                  )}
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {s.schedule.totalTravelMinutes}m travel · {s.schedule.days.reduce((n, d) => n + d.visits.length, 0)} visits
                  </span>
                  <Button variant="ghost" size="icon" className="h-6 w-6" title="Rename"
                    onClick={() => { setRenamingId(s.id); setRenameValue(s.name); }}>
                    <Pencil className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6" title="Compare side-by-side"
                    onClick={() => setCompareId(compareId === s.id ? null : s.id)}>
                    <Eye className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6" title="Load this schedule"
                    onClick={() => { loadSavedSchedule(s.id); toast.success(`Loaded "${s.name}"`); }}>
                    <FolderOpen className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="Delete"
                    onClick={() => { deleteSavedSchedule(s.id); if (compareId === s.id) setCompareId(null); toast.success('Deleted'); }}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Comparison view */}
      {compareId && lastSchedule && (() => {
        const compareSchedule = savedSchedules.find(s => s.id === compareId);
        if (!compareSchedule) return null;
        const current = lastSchedule;
        const saved = compareSchedule.schedule;
        return (
          <Card className="border-primary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span>Comparing: Current vs "{compareSchedule.name}"</span>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setCompareId(null)}>
                  <X className="w-4 h-4" />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="font-semibold mb-2">Current Schedule</p>
                  <div className="space-y-1 text-xs">
                    <p>Travel: <span className="font-bold">{current.totalTravelMinutes} min</span></p>
                    <p>Time away: <span className="font-bold">{Math.floor(current.totalTimeAwayMinutes / 60)}h {current.totalTimeAwayMinutes % 60}m</span></p>
                    <p>Days: <span className="font-bold">{current.days.length}</span></p>
                    <p>Visits: <span className="font-bold">{current.days.reduce((n, d) => n + d.visits.length, 0)}</span></p>
                    {current.days.map(d => (
                      <p key={d.day} className="text-muted-foreground">{DAY_LABELS[d.day]}: {d.visits.length} visits, {d.totalTravelMinutes}m</p>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="font-semibold mb-2">{compareSchedule.name}</p>
                  <div className="space-y-1 text-xs">
                    <p>Travel: <span className="font-bold">{saved.totalTravelMinutes} min</span></p>
                    <p>Time away: <span className="font-bold">{Math.floor(saved.totalTimeAwayMinutes / 60)}h {saved.totalTimeAwayMinutes % 60}m</span></p>
                    <p>Days: <span className="font-bold">{saved.days.length}</span></p>
                    <p>Visits: <span className="font-bold">{saved.days.reduce((n, d) => n + d.visits.length, 0)}</span></p>
                    {saved.days.map(d => (
                      <p key={d.day} className="text-muted-foreground">{DAY_LABELS[d.day]}: {d.visits.length} visits, {d.totalTravelMinutes}m</p>
                    ))}
                  </div>
                </div>
              </div>
              {/* Diff summary */}
              <div className="mt-3 pt-3 border-t text-xs">
                {(() => {
                  const travelDiff = current.totalTravelMinutes - saved.totalTravelMinutes;
                  const awayDiff = current.totalTimeAwayMinutes - saved.totalTimeAwayMinutes;
                  return (
                    <div className="flex gap-4">
                      <span className={travelDiff < 0 ? 'text-green-600' : travelDiff > 0 ? 'text-destructive' : 'text-muted-foreground'}>
                        Travel: {travelDiff > 0 ? '+' : ''}{travelDiff} min
                      </span>
                      <span className={awayDiff < 0 ? 'text-green-600' : awayDiff > 0 ? 'text-destructive' : 'text-muted-foreground'}>
                        Time away: {awayDiff > 0 ? '+' : ''}{awayDiff} min
                      </span>
                    </div>
                  );
                })()}
              </div>
            </CardContent>
          </Card>
        );
      })()}

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
            {(() => {
              // Timeline calendar: 24h vertical axis, 7 day columns
              const HOUR_HEIGHT = 48; // px per hour
              const TOTAL_HEIGHT = 24 * HOUR_HEIGHT;
              const MIN_HEIGHT = TOTAL_HEIGHT / (24 * 60); // px per minute
              const hours = Array.from({ length: 24 }, (_, i) => i);

              return (
                <div className="border rounded-lg overflow-hidden bg-card">
                  {/* Legend */}
                  <div className="flex items-center gap-4 px-3 py-2 border-b bg-muted/30 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-primary/20 border border-primary/30" /> Travel</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-primary border border-primary" /> Visit</span>
                  </div>
                  <div ref={calendarScrollRef} className="flex overflow-x-auto overflow-y-auto max-h-[600px]"
                    style={{ scrollBehavior: 'smooth' }}>
                    {/* Time labels column */}
                    <div className="shrink-0 w-12 border-r bg-muted/20" style={{ height: TOTAL_HEIGHT }}>
                      {hours.map(h => (
                        <div key={h} className="border-b border-border/50 text-[10px] text-muted-foreground text-right pr-1.5 pt-0.5" style={{ height: HOUR_HEIGHT }}>
                          {h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}
                        </div>
                      ))}
                    </div>

                    {/* Day columns */}
                    {DAYS_OF_WEEK.map(day => {
                      const daySchedule = lastSchedule.days.find(d => d.day === day);
                      const isDayOff = worker.daysOff.includes(day);

                      // Working hours background
                      const whStart = worker.workingHours.startTime.split(':').map(Number);
                      const whEnd = worker.workingHours.endTime.split(':').map(Number);
                      const whStartMin = whStart[0] * 60 + whStart[1];
                      const whEndMin = whEnd[0] * 60 + whEnd[1];

                      return (
                        <div key={day} className="flex-1 min-w-[100px] border-r last:border-r-0 relative" style={{ height: TOTAL_HEIGHT }}>
                          {/* Day header (sticky) */}
                          <div className={`sticky top-0 z-10 text-center py-1 border-b text-xs font-semibold ${isDayOff ? 'bg-muted/60 text-muted-foreground' : 'bg-card'}`}>
                            {DAY_LABELS[day]}
                            {daySchedule && (
                              <div className="text-[9px] font-normal text-muted-foreground leading-tight">
                                {daySchedule.visits.length} visits · {daySchedule.totalTravelMinutes}m
                                {(() => {
                                  const mi = daySchedule.visits.reduce((s, v) => s + (v.travelDistanceMiFromPrev ?? 0), 0);
                                  return mi > 0 ? ` · ${mi.toFixed(1)}mi` : '';
                                })()}
                              </div>
                            )}
                          </div>

                          {/* Hour grid lines */}
                          {hours.map(h => (
                            <div key={h} className="absolute left-0 right-0 border-b border-border/30" style={{ top: h * HOUR_HEIGHT, height: HOUR_HEIGHT }} />
                          ))}

                          {/* Working hours background */}
                          {!isDayOff && (
                            <div className="absolute left-0 right-0 bg-primary/[0.03]"
                              style={{ top: whStartMin * MIN_HEIGHT, height: (whEndMin - whStartMin) * MIN_HEIGHT }} />
                          )}

                          {/* Break shading */}
                          {!isDayOff && worker.breaks.map((b, bi) => {
                            const bs = b.startTime.split(':').map(Number);
                            const be = b.endTime.split(':').map(Number);
                            const bStartMin = bs[0] * 60 + bs[1];
                            const bEndMin = be[0] * 60 + be[1];
                            return (
                              <div key={bi} className="absolute left-0 right-0 bg-muted/40 border-y border-dashed border-muted-foreground/20"
                                style={{ top: bStartMin * MIN_HEIGHT, height: (bEndMin - bStartMin) * MIN_HEIGHT }}>
                                <span className="text-[8px] text-muted-foreground px-0.5 truncate block">{b.label}</span>
                              </div>
                            );
                          })}

                          {/* Visits + travel blocks */}
                          {daySchedule?.visits.map((v, i) => {
                            const client = clients.find(c => c.id === v.clientId);
                            const startMin = v.startTime.split(':').map(Number).reduce((h, m) => h * 60 + m);
                            const endMin = v.endTime.split(':').map(Number).reduce((h, m) => h * 60 + m);
                            const visitDuration = endMin - startMin;
                            const travelStart = startMin - v.travelTimeFromPrev;

                            return (
                              <React.Fragment key={i}>
                                {/* Travel block */}
                                {v.travelTimeFromPrev > 0 && (
                                  <div
                                    className="absolute left-0.5 right-0.5 rounded-sm bg-accent/40 border border-accent/60 overflow-hidden cursor-pointer"
                                    style={{ top: travelStart * MIN_HEIGHT, height: Math.max(v.travelTimeFromPrev * MIN_HEIGHT, 2) }}
                                    onClick={() => setSelectedDay(day)}
                                    title={`${v.travelTimeFromPrev} min drive`}
                                  >
                                    {v.travelTimeFromPrev >= 15 && (
                                      <span className="text-[8px] text-accent-foreground/70 px-1 truncate block">{v.travelTimeFromPrev}m</span>
                                    )}
                                  </div>
                                )}
                                {/* Visit block */}
                                <div
                                  className="absolute left-0.5 right-0.5 rounded-sm bg-primary text-primary-foreground overflow-hidden cursor-pointer hover:brightness-110 transition-all"
                                  style={{ top: startMin * MIN_HEIGHT, height: Math.max(visitDuration * MIN_HEIGHT, 8) }}
                                  onClick={() => setSelectedDay(day)}
                                  title={`${client?.name}: ${formatTime(v.startTime)} – ${formatTime(v.endTime)}`}
                                >
                                  <div className="px-1 py-0.5">
                                    <p className="text-[10px] font-medium truncate">{client?.name}</p>
                                    {visitDuration >= 20 && (
                                      <p className="text-[8px] opacity-80">{formatTime(v.startTime)}</p>
                                    )}
                                  </div>
                                </div>
                              </React.Fragment>
                            );
                          })}

                          {/* Travel home block (last leg) */}
                          {daySchedule && daySchedule.visits.length > 0 && (() => {
                            const lastVisit = daySchedule.visits[daySchedule.visits.length - 1];
                            const lastEndMin = lastVisit.endTime.split(':').map(Number).reduce((h, m) => h * 60 + m);
                            const arriveMin = daySchedule.arriveHomeTime.split(':').map(Number).reduce((h, m) => h * 60 + m);
                            const travelHomeMin = arriveMin - lastEndMin;
                            if (travelHomeMin <= 0) return null;
                            return (
                              <div
                                className="absolute left-0.5 right-0.5 rounded-sm bg-accent/40 border border-accent/60 overflow-hidden"
                                style={{ top: lastEndMin * MIN_HEIGHT, height: Math.max(travelHomeMin * MIN_HEIGHT, 2) }}
                                title={`${travelHomeMin} min drive home`}
                              >
                                {travelHomeMin >= 15 && (
                                  <span className="text-[8px] text-accent-foreground/70 px-1 truncate block">{travelHomeMin}m 🏠</span>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

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

            {lastSchedule.clientGroups && Object.keys(lastSchedule.clientGroups).length > 0 && (
              <Card>
                <CardContent className="pt-5">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Scheduling Groups</p>
                  <div className="flex gap-4 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="w-5 h-5 rounded bg-primary/15 text-primary flex items-center justify-center text-[10px] font-bold">A</span>
                      <span className="text-muted-foreground">
                        {DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d)).filter((_, i) => i % 2 === 0).map(d => DAY_LABELS[d]).join(', ')}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-5 h-5 rounded bg-secondary/30 text-secondary-foreground flex items-center justify-center text-[10px] font-bold">B</span>
                      <span className="text-muted-foreground">
                        {DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d)).filter((_, i) => i % 2 === 1).map(d => DAY_LABELS[d]).join(', ')}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

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
                        const clientDays = lastSchedule.days.filter(d => d.visits.some(v => v.clientId === c.id));
                        const group = lastSchedule.clientGroups?.[c.id];
                        return (
                          <div key={c.id} className="text-xs flex items-center justify-between gap-2">
                            <span className="truncate">{c.name}</span>
                            <div className="flex items-center gap-1 shrink-0">
                              {group && (
                                <Badge variant={group === 'A' ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0">
                                  {group}
                                </Badge>
                              )}
                              {clientDays.map(d => (
                                <Badge key={d.day} variant="outline" className="text-[10px]">{DAY_LABELS[d.day]}</Badge>
                              ))}
                            </div>
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
                    {/* Daily totals */}
                    <div className="flex flex-wrap gap-4 text-xs pb-2 border-b">
                      <div>
                        <span className="text-muted-foreground">Travel: </span>
                        <span className="font-semibold">{selectedDaySchedule.totalTravelMinutes} min</span>
                      </div>
                      {(() => {
                        const totalMiles = selectedDaySchedule.visits.reduce((s, v) => s + (v.travelDistanceMiFromPrev ?? 0), 0);
                        return totalMiles > 0 ? (
                          <div>
                            <span className="text-muted-foreground">Distance: </span>
                            <span className="font-semibold">{totalMiles.toFixed(1)} mi</span>
                          </div>
                        ) : null;
                      })()}
                      <div>
                        <span className="text-muted-foreground">Away: </span>
                        <span className="font-semibold">{formatTime(selectedDaySchedule.leaveHomeTime)} – {formatTime(selectedDaySchedule.arriveHomeTime)}</span>
                      </div>
                    </div>
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
                            <Clock className="w-3 h-3" /> {visit.travelTimeFromPrev} min{visit.travelDistanceMiFromPrev != null ? ` · ${visit.travelDistanceMiFromPrev} mi` : ''} drive
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
