import { useState, useEffect } from 'react';
import { Clock, User } from 'lucide-react';

interface Props {
  clientName: string;
  checkInAt: string;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export function ActiveVisitBanner({ clientName, checkInAt }: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(checkInAt).getTime();
    const update = () => setElapsed(Date.now() - start);
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [checkInAt]);

  return (
    <div className="bg-primary text-primary-foreground rounded-lg px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <User className="h-4 w-4" />
        <span className="font-medium text-sm">{clientName}</span>
      </div>
      <div className="flex items-center gap-1.5 text-sm font-mono">
        <Clock className="h-4 w-4" />
        <span>{formatElapsed(elapsed)}</span>
      </div>
    </div>
  );
}
