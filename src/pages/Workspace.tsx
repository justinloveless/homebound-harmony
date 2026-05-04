import { useState, useEffect } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { DAY_LABELS, DAYS_OF_WEEK, type DayOfWeek } from '@/types/models';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Clock, CalendarDays, Pencil, Check, X } from 'lucide-react';
import { formatTime } from '@/lib/format-time';
import { toast } from 'sonner';
import Clients from './Clients';
import Schedule from './Schedule';

function WorkerAvailability() {
  const { workspace, updateWorker } = useWorkspace();
  const worker = workspace.worker;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(worker);

  // Sync form when worker changes externally
  useEffect(() => {
    if (!editing) setForm(worker);
  }, [worker, editing]);

  const workingDays = DAYS_OF_WEEK.filter(d => !form.daysOff.includes(d));

  const toggleDay = (day: DayOfWeek) => {
    setForm(prev => ({
      ...prev,
      daysOff: prev.daysOff.includes(day)
        ? prev.daysOff.filter(d => d !== day)
        : [...prev.daysOff, day],
    }));
  };


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
          <div className="flex items-center gap-2 text-sm">
            <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Days:</span>
            <div className="flex gap-1 flex-wrap">
              {DAYS_OF_WEEK.map(d => (
                <Badge
                  key={d}
                  variant={!worker.daysOff.includes(d) ? 'default' : 'outline'}
                  className={`text-[10px] px-1.5 py-0 ${!worker.daysOff.includes(d) ? '' : 'opacity-40'}`}
                >
                  {DAY_LABELS[d]}
                </Badge>
              ))}
            </div>
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

        {/* Working days */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5" /> Working Days
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {DAYS_OF_WEEK.map(d => (
              <Badge
                key={d}
                variant={workingDays.includes(d) ? 'default' : 'outline'}
                className={`text-[10px] px-2 py-0.5 cursor-pointer select-none transition-opacity ${workingDays.includes(d) ? '' : 'opacity-40'}`}
                onClick={() => toggleDay(d)}
              >
                {DAY_LABELS[d]}
              </Badge>
            ))}
          </div>
        </div>

        {/* Breaks */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Coffee className="h-3.5 w-3.5" /> Breaks
          </label>
          <div className="space-y-2">
            {form.breaks.map((b, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="h-8 text-sm flex-1" placeholder="Label" value={b.label}
                  onChange={e => updateBreak(i, 'label', e.target.value)} />
                <Input type="time" className="h-8 text-sm w-28" value={b.startTime}
                  onChange={e => updateBreak(i, 'startTime', e.target.value)} />
                <span className="text-muted-foreground text-xs">–</span>
                <Input type="time" className="h-8 text-sm w-28" value={b.endTime}
                  onChange={e => updateBreak(i, 'endTime', e.target.value)} />
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => removeBreak(i)}>
                  <X className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addBreak}>
              <Plus className="h-3 w-3 mr-1" /> Add Break
            </Button>
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
