import { useWorkspace } from '@/hooks/useWorkspace';
import { DAY_LABELS, DAYS_OF_WEEK } from '@/types/models';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock, CalendarDays, Coffee } from 'lucide-react';
import { formatTime } from '@/lib/format-time';
import Clients from './Clients';
import Schedule from './Schedule';

function WorkerAvailability() {
  const { workspace } = useWorkspace();
  const { worker } = workspace;

  const workingDays = DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-primary" />
          Availability
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Working hours */}
        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Hours:</span>
          <span className="font-medium">{formatTime(worker.workingHours.startTime)} – {formatTime(worker.workingHours.endTime)}</span>
        </div>

        {/* Working days */}
        <div className="flex items-center gap-2 text-sm">
          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Days:</span>
          <div className="flex gap-1 flex-wrap">
            {DAYS_OF_WEEK.map(d => (
              <Badge
                key={d}
                variant={workingDays.includes(d) ? 'default' : 'outline'}
                className={`text-[10px] px-1.5 py-0 ${workingDays.includes(d) ? '' : 'opacity-40'}`}
              >
                {DAY_LABELS[d]}
              </Badge>
            ))}
          </div>
        </div>

        {/* Breaks */}
        {worker.breaks.length > 0 && (
          <div className="flex items-start gap-2 text-sm">
            <Coffee className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
            <span className="text-muted-foreground">Breaks:</span>
            <div className="flex flex-col gap-0.5">
              {worker.breaks.map((b, i) => (
                <span key={i} className="font-medium">
                  {b.label} ({formatTime(b.startTime)} – {formatTime(b.endTime)})
                </span>
              ))}
            </div>
          </div>
        )}
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
