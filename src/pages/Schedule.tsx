import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { generateWeekSchedule, recalcDaySchedule } from '@/lib/scheduler';
import { DAY_LABELS, DAYS_OF_WEEK, PERIOD_LABELS, type DayOfWeek, type WeekSchedule, type DaySchedule, type ScheduledVisit, type SavedSchedule } from '@/types/models';
import { CalendarDays, Clock, MapPin, RotateCw, CheckCircle2, AlertCircle, ArrowUp, ArrowDown, Trash2, Plus, Loader2, Save, FolderOpen, X, Eye, Pencil, Copy } from 'lucide-react';
import { toast } from 'sonner';
import RouteMap from '@/components/RouteMap';
import { formatTime } from '@/lib/format-time';
import { getTimeDependentTravelTimes } from '@/lib/google-maps';
import { useCalendarDrag, type DropResult } from '@/hooks/useCalendarDrag';

/** Popup state for adding/editing an event on the weekly calendar */
interface EventPopup {
  mode: 'new' | 'edit';
  day: DayOfWeek;
  startTime: string; // "HH:MM"
  duration: number; // minutes
  clientId: string;
  // For edit mode: original day & visit index
  originalDay?: DayOfWeek;
  originalIndex?: number;
  // Position for the popup
  x: number;
  y: number;
}

function getMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff)).toISOString().split('T')[0];
}

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export default function Schedule() {
  const { workspace, setSchedule, saveSchedule, loadSavedSchedule, deleteSavedSchedule, renameSavedSchedule, updateClient } = useWorkspace();
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
  const [eventPopup, setEventPopup] = useState<EventPopup | null>(null);
  const [copyMenuDay, setCopyMenuDay] = useState<DayOfWeek | null>(null);
  const [droppedClients, setDroppedClients] = useState<string[]>([]);
  const dayColumnRefs = useRef<Map<DayOfWeek, HTMLDivElement>>(new Map());

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
      setTimeout(scrollToWorkHours, 100);
    }
  }, [lastSchedule, scrollToWorkHours]);

  const canGenerate = worker.name && worker.homeAddress && clients.length > 0;

  // ========== Calendar constants (shared between render and drag) ==========
  const HOUR_HEIGHT = 48;
  const TOTAL_HEIGHT = 24 * HOUR_HEIGHT;
  const MIN_HEIGHT = TOTAL_HEIGHT / (24 * 60);

  // ========== Drag-and-drop handler ==========
  const handleDrop = useCallback((result: DropResult) => {
    console.debug('[calendar-drop] received drop result', result);
    if (!lastSchedule) {
      console.debug('[calendar-drop] aborted: no lastSchedule');
      return;
    }
    const { day, startMinute, dragInfo } = result;
    const client = clients.find(c => c.id === dragInfo.clientId);
    if (!client) {
      console.debug('[calendar-drop] aborted: client not found', { clientId: dragInfo.clientId });
      return;
    }

    // Validate: client must have a window on this day
    const tw = client.timeWindows.find(w => w.day === day);
    if (!tw) {
      console.debug('[calendar-drop] rejected: no client availability on target day', {
        client: client.name,
        day,
        timeWindows: client.timeWindows,
      });
      toast.error(`${client.name} has no availability on ${DAY_LABELS[day]}`);
      return;
    }

    const twStart = timeToMin(tw.startTime);
    const twEnd = timeToMin(tw.endTime);
    const whStart = timeToMin(worker.workingHours.startTime);
    const whEnd = timeToMin(worker.workingHours.endTime);

    // Clamp start to valid range
    let dropStart = Math.max(startMinute, twStart, whStart);
    // Round to 15-min
    dropStart = Math.round(dropStart / 15) * 15;

    console.debug('[calendar-drop] calculated drop time', {
      requestedStart: startMinute,
      dropStart,
      duration: dragInfo.durationMinutes,
      clientWindow: { start: tw.startTime, end: tw.endTime, twStart, twEnd },
      workerWindow: { start: worker.workingHours.startTime, end: worker.workingHours.endTime, whStart, whEnd },
    });

    // Check breaks
    for (const b of worker.breaks) {
      const bs = timeToMin(b.startTime);
      const be = timeToMin(b.endTime);
      if (dropStart < be && dropStart + dragInfo.durationMinutes > bs) {
        dropStart = be;
        dropStart = Math.ceil(dropStart / 15) * 15;
      }
    }

    const dropEnd = dropStart + dragInfo.durationMinutes;
    if (dropEnd > twEnd || dropEnd > whEnd) {
      console.debug('[calendar-drop] rejected: not enough room', { dropStart, dropEnd, twEnd, whEnd });
      toast.error(`Not enough room for ${client.name} at that time`);
      return;
    }

    // 1. Remove the dragged visit from its source day
    let updatedDays = lastSchedule.days.map(d => ({ ...d, visits: [...d.visits] }));

    const sourceDay = updatedDays.find(d => d.day === dragInfo.sourceDay);
    if (sourceDay) {
      console.debug('[calendar-drop] removing source visit', {
        sourceDay: dragInfo.sourceDay,
        sourceIndex: dragInfo.sourceIndex,
        beforeCount: sourceDay.visits.length,
      });
      sourceDay.visits = sourceDay.visits.filter((_, i) => i !== dragInfo.sourceIndex);
      console.debug('[calendar-drop] source visit removed', { afterCount: sourceDay.visits.length });
    }

    // 2. Get the target day's visits (after removal if same day)
    let targetDay = updatedDays.find(d => d.day === day);
    if (!targetDay) {
      const dayIndex = DAYS_OF_WEEK.indexOf(day);
      const dateObj = new Date(lastSchedule.weekStartDate);
      dateObj.setDate(dateObj.getDate() + dayIndex);
      targetDay = {
        day,
        date: dateObj.toISOString().split('T')[0],
        visits: [],
        totalTravelMinutes: 0,
        leaveHomeTime: worker.workingHours.startTime,
        arriveHomeTime: worker.workingHours.startTime,
      };
      updatedDays.push(targetDay);
    }

    // 3. Create the dragged visit (marked as manually placed)
    const droppedVisit: ScheduledVisit = {
      clientId: client.id,
      startTime: minToTime(dropStart),
      endTime: minToTime(dropEnd),
      travelTimeFromPrev: 0,
      manuallyPlaced: true,
    };

    // 4. Insert and resolve conflicts by bumping
    const existingVisits = targetDay.visits.filter(v => v.clientId !== client.id);
    const { resolvedVisits, removedClients } = resolveConflicts(
      droppedVisit, existingVisits, day, worker, clients, travelTimes
    );

    console.debug('[calendar-drop] conflicts resolved', {
      targetDay: day,
      droppedVisit,
      existingVisits,
      resolvedVisits,
      removedClients,
    });

    targetDay.visits = resolvedVisits;

    // 5. Recalculate all affected days
    const finalDays: DaySchedule[] = [];
    for (const d of updatedDays) {
      if (d.visits.length === 0) continue;
      const recalced = recalcDaySchedule(d.visits, d.day, d.date, worker, clients, travelTimes, true);
      if (recalced) finalDays.push(recalced);
    }

    finalDays.sort((a, b) => DAYS_OF_WEEK.indexOf(a.day) - DAYS_OF_WEEK.indexOf(b.day));

    const totalTravel = finalDays.reduce((s, d) => s + d.totalTravelMinutes, 0);
    const totalAway = finalDays.reduce((s, d) => {
      const leave = d.leaveHomeTime.split(':').map(Number);
      const arrive = d.arriveHomeTime.split(':').map(Number);
      return s + ((arrive[0] * 60 + arrive[1]) - (leave[0] * 60 + leave[1]));
    }, 0);

    setSchedule({ ...lastSchedule, days: finalDays, totalTravelMinutes: totalTravel, totalTimeAwayMinutes: totalAway });
    console.debug('[calendar-drop] schedule updated', {
      finalDays: finalDays.map(d => ({ day: d.day, visits: d.visits })),
      totalTravel,
      totalAway,
    });

    if (removedClients.length > 0) {
      const names = removedClients.map(id => clients.find(c => c.id === id)?.name ?? id);
      setDroppedClients(removedClients);
      toast.warning(`${names.join(', ')} couldn't fit and ${names.length === 1 ? 'was' : 'were'} removed from the schedule`);
    } else {
      toast.success(`${client.name} moved to ${DAY_LABELS[day]} at ${formatTime(minToTime(dropStart))}`);
    }
  }, [lastSchedule, clients, worker, travelTimes, setSchedule]);

  const {
    isDragging,
    dragInfo: activeDrag,
    dragPosition,
    ghostPos,
    dragClientWindows,
    isValidDropPosition,
    createDragHandlers,
    justFinishedDragRef,
  } = useCalendarDrag({
    scrollContainerRef: calendarScrollRef,
    dayColumnRefs,
    minHeight: MIN_HEIGHT,
    worker,
    clients,
    schedule: lastSchedule,
    onDrop: handleDrop,
  });

  /** Refine a schedule's travel times using Google Maps with departure times */
  const refineWithGoogle = async (schedule: WeekSchedule) => {
    setRefining(true);
    const refinedDays = [...schedule.days];

    try {
      for (let di = 0; di < refinedDays.length; di++) {
        const day = refinedDays[di];
        setRefineProgress(`Refining ${DAY_LABELS[day.day]} (${di + 1}/${refinedDays.length})...`);

        const addresses: string[] = [worker.homeAddress];
        const visitClients = day.visits.map(v => clients.find(c => c.id === v.clientId)).filter(Boolean);
        for (const c of visitClients) {
          if (c) addresses.push(c.address);
        }
        addresses.push(worker.homeAddress);

        const departureDate = new Date(`${day.date}T${day.leaveHomeTime}:00`);

        const { durationInTraffic, distanceMiles } = await getTimeDependentTravelTimes(
          addresses,
          departureDate,
          (msg) => setRefineProgress(`${DAY_LABELS[day.day]}: ${msg}`),
        );

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
          arrival = Math.ceil(arrival / 15) * 15;

          for (const b of worker.breaks) {
            const bs = b.startTime.split(':').map(Number).reduce((h: number, m: number) => h * 60 + m);
            const be = b.endTime.split(':').map(Number).reduce((h: number, m: number) => h * 60 + m);
            if (arrival < be && arrival + client.visitDurationMinutes > bs) {
              arrival = be;
              arrival = Math.ceil(arrival / 15) * 15;
            }
          }

          const endMin = arrival + client.visitDurationMinutes;
          refinedVisits.push({
            clientId: visit.clientId,
            startTime: minToTime(arrival),
            endTime: minToTime(endMin),
            travelTimeFromPrev: travelMin,
            travelDistanceMiFromPrev: distanceMiles[i] ?? undefined,
          });

          currentTime = endMin;
        }

        const travelHome = durationInTraffic[day.visits.length] ?? (() => {
          const lastId = day.visits[day.visits.length - 1]?.clientId ?? 'home';
          return travelTimes[`${['home', lastId].sort().join('|')}`] ?? 15;
        })();

        const totalTravel = refinedVisits.reduce((s, v) => s + v.travelTimeFromPrev, 0) + travelHome;

        refinedDays[di] = {
          ...day,
          visits: refinedVisits,
          totalTravelMinutes: totalTravel,
          leaveHomeTime: refinedVisits.length > 0
            ? minToTime(refinedVisits[0].startTime.split(':').map(Number).reduce((h, m) => h * 60 + m) - refinedVisits[0].travelTimeFromPrev)
            : day.leaveHomeTime,
          arriveHomeTime: minToTime(currentTime + travelHome),
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

        const earliest = Math.max(currentTime + travelMin, windowStart);
        const manualStart = visit.startTime !== '00:00' ? visit.startTime.split(':').map(Number).reduce((h, m) => h * 60 + m) : 0;
        let arrival = manualStart > earliest ? manualStart : earliest;
        arrival = Math.ceil(arrival / 15) * 15;
        for (const b of worker.breaks) {
          const bs = b.startTime.split(':').map(Number).reduce((h: number, m: number) => h * 60 + m);
          const be = b.endTime.split(':').map(Number).reduce((h: number, m: number) => h * 60 + m);
          if (arrival < be && arrival + client.visitDurationMinutes > bs) {
            arrival = be;
            arrival = Math.ceil(arrival / 15) * 15;
          }
        }

        const endMin = arrival + client.visitDurationMinutes;
        refinedVisits.push({
          clientId: visit.clientId,
          startTime: minToTime(arrival),
          endTime: minToTime(endMin),
          travelTimeFromPrev: travelMin,
          travelDistanceMiFromPrev: distanceMiles[i] ?? undefined,
        });
        currentTime = endMin;
      }

      const travelHome = durationInTraffic[daySchedule.visits.length] ?? 15;
      const totalTravel = refinedVisits.reduce((s, v) => s + v.travelTimeFromPrev, 0) + travelHome;

      return {
        ...daySchedule,
        visits: refinedVisits,
        totalTravelMinutes: totalTravel,
        leaveHomeTime: refinedVisits.length > 0
          ? minToTime(refinedVisits[0].startTime.split(':').map(Number).reduce((h, m) => h * 60 + m) - refinedVisits[0].travelTimeFromPrev)
          : daySchedule.leaveHomeTime,
        arriveHomeTime: minToTime(currentTime + travelHome),
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

  const copyDayTo = (fromDay: DayOfWeek, toDay: DayOfWeek) => {
    if (!lastSchedule) return;
    const fromSchedule = lastSchedule.days.find(d => d.day === fromDay);
    if (!fromSchedule || fromSchedule.visits.length === 0) {
      toast.error(`No visits on ${DAY_LABELS[fromDay]} to copy`);
      return;
    }

    const toDayDate = (() => {
      const existing = lastSchedule.days.find(d => d.day === toDay);
      if (existing) return existing.date;
      const dayIndex = DAYS_OF_WEEK.indexOf(toDay);
      const dateObj = new Date(lastSchedule.weekStartDate);
      dateObj.setDate(dateObj.getDate() + dayIndex);
      return dateObj.toISOString().split('T')[0];
    })();

    const copiedVisits: ScheduledVisit[] = fromSchedule.visits.map(v => ({ ...v }));
    const recalced = recalcDaySchedule(copiedVisits, toDay, toDayDate, worker, clients, travelTimes);
    updateDayInSchedule(recalced, toDay);
    setCopyMenuDay(null);
    toast.success(`Copied ${DAY_LABELS[fromDay]} → ${DAY_LABELS[toDay]}`);
  };

  // Clients not on the currently selected day
  const availableForDay = useMemo(() => {
    if (!selectedDay || !lastSchedule) return [];
    const daySchedule = lastSchedule.days.find(d => d.day === selectedDay);
    const onDay = new Set(daySchedule?.visits.map(v => v.clientId) ?? []);
    return clients.filter(c => !onDay.has(c.id));
  }, [selectedDay, lastSchedule, clients]);

  // Clients available for the popup day
  const availableForPopupDay = useMemo(() => {
    if (!eventPopup || !lastSchedule) return clients;
    const daySchedule = lastSchedule.days.find(d => d.day === eventPopup.day);
    const onDay = new Set(daySchedule?.visits.map(v => v.clientId) ?? []);
    const editingClientId = eventPopup.mode === 'edit' ? eventPopup.clientId : null;
    return clients.filter(c => !onDay.has(c.id) || c.id === editingClientId);
  }, [eventPopup?.day, eventPopup?.mode, eventPopup?.clientId, lastSchedule, clients]);

  /** Handle clicking on the weekly calendar to add a new event */
  const handleCalendarClick = (e: React.MouseEvent<HTMLDivElement>, day: DayOfWeek, pixPerMin: number) => {
    if (isDragging || justFinishedDragRef.current) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-event-block]')) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const yOffset = e.clientY - rect.top + (calendarScrollRef.current?.scrollTop ?? 0);
    const totalMinutes = yOffset / pixPerMin;
    const roundedMinutes = Math.round(totalMinutes / 15) * 15;
    const clampedMinutes = Math.max(0, Math.min(roundedMinutes, 24 * 60 - 15));
    const hours = Math.floor(clampedMinutes / 60);
    const mins = clampedMinutes % 60;
    const startTime = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;

    setEventPopup({
      mode: 'new',
      day,
      startTime,
      duration: 60,
      clientId: '',
      x: e.clientX,
      y: e.clientY,
    });
  };

  /** Open edit popup for an existing visit */
  const handleEditVisit = (e: React.MouseEvent, day: DayOfWeek, visitIndex: number, visit: ScheduledVisit) => {
    if (isDragging || justFinishedDragRef.current) return;
    e.stopPropagation();
    const startMin = visit.startTime.split(':').map(Number).reduce((h, m) => h * 60 + m);
    const endMin = visit.endTime.split(':').map(Number).reduce((h, m) => h * 60 + m);
    setEventPopup({
      mode: 'edit',
      day,
      startTime: visit.startTime,
      duration: endMin - startMin,
      clientId: visit.clientId,
      originalDay: day,
      originalIndex: visitIndex,
      x: e.clientX,
      y: e.clientY,
    });
  };

  /** Confirm adding or editing an event from the popup */
  const handleConfirmEvent = () => {
    if (!eventPopup || !eventPopup.clientId || !lastSchedule) return;
    const client = clients.find(c => c.id === eventPopup.clientId);
    if (!client) return;

    const [sh, sm] = eventPopup.startTime.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = startMin + eventPopup.duration;

    const newVisit: ScheduledVisit = {
      clientId: eventPopup.clientId,
      startTime: minToTime(startMin),
      endTime: minToTime(endMin),
      travelTimeFromPrev: 0,
    };

    if (eventPopup.mode === 'edit' && eventPopup.originalDay != null && eventPopup.originalIndex != null) {
      const origDaySchedule = lastSchedule.days.find(d => d.day === eventPopup.originalDay);
      if (origDaySchedule) {
        const remainingVisits = origDaySchedule.visits.filter((_, idx) => idx !== eventPopup.originalIndex);
        if (eventPopup.originalDay === eventPopup.day) {
          let insertIdx = remainingVisits.length;
          for (let i = 0; i < remainingVisits.length; i++) {
            const vStart = remainingVisits[i].startTime.split(':').map(Number).reduce((h, m) => h * 60 + m);
            if (startMin < vStart) { insertIdx = i; break; }
          }
          remainingVisits.splice(insertIdx, 0, newVisit);
          const date = origDaySchedule.date;
          const recalced = recalcDaySchedule(remainingVisits, eventPopup.day, date, worker, clients, travelTimes);
          updateDayInSchedule(recalced, eventPopup.day);
          toast.success(`${client.name} updated on ${DAY_LABELS[eventPopup.day]}`);
          setEventPopup(null);
          return;
        } else {
          if (remainingVisits.length === 0) {
            const newDays = lastSchedule.days.filter(d => d.day !== eventPopup.originalDay);
            const totalTravel = newDays.reduce((s, d) => s + d.totalTravelMinutes, 0);
            const totalAway = newDays.reduce((s, d) => {
              const leave = d.leaveHomeTime.split(':').map(Number);
              const arrive = d.arriveHomeTime.split(':').map(Number);
              return s + ((arrive[0] * 60 + arrive[1]) - (leave[0] * 60 + leave[1]));
            }, 0);
            setSchedule({ ...lastSchedule, days: newDays, totalTravelMinutes: totalTravel, totalTimeAwayMinutes: totalAway });
          } else {
            const recalced = recalcDaySchedule(remainingVisits, eventPopup.originalDay, origDaySchedule.date, worker, clients, travelTimes);
            updateDayInSchedule(recalced, eventPopup.originalDay);
          }
        }
      }
    }

    const targetDay = lastSchedule.days.find(d => d.day === eventPopup.day);
    const targetVisits = targetDay ? [...targetDay.visits] : [];

    let insertIdx = targetVisits.length;
    for (let i = 0; i < targetVisits.length; i++) {
      const vStart = targetVisits[i].startTime.split(':').map(Number).reduce((h, m) => h * 60 + m);
      if (startMin < vStart) { insertIdx = i; break; }
    }
    targetVisits.splice(insertIdx, 0, newVisit);

    const date = targetDay?.date ?? (() => {
      const dayIndex = DAYS_OF_WEEK.indexOf(eventPopup.day);
      const dateObj = new Date(lastSchedule.weekStartDate);
      dateObj.setDate(dateObj.getDate() + dayIndex);
      return dateObj.toISOString().split('T')[0];
    })();

    const recalced = recalcDaySchedule(targetVisits, eventPopup.day, date, worker, clients, travelTimes);
    updateDayInSchedule(recalced, eventPopup.day);
    toast.success(eventPopup.mode === 'edit' ? `${client.name} moved to ${DAY_LABELS[eventPopup.day]}` : `${client.name} added to ${DAY_LABELS[eventPopup.day]}`);
    setEventPopup(null);
  };

  const handleDeleteFromPopup = () => {
    if (!eventPopup || eventPopup.mode !== 'edit' || !lastSchedule || eventPopup.originalDay == null || eventPopup.originalIndex == null) return;
    const daySchedule = lastSchedule.days.find(d => d.day === eventPopup.originalDay);
    if (!daySchedule) return;
    removeVisit(daySchedule, eventPopup.originalIndex);
    setEventPopup(null);
  };

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
        <div className="flex gap-2 flex-wrap">
          {lastSchedule && (
            <>
              <Button variant="outline" onClick={() => { setSaveName(`Schedule ${savedSchedules.length + 1}`); setShowSaveDialog(true); }}>
                <Save className="w-4 h-4 mr-2" /> Save
              </Button>
              <Button variant="outline" onClick={() => refineWithGoogle(lastSchedule)} disabled={refining}>
                {refining ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Refining...</> : <><MapPin className="w-4 h-4 mr-2" /> Refine Travel</>}
              </Button>
            </>
          )}
          <Button variant="outline" onClick={handleCreateBlank} disabled={!worker.name || !worker.homeAddress}>
            <Plus className="w-4 h-4 mr-2" /> Blank Schedule
          </Button>
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

      {/* Unmet visits warning + drop recommendations */}
      {lastSchedule?.unmetVisits && lastSchedule.unmetVisits.length > 0 && (
        <Card className="border-destructive bg-destructive/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <AlertCircle className="w-4 h-4" />
              Schedule incomplete — {lastSchedule.unmetVisits.reduce((s, u) => s + u.missing, 0)} visit{lastSchedule.unmetVisits.reduce((s, u) => s + u.missing, 0) === 1 ? '' : 's'} couldn't fit
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-xs space-y-0.5">
              {lastSchedule.unmetVisits.map(u => {
                const c = clients.find(cl => cl.id === u.clientId);
                return (
                  <div key={u.clientId} className="flex items-center justify-between">
                    <span>{c?.name ?? u.clientId}</span>
                    <Badge variant="outline" className="text-[10px]">{u.missing} visit{u.missing > 1 ? 's' : ''} missing</Badge>
                  </div>
                );
              })}
            </div>
            {lastSchedule.recommendedDrops && lastSchedule.recommendedDrops.length > 0 && (
              <div className="pt-2 border-t space-y-2">
                <p className="text-xs font-medium">Recommended to exclude:</p>
                <div className="text-xs space-y-0.5">
                  {lastSchedule.recommendedDrops.map(id => {
                    const c = clients.find(cl => cl.id === id);
                    return (
                      <div key={id} className="flex items-center justify-between">
                        <span>{c?.name ?? id}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {c?.priority}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    const ids = lastSchedule.recommendedDrops ?? [];
                    for (const id of ids) {
                      const c = clients.find(cl => cl.id === id);
                      if (c) updateClient({ ...c, excludedFromSchedule: true });
                    }
                    toast.success(`Excluded ${ids.length} client${ids.length === 1 ? '' : 's'} — regenerating...`);
                    setTimeout(() => handleGenerate(), 100);
                  }}
                >
                  Exclude these & regenerate
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Dropped clients warning (from drag-and-drop) */}
      {droppedClients.length > 0 && (
        <Card className="border-destructive bg-destructive/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <AlertCircle className="w-4 h-4" />
              {droppedClients.length} client{droppedClients.length === 1 ? '' : 's'} removed due to scheduling conflict
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-xs space-y-0.5">
              {droppedClients.map(id => {
                const c = clients.find(cl => cl.id === id);
                return (
                  <div key={id} className="flex items-center justify-between">
                    <span>{c?.name ?? id}</span>
                    <Badge variant="outline" className="text-[10px]">{c?.visitDurationMinutes}min</Badge>
                  </div>
                );
              })}
            </div>
            <Button size="sm" variant="outline" onClick={() => setDroppedClients([])}>
              <X className="w-3 h-3 mr-1" /> Dismiss
            </Button>
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
              // Working hours
              const whStart = worker.workingHours.startTime.split(':').map(Number);
              const whEnd = worker.workingHours.endTime.split(':').map(Number);
              const whStartMin = whStart[0] * 60 + whStart[1];
              const whEndMin = whEnd[0] * 60 + whEnd[1];

              // Only show hours in the working range (with 1 hour padding)
              const startHour = Math.max(0, whStart[0] - 1);
              const endHour = Math.min(24, whEnd[0] + 2);
              const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);

              // Only show working days
              const workingDays = DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d));

              const VISIBLE_HOURS = endHour - startHour;
              const ZOOMED_HEIGHT = VISIBLE_HOURS * HOUR_HEIGHT;
              const offsetMin = startHour * 60; // minute offset for positioning

              return (
                <div className="border rounded-lg overflow-hidden bg-card">
                  {/* Legend */}
                  <div className="flex items-center gap-4 px-3 py-2 border-b bg-muted/30 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-accent/40 border border-accent/60" /> Travel</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-primary border border-primary" /> Visit</span>
                    <span className="flex items-center gap-1 text-red-600 font-medium">
                      <span className="w-3 h-3 rounded bg-red-500/30 border-2 border-red-500" /> Travel overlap
                    </span>
                    {isDragging && (
                      <span className="flex items-center gap-1 text-green-600 font-medium">
                        <span className="w-3 h-3 rounded bg-green-500/20 border border-green-500/50" /> Available window
                      </span>
                    )}
                  </div>
                  <div ref={calendarScrollRef} className={`flex overflow-x-auto overflow-y-auto max-h-[600px] ${isDragging ? 'select-none' : ''}`}
                    style={{ scrollBehavior: isDragging ? 'auto' : 'smooth' }}>
                    {/* Time labels column */}
                    <div className="shrink-0 w-12 border-r bg-muted/20" style={{ height: ZOOMED_HEIGHT }}>
                      {hours.map(h => (
                        <div key={h} className="border-b border-border/50 text-[10px] text-muted-foreground text-right pr-1.5 pt-0.5" style={{ height: HOUR_HEIGHT }}>
                          {h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}
                        </div>
                      ))}
                    </div>

                    {/* Day columns */}
                    {workingDays.map(day => {
                      const daySchedule = lastSchedule.days.find(d => d.day === day);

                      // Time window highlight for dragged client on this day
                      const dragWindow = isDragging && activeDrag
                        ? dragClientWindows.find(w => w.day === day)
                        : null;

                      return (
                        <div
                          key={day}
                          ref={(el) => { if (el) dayColumnRefs.current.set(day, el); }}
                          className="flex-1 min-w-[100px] border-r last:border-r-0 relative cursor-crosshair"
                          style={{ height: ZOOMED_HEIGHT }}
                          onClick={(e) => handleCalendarClick(e, day, MIN_HEIGHT)}
                        >
                          {/* Day header (sticky) */}
                          <div className="sticky top-0 z-10 text-center py-1 border-b text-xs font-semibold bg-card">
                            <div className="flex items-center justify-center gap-1">
                              <span>{DAY_LABELS[day]}</span>
                              {daySchedule && daySchedule.visits.length > 0 && (
                                <div className="relative">
                                  <button
                                    className="p-0.5 rounded hover:bg-muted transition-colors"
                                    title={`Copy ${DAY_LABELS[day]} to another day`}
                                    onClick={(e) => { e.stopPropagation(); setCopyMenuDay(copyMenuDay === day ? null : day); }}
                                  >
                                    <Copy className="w-3 h-3 text-muted-foreground" />
                                  </button>
                                  {copyMenuDay === day && (
                                    <>
                                      <div className="fixed inset-0 z-20" onClick={() => setCopyMenuDay(null)} />
                                      <div className="absolute top-full left-1/2 -translate-x-1/2 z-30 mt-1 bg-popover border rounded-md shadow-md py-1 min-w-[100px]">
                                        <p className="text-[9px] text-muted-foreground px-2 pb-1">Copy to:</p>
                                        {DAYS_OF_WEEK.filter(d => d !== day && !worker.daysOff.includes(d)).map(d => (
                                          <button
                                            key={d}
                                            className="w-full text-left px-3 py-1 text-[11px] hover:bg-muted transition-colors"
                                            onClick={(e) => { e.stopPropagation(); copyDayTo(day, d); }}
                                          >
                                            {DAY_LABELS[d]}
                                          </button>
                                        ))}
                                      </div>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
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
                            <div key={h} className="absolute left-0 right-0 border-b border-border/30" style={{ top: (h - startHour) * HOUR_HEIGHT, height: HOUR_HEIGHT }} />
                          ))}

                          {/* Working hours background */}
                          {(
                            <div className="absolute left-0 right-0 bg-primary/[0.03]"
                              style={{ top: whStartMin * MIN_HEIGHT, height: (whEndMin - whStartMin) * MIN_HEIGHT }} />
                          )}

                          {/* Break shading */}
                          {worker.breaks.map((b, bi) => {
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

                          {/* Drag: time window highlight */}
                          {dragWindow && (
                            <div
                              className="absolute left-0 right-0 bg-green-500/10 border-y-2 border-green-500/40 z-[5] pointer-events-none"
                              style={{
                                top: timeToMin(dragWindow.startTime) * MIN_HEIGHT,
                                height: (timeToMin(dragWindow.endTime) - timeToMin(dragWindow.startTime)) * MIN_HEIGHT,
                              }}
                            >
                              <div className="px-1 py-0.5">
                                <span className="text-[9px] font-medium text-green-700 dark:text-green-400">
                                  {formatTime(dragWindow.startTime)} – {formatTime(dragWindow.endTime)}
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Drag: drop position indicator */}
                          {isDragging && activeDrag && dragPosition?.day === day && (
                            <div
                              className={`absolute left-0.5 right-0.5 rounded-sm border-2 border-dashed z-[6] pointer-events-none ${
                                isValidDropPosition
                                  ? 'border-green-500 bg-green-500/10'
                                  : 'border-destructive bg-destructive/10'
                              }`}
                              style={{
                                top: dragPosition.minuteOfDay * MIN_HEIGHT,
                                height: activeDrag.durationMinutes * MIN_HEIGHT,
                              }}
                            >
                              <span className={`text-[9px] font-medium px-1 ${isValidDropPosition ? 'text-green-700 dark:text-green-400' : 'text-destructive'}`}>
                                {formatTime(minToTime(dragPosition.minuteOfDay))}
                              </span>
                            </div>
                          )}

                          {/* Visits + travel blocks */}
                          {daySchedule?.visits.map((v, i) => {
                            const client = clients.find(c => c.id === v.clientId);
                            const startMin = v.startTime.split(':').map(Number).reduce((h, m) => h * 60 + m);
                            const endMin = v.endTime.split(':').map(Number).reduce((h, m) => h * 60 + m);
                            const visitDuration = endMin - startMin;
                            const travelStart = startMin - v.travelTimeFromPrev;

                            // Detect travel overlap: does this travel block overlap with the previous visit's end?
                            const prevVisit = i > 0 ? daySchedule.visits[i - 1] : null;
                            const prevEndMin = prevVisit ? prevVisit.endTime.split(':').map(Number).reduce((h: number, m: number) => h * 60 + m) : null;
                            const hasTravelOverlap = prevEndMin !== null && v.travelTimeFromPrev > 0 && travelStart < prevEndMin;
                            const overlapMinutes = hasTravelOverlap && prevEndMin !== null ? prevEndMin - travelStart : 0;

                            // Is this the visit currently being dragged?
                            const isBeingDragged = isDragging && activeDrag &&
                              activeDrag.sourceDay === day && activeDrag.sourceIndex === i;

                            const dragHandlers = createDragHandlers({
                              clientId: v.clientId,
                              sourceDay: day,
                              sourceIndex: i,
                              durationMinutes: visitDuration,
                            });

                            return (
                              <React.Fragment key={i}>
                                {/* Travel block */}
                                {v.travelTimeFromPrev > 0 && (
                                  <>
                                    {hasTravelOverlap ? (
                                      <>
                                        {/* Overlap portion - shown in red */}
                                        <div
                                          data-event-block
                                          className={`absolute left-0.5 right-0.5 rounded-sm bg-red-500/30 border-2 border-red-500 overflow-hidden cursor-pointer z-[3] ${isBeingDragged ? 'opacity-30' : ''}`}
                                          style={{ top: travelStart * MIN_HEIGHT, height: Math.max(overlapMinutes * MIN_HEIGHT, 2) }}
                                          onClick={(e) => { e.stopPropagation(); setSelectedDay(day); }}
                                          title={`⚠️ Travel overlap: ${overlapMinutes} min conflict`}
                                        >
                                          <span className="text-[8px] text-red-600 dark:text-red-400 font-bold px-1 truncate block">
                                            ⚠️ {overlapMinutes}m overlap
                                          </span>
                                        </div>
                                        {/* Non-overlap portion - normal travel color */}
                                        {v.travelTimeFromPrev - overlapMinutes > 0 && (
                                          <div
                                            data-event-block
                                            className={`absolute left-0.5 right-0.5 rounded-sm bg-accent/40 border border-accent/60 overflow-hidden cursor-pointer ${isBeingDragged ? 'opacity-30' : ''}`}
                                            style={{
                                              top: (prevEndMin!) * MIN_HEIGHT,
                                              height: Math.max((v.travelTimeFromPrev - overlapMinutes) * MIN_HEIGHT, 2),
                                            }}
                                            onClick={(e) => { e.stopPropagation(); setSelectedDay(day); }}
                                            title={`${v.travelTimeFromPrev - overlapMinutes} min drive`}
                                          >
                                            {(v.travelTimeFromPrev - overlapMinutes) >= 15 && (
                                              <span className="text-[8px] text-accent-foreground/70 px-1 truncate block">{v.travelTimeFromPrev - overlapMinutes}m</span>
                                            )}
                                          </div>
                                        )}
                                      </>
                                    ) : (
                                      <div
                                        data-event-block
                                        className={`absolute left-0.5 right-0.5 rounded-sm bg-accent/40 border border-accent/60 overflow-hidden cursor-pointer ${isBeingDragged ? 'opacity-30' : ''}`}
                                        style={{ top: travelStart * MIN_HEIGHT, height: Math.max(v.travelTimeFromPrev * MIN_HEIGHT, 2) }}
                                        onClick={(e) => { e.stopPropagation(); setSelectedDay(day); }}
                                        title={`${v.travelTimeFromPrev} min drive`}
                                      >
                                        {v.travelTimeFromPrev >= 15 && (
                                          <span className="text-[8px] text-accent-foreground/70 px-1 truncate block">{v.travelTimeFromPrev}m</span>
                                        )}
                                      </div>
                                    )}
                                  </>
                                )}
                                {/* Visit block */}
                                <div
                                  data-event-block
                                  className={`absolute left-0.5 right-0.5 rounded-sm bg-primary text-primary-foreground overflow-hidden transition-all touch-none ${
                                    isBeingDragged ? 'opacity-30 cursor-grabbing' : 'cursor-grab hover:brightness-110'
                                  }`}
                                  style={{ top: startMin * MIN_HEIGHT, height: Math.max(visitDuration * MIN_HEIGHT, 8) }}
                                  onClick={(e) => handleEditVisit(e, day, i, v)}
                                  title={`${client?.name}: ${formatTime(v.startTime)} – ${formatTime(v.endTime)} (drag to move)`}
                                  {...dragHandlers}
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
                                data-event-block
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

                  {/* Drag ghost element */}
                  {isDragging && activeDrag && ghostPos && (
                    <div
                      className="fixed z-[100] pointer-events-none rounded-sm bg-primary/80 text-primary-foreground shadow-lg px-2 py-1 text-xs font-medium"
                      style={{
                        left: ghostPos.x + 12,
                        top: ghostPos.y - 12,
                        minWidth: 80,
                      }}
                    >
                      {clients.find(c => c.id === activeDrag.clientId)?.name}
                      {dragPosition && (
                        <span className="block text-[10px] opacity-80">
                          {formatTime(minToTime(dragPosition.minuteOfDay))} · {DAY_LABELS[dragPosition.day]}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Event popup (new / edit) */}
            {eventPopup && !isDragging && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setEventPopup(null)} />
                <div
                  className="fixed z-50 w-72 rounded-lg border bg-popover text-popover-foreground shadow-lg p-4 space-y-3"
                  style={{
                    left: Math.min(eventPopup.x, window.innerWidth - 300),
                    top: Math.min(eventPopup.y, window.innerHeight - 400),
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold">
                      {eventPopup.mode === 'edit' ? 'Edit Visit' : 'New Visit'} — {DAY_LABELS[eventPopup.day]}
                    </h4>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEventPopup(null)}>
                      <X className="w-3 h-3" />
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <div>
                      <Label className="text-xs">Client</Label>
                      <Select value={eventPopup.clientId} onValueChange={(id) => {
                        const client = clients.find(c => c.id === id);
                        setEventPopup(prev => prev ? {
                          ...prev,
                          clientId: id,
                          duration: client?.visitDurationMinutes ?? prev.duration,
                        } : null);
                      }}>
                        <SelectTrigger className="h-8 text-xs mt-1">
                          <SelectValue placeholder="Select a client..." />
                        </SelectTrigger>
                        <SelectContent>
                          {availableForPopupDay.map(c => (
                            <SelectItem key={c.id} value={c.id} className="text-xs">
                              {c.name} ({c.visitDurationMinutes}min)
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="text-xs">Day</Label>
                      <Select value={eventPopup.day} onValueChange={(d) => setEventPopup(prev => prev ? { ...prev, day: d as DayOfWeek } : null)}>
                        <SelectTrigger className="h-8 text-xs mt-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d)).map(d => (
                            <SelectItem key={d} value={d} className="text-xs">{DAY_LABELS[d]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">Start Time</Label>
                        <Input
                          type="time"
                          className="h-8 text-xs mt-1"
                          value={eventPopup.startTime}
                          step={900}
                          onChange={(e) => setEventPopup(prev => prev ? { ...prev, startTime: e.target.value } : null)}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Duration (min)</Label>
                        <Input
                          type="number"
                          className="h-8 text-xs mt-1"
                          value={eventPopup.duration}
                          min={15}
                          step={15}
                          onChange={(e) => setEventPopup(prev => prev ? { ...prev, duration: parseInt(e.target.value) || 15 } : null)}
                        />
                      </div>
                    </div>

                    {eventPopup.clientId && (() => {
                      const [sh, sm] = eventPopup.startTime.split(':').map(Number);
                      const endMin = sh * 60 + sm + eventPopup.duration;
                      const endTime = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
                      return (
                        <p className="text-[10px] text-muted-foreground">
                          {formatTime(eventPopup.startTime)} – {formatTime(endTime)}
                        </p>
                      );
                    })()}
                  </div>

                  <div className="flex gap-2 pt-1">
                    <Button size="sm" className="flex-1 h-7 text-xs" disabled={!eventPopup.clientId} onClick={handleConfirmEvent}>
                      {eventPopup.mode === 'edit' ? <><Pencil className="w-3 h-3 mr-1" /> Save</> : <><Plus className="w-3 h-3 mr-1" /> Add Visit</>}
                    </Button>
                    {eventPopup.mode === 'edit' && (
                      <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={handleDeleteFromPopup}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEventPopup(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </>
            )}

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
              {DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d)).map(day => {
                const dayData = lastSchedule.days.find(d => d.day === day);
                const visitCount = dayData?.visits.length ?? 0;
                return (
                  <Button key={day} variant={selectedDay === day ? 'default' : 'outline'} size="sm"
                    onClick={() => setSelectedDay(day)}>
                    {DAY_LABELS[day]} {visitCount > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">{visitCount}</Badge>}
                  </Button>
                );
              })}
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
            ) : selectedDay ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <MapPin className="w-4 h-4" />
                    {DAY_LABELS[selectedDay]} — No visits yet
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-3">Add clients to build this day's schedule.</p>
                  <Select onValueChange={(id) => addClientToDay(id, selectedDay)}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Select a client to add..." />
                    </SelectTrigger>
                    <SelectContent>
                      {clients.map(c => (
                        <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>
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

// =============================================================================
// Conflict resolution for drag-and-drop
// =============================================================================

import type { Client as ClientType, WorkerProfile as WorkerType, TravelTimeMatrix as TTMatrix } from '@/types/models';
import { travelKey, DEFAULT_TRAVEL_TIME } from '@/types/models';

function getTravel(matrix: TTMatrix, a: string, b: string): number {
  return matrix[travelKey(a, b)] ?? DEFAULT_TRAVEL_TIME;
}
/**
 * Resolve conflicts when dropping a visit onto a day.
 * - Places the dropped visit at its exact time
 * - Bumps overlapping visits down, then tries up
 * - Removes visits that can't fit
 */
function resolveConflicts(
  droppedVisit: ScheduledVisit,
  existingVisits: ScheduledVisit[],
  day: DayOfWeek,
  worker: WorkerType,
  allClients: ClientType[],
  travelTimes: TTMatrix,
): { resolvedVisits: ScheduledVisit[]; removedClients: string[] } {
  const whEnd = timeToMin(worker.workingHours.endTime);
  const whStart = timeToMin(worker.workingHours.startTime);
  const dropStart = timeToMin(droppedVisit.startTime);
  const dropEnd = timeToMin(droppedVisit.endTime);

  // Manually placed visits are immovable - they stay where they are
  const manualVisits = existingVisits.filter(v => v.manuallyPlaced);
  const movableVisits = existingVisits.filter(v => !v.manuallyPlaced);

  // Separate movable visits into: before, overlapping, and after
  const before: ScheduledVisit[] = [];
  const after: ScheduledVisit[] = [];
  const overlapping: ScheduledVisit[] = [];

  for (const v of movableVisits) {
    const vStart = timeToMin(v.startTime);
    const vEnd = timeToMin(v.endTime);
    if (vEnd <= dropStart) {
      before.push(v);
    } else if (vStart >= dropEnd) {
      after.push(v);
    } else {
      overlapping.push(v);
    }
  }

  before.sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));
  after.sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));
  overlapping.sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));

  // Start with before visits + manual visits (keep in place) + dropped visit
  const resolved: ScheduledVisit[] = [...before, ...manualVisits, droppedVisit];
  const removed: string[] = [];

  // Helper to get the previous client ID for travel time calculation
  function getPrevClientId(endMinute: number): string {
    // Find the visit that ends closest to (and at or before) endMinute
    let prevId = 'home';
    let closestEnd = -1;
    for (const r of resolved) {
      const rEnd = timeToMin(r.endTime);
      if (rEnd <= endMinute && rEnd > closestEnd) {
        closestEnd = rEnd;
        prevId = r.clientId;
      }
    }
    return prevId;
  }

  let currentEnd = dropEnd;

  // Helper to try placing a bumped visit with travel time
  function tryPlaceVisit(v: ScheduledVisit, afterMinute: number): boolean {
    const client = allClients.find(c => c.id === v.clientId);
    if (!client) { removed.push(v.clientId); return false; }

    const tw = client.timeWindows.find(w => w.day === day);
    if (!tw) { removed.push(v.clientId); return false; }

    const twStart = timeToMin(tw.startTime);
    const twEnd = timeToMin(tw.endTime);

    // Add travel time from previous visit
    const prevId = getPrevClientId(afterMinute);
    const travel = getTravel(travelTimes, prevId, client.id);

    let newStart = Math.max(afterMinute + travel, twStart);
    newStart = Math.ceil(newStart / 15) * 15;

    // Skip breaks
    for (const b of worker.breaks) {
      const bs = timeToMin(b.startTime);
      const be = timeToMin(b.endTime);
      if (newStart < be && newStart + client.visitDurationMinutes > bs) {
        newStart = be;
        newStart = Math.ceil(newStart / 15) * 15;
      }
    }

    const newEnd = newStart + client.visitDurationMinutes;

    if (newEnd > twEnd || newEnd > whEnd) {
      // Try placing before the dropped visit instead
      const beforeStart = findSlotBefore(v.clientId, client, day, worker, resolved, whStart);
      if (beforeStart !== null) {
        const bEnd = beforeStart + client.visitDurationMinutes;
        const insertVisit: ScheduledVisit = {
          clientId: v.clientId,
          startTime: minToTime(beforeStart),
          endTime: minToTime(bEnd),
          travelTimeFromPrev: 0,
        };
        let insertIdx = 0;
        for (let i = 0; i < resolved.length; i++) {
          if (timeToMin(resolved[i].startTime) > beforeStart) break;
          insertIdx = i + 1;
        }
        resolved.splice(insertIdx, 0, insertVisit);
        return true;
      }
      removed.push(v.clientId);
      return false;
    }

    resolved.push({
      clientId: v.clientId,
      startTime: minToTime(newStart),
      endTime: minToTime(newEnd),
      travelTimeFromPrev: travel,
    });
    currentEnd = newEnd;
    return true;
  }

  // Process overlapping visits - these MUST be shifted (with travel time)
  for (const v of overlapping) {
    tryPlaceVisit(v, currentEnd);
  }

  // Process "after" visits - keep original times unless they conflict
  for (const v of after) {
    const vStart = timeToMin(v.startTime);
    const vEnd = timeToMin(v.endTime);

    if (vStart >= currentEnd) {
      // No conflict - keep original time
      resolved.push(v);
      currentEnd = vEnd;
    } else {
      // Conflict with a shifted visit - need to shift (with travel time)
      tryPlaceVisit(v, currentEnd);
    }
  }

  // Sort final by start time
  resolved.sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));

  return { resolvedVisits: resolved, removedClients: removed };
}

/**
 * Try to find a slot for a visit before a given set of already-placed visits.
 * Returns start minute or null if not possible.
 */
function findSlotBefore(
  clientId: string,
  client: ClientType,
  day: DayOfWeek,
  worker: WorkerType,
  placedVisits: ScheduledVisit[],
  whStart: number,
): number | null {
  const tw = client.timeWindows.find(w => w.day === day);
  if (!tw) return null;

  const twStart = timeToMin(tw.startTime);
  const twEnd = timeToMin(tw.endTime);

  // Find gaps before each visit
  let prevEnd = Math.max(whStart, twStart);
  for (const v of placedVisits) {
    const vStart = timeToMin(v.startTime);
    const gapStart = prevEnd;
    const gapEnd = vStart;

    if (gapEnd - gapStart >= client.visitDurationMinutes) {
      let start = gapStart;
      start = Math.ceil(start / 15) * 15;

      // Check breaks
      let valid = true;
      for (const b of worker.breaks) {
        const bs = timeToMin(b.startTime);
        const be = timeToMin(b.endTime);
        if (start < be && start + client.visitDurationMinutes > bs) {
          start = be;
          start = Math.ceil(start / 15) * 15;
        }
      }

      if (start + client.visitDurationMinutes <= gapEnd &&
          start >= twStart && start + client.visitDurationMinutes <= twEnd) {
        return start;
      }
    }

    prevEnd = timeToMin(v.endTime);
  }

  return null;
}
