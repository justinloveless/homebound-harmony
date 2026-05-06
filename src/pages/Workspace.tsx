import { useState, useEffect } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { DAY_LABELS, DAYS_OF_WEEK, type DayOfWeek, type WorkerProfile } from '@/types/models';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Clock, CalendarDays, Pencil, Check, X } from 'lucide-react';
import { formatTime } from '@/lib/format-time';
import { toast } from 'sonner';
import Clients from './Clients';
import Schedule from './Schedule';

type DayKind = 'regular' | 'makeup' | 'off';

function dayKind(w: Pick<WorkerProfile, 'daysOff' | 'makeUpDays'>, d: DayOfWeek): DayKind {
  if (w.daysOff.includes(d)) return 'off';
  if ((w.makeUpDays ?? []).includes(d)) return 'makeup';
  return 'regular';
}

function setDayKind(prev: WorkerProfile, day: DayOfWeek, kind: DayKind): WorkerProfile {
  let daysOff = [...prev.daysOff];
  let makeUpDays = [...(prev.makeUpDays ?? [])];
  if (kind === 'off') {
    if (!daysOff.includes(day)) daysOff.push(day);
    makeUpDays = makeUpDays.filter(x => x !== day);
  } else if (kind === 'makeup') {
    daysOff = daysOff.filter(x => x !== day);
    if (!makeUpDays.includes(day)) makeUpDays.push(day);
  } else {
    daysOff = daysOff.filter(x => x !== day);
    makeUpDays = makeUpDays.filter(x => x !== day);
  }
  return { ...prev, daysOff, makeUpDays };
}

function WorkerAvailability() {
  const { workspace, updateWorker } = useWorkspace();
  const worker = workspace.worker;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(worker);

  // Sync form when worker changes externally
  useEffect(() => {
    if (!editing) setForm(worker);
  }, [worker, editing]);

  const handleSave = () => {
    updateWorker(form);
    setEditing(false);
    toast.success('Availability updated');
  };

  const handleCancel = () => {
    setForm(worker);
    setEditing(false);
  };

  if (!editing) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" />
              Availability
            </CardTitle>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(true)}>
              <Pencil className="h-3 w-3 mr-1" /> Edit
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Hours:</span>
            <span className="font-medium">{formatTime(worker.workingHours.startTime)} – {formatTime(worker.workingHours.endTime)}</span>
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Weekdays:</span>
            </div>
            <div className="flex gap-1 flex-wrap">
              {DAYS_OF_WEEK.map(d => {
                const k = dayKind(worker, d);
                return (
                  <Badge
                    key={d}
                    variant={k === 'off' ? 'outline' : k === 'makeup' ? 'secondary' : 'default'}
                    className={`text-[10px] px-1.5 py-0 ${k === 'off' ? 'opacity-40' : ''}`}
                    title={k === 'makeup' ? 'Make-up day (manual visits only)' : k === 'off' ? 'Day off' : 'Regular scheduling'}
                  >
                    {DAY_LABELS[d]}{k === 'makeup' ? '·MU' : ''}
                  </Badge>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground">MU = make-up (kept open for manual visits, not auto-scheduled)</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-primary" />
            Edit Availability
          </CardTitle>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleCancel}>
              <X className="h-3 w-3 mr-1" /> Cancel
            </Button>
            <Button size="sm" className="h-7 px-2 text-xs" onClick={handleSave}>
              <Check className="h-3 w-3 mr-1" /> Save
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Working hours */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" /> Working Hours
          </label>
          <div className="flex items-center gap-2">
            <Input type="time" className="h-8 text-sm w-32" value={form.workingHours.startTime}
              onChange={e => setForm({ ...form, workingHours: { ...form.workingHours, startTime: e.target.value } })} />
            <span className="text-muted-foreground text-sm">to</span>
            <Input type="time" className="h-8 text-sm w-32" value={form.workingHours.endTime}
              onChange={e => setForm({ ...form, workingHours: { ...form.workingHours, endTime: e.target.value } })} />
          </div>
        </div>

        {/* Per-day: regular / make-up / off */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5" /> Weekdays
          </label>
          <p className="text-[10px] text-muted-foreground mb-2">
            Regular = auto-scheduling. Make-up = on calendar for manual visits only. Off = not working.
          </p>
          <div className="space-y-2">
            {DAYS_OF_WEEK.map(d => {
              const k = dayKind(form, d);
              return (
                <div key={d} className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs font-medium w-8">{DAY_LABELS[d]}</span>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={k === 'regular' ? 'default' : 'outline'}
                      className="h-7 px-2 text-[10px]"
                      onClick={() => setForm(prev => setDayKind(prev, d, 'regular'))}
                    >
                      Regular
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={k === 'makeup' ? 'secondary' : 'outline'}
                      className="h-7 px-2 text-[10px]"
                      onClick={() => setForm(prev => setDayKind(prev, d, 'makeup'))}
                    >
                      Make-up
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={k === 'off' ? 'destructive' : 'outline'}
                      className="h-7 px-2 text-[10px]"
                      onClick={() => setForm(prev => setDayKind(prev, d, 'off'))}
                    >
                      Off
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Workspace() {
  return (
    <div className="grid gap-6 xl:grid-cols-2 xl:gap-8 xl:items-start">
      <div className="min-w-0 space-y-6">
        <WorkerAvailability />
        <Clients />
      </div>
      <div className="min-w-0">
        <Schedule />
      </div>
    </div>
  );
}
