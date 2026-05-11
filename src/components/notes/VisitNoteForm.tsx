import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { SignaturePad } from './SignaturePad';
import { useGeolocation } from '@/hooks/useGeolocation';
import { toast } from 'sonner';
import { PenLine, CheckCircle2 } from 'lucide-react';

interface TaskItem {
  id: string;
  label: string;
  completed: boolean;
}

interface TaskTemplate {
  id: string;
  label: string;
  category: string;
}

interface VisitNote {
  id: string;
  version: number;
  tasksCompleted: TaskItem[];
  freeText: string;
  isFinal: boolean;
  signedAt: string | null;
}

interface Props {
  visitId: string;
  initialNote?: VisitNote | null;
  onFinalized?: () => void;
}

export function VisitNoteForm({ visitId, initialNote, onFinalized }: Props) {
  const { ensureClinicalFix } = useGeolocation();
  const [noteId, setNoteId] = useState<string | null>(initialNote?.id ?? null);
  const [tasks, setTasks] = useState<TaskItem[]>(initialNote?.tasksCompleted ?? []);
  const [freeText, setFreeText] = useState(initialNote?.freeText ?? '');
  const [showSignature, setShowSignature] = useState(false);
  const [signing, setSigning] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDirtyRef = useRef(false);

  useEffect(() => {
    if (initialNote || templatesLoaded) return;

    const load = async () => {
      try {
        const [templatesData, noteData] = await Promise.all([
          api.get<{ templates: TaskTemplate[] }>('/api/task-templates'),
          api.post<{ note: VisitNote }>(`/api/evv/${visitId}/notes`, {}),
        ]);

        const templates = templatesData.templates;
        const existingNote = noteData.note;
        setNoteId(existingNote.id);

        if (existingNote.tasksCompleted && existingNote.tasksCompleted.length > 0) {
          setTasks(existingNote.tasksCompleted as TaskItem[]);
        } else if (templates.length > 0) {
          setTasks(
            templates.map((t) => ({ id: t.id, label: t.label, completed: false })),
          );
        }
        setFreeText(existingNote.freeText ?? '');
        setTemplatesLoaded(true);
      } catch {
        setTemplatesLoaded(true);
      }
    };
    load();
  }, [visitId, initialNote, templatesLoaded]);

  const save = useCallback(
    async (currentTasks: TaskItem[], currentText: string) => {
      if (!isDirtyRef.current) return;
      isDirtyRef.current = false;
      try {
        const data = await api.post<{ note: VisitNote }>(`/api/evv/${visitId}/notes`, {
          tasksCompleted: currentTasks,
          freeText: currentText,
        });
        if (!noteId) setNoteId(data.note.id);
      } catch {
        // best-effort auto-save; ignore errors
      }
    },
    [visitId, noteId],
  );

  const scheduleSave = useCallback(
    (currentTasks: TaskItem[], currentText: string) => {
      isDirtyRef.current = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => save(currentTasks, currentText), 1500);
    },
    [save],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const toggleTask = (id: string) => {
    const next = tasks.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t));
    setTasks(next);
    scheduleSave(next, freeText);
  };

  const handleTextChange = (val: string) => {
    setFreeText(val);
    scheduleSave(tasks, val);
  };

  const handleSign = async (svgPath: string) => {
    if (!noteId) {
      toast.error('Note not initialized');
      return;
    }
    setSigning(true);
    try {
      const gps = await ensureClinicalFix();
      await api.post(`/api/evv/${visitId}/notes/${noteId}/sign`, {
        signature: svgPath,
        ...(gps && {
          gps: {
            lat: gps.lat,
            lon: gps.lon,
            accuracyM: gps.accuracyM,
            capturedAt: gps.capturedAt,
            staleSeconds: gps.staleSeconds,
          },
        }),
      });
      toast.success('Visit note signed and submitted');
      onFinalized?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Sign failed';
      toast.error(msg);
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className="space-y-5">
      {tasks.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Tasks</h3>
          {tasks.map((task) => (
            <div key={task.id} className="flex items-center gap-3 py-1">
              <Checkbox
                id={`task-${task.id}`}
                checked={task.completed}
                onCheckedChange={() => toggleTask(task.id)}
              />
              <Label
                htmlFor={`task-${task.id}`}
                className={task.completed ? 'line-through text-muted-foreground' : ''}
              >
                {task.label}
              </Label>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="note-text">Visit Notes</Label>
        <Textarea
          id="note-text"
          placeholder="Document observations, interventions, and client response..."
          value={freeText}
          onChange={(e) => handleTextChange(e.target.value)}
          rows={4}
          className="resize-none"
        />
      </div>

      {!showSignature ? (
        <Button
          type="button"
          className="w-full"
          onClick={() => {
            if (saveTimerRef.current) {
              clearTimeout(saveTimerRef.current);
              save(tasks, freeText);
            }
            setShowSignature(true);
          }}
        >
          <PenLine className="h-4 w-4 mr-2" />
          Sign & Submit Note
        </Button>
      ) : (
        <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            Caregiver Attestation
          </div>
          <p className="text-xs text-muted-foreground">
            By signing, I attest that I performed the documented services for this client visit.
          </p>
          <SignaturePad onSign={handleSign} disabled={signing} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowSignature(false)}
            disabled={signing}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
