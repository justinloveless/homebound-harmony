import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { VisitNoteForm } from '@/components/notes/VisitNoteForm';
import { ArrowLeft, MapPin, Clock, CheckCircle2, PenLine } from 'lucide-react';

interface VisitDetail {
  id: string;
  clientId: string;
  clientName: string;
  clientAddress: string;
  checkInAt: string;
  checkOutAt: string | null;
  durationMinutes: number | null;
  billableUnits: number | null;
  visitStatus: string;
  noteStatus: string;
}

interface VisitNote {
  id: string;
  version: number;
  tasksCompleted: Array<{ id: string; label: string; completed: boolean }>;
  freeText: string;
  isFinal: boolean;
  signedAt: string | null;
  submittedAt: string | null;
  caregiverSignature: string | null;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function SignaturePreview({ svgPath }: { svgPath: string }) {
  return (
    <svg
      viewBox="0 0 600 160"
      className="w-full border rounded bg-white"
      style={{ maxHeight: 120 }}
      aria-label="Caregiver signature"
    >
      <path d={svgPath} stroke="#1a1a1a" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReadOnlyNote({ note }: { note: VisitNote }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium text-green-700">
        <CheckCircle2 className="h-4 w-4" />
        Note submitted {note.signedAt ? `at ${formatTime(note.signedAt)}` : ''}
      </div>

      {note.tasksCompleted.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tasks</p>
          {note.tasksCompleted.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-sm">
              <CheckCircle2
                className={`h-3.5 w-3.5 flex-shrink-0 ${t.completed ? 'text-green-600' : 'text-muted-foreground/40'}`}
              />
              <span className={t.completed ? '' : 'text-muted-foreground'}>{t.label}</span>
            </div>
          ))}
        </div>
      )}

      {note.freeText && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Notes</p>
          <p className="text-sm whitespace-pre-wrap">{note.freeText}</p>
        </div>
      )}

      {note.caregiverSignature && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Signature</p>
          <SignaturePreview svgPath={note.caregiverSignature} />
        </div>
      )}
    </div>
  );
}

export default function VisitDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [visit, setVisit] = useState<VisitDetail | null>(null);
  const [notes, setNotes] = useState<VisitNote[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [visitData, notesData] = await Promise.all([
        api.get<{ visit: VisitDetail }>(`/api/evv/visits/${id}`),
        api.get<{ notes: VisitNote[] }>(`/api/evv/${id}/notes`),
      ]);
      setVisit(visitData.visit);
      setNotes(notesData.notes);
    } catch {
      // visit not found — go back
      navigate('/visits');
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground">Loading...</div>
    );
  }

  if (!visit) return null;

  const finalNote = notes.find((n) => n.isFinal) ?? null;
  const draftNote = notes.find((n) => !n.isFinal) ?? null;

  const statusColor: Record<string, string> = {
    in_progress: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    cancelled: 'bg-gray-100 text-gray-600',
  };

  return (
    <div className="space-y-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/visits')}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <h1 className="text-lg font-bold flex-1 truncate">{visit.clientName}</h1>
        <Badge className={statusColor[visit.visitStatus] ?? ''} variant="outline">
          {visit.visitStatus.replace('_', ' ')}
        </Badge>
      </div>

      <Card>
        <CardContent className="pt-4 space-y-2 text-sm">
          {visit.clientAddress && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <MapPin className="h-3.5 w-3.5" />
              {visit.clientAddress}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {formatTime(visit.checkInAt)}
            {visit.checkOutAt && ` – ${formatTime(visit.checkOutAt)}`}
            {visit.durationMinutes != null && (
              <span className="ml-1 text-foreground font-medium">({visit.durationMinutes} min)</span>
            )}
          </div>
          {visit.billableUnits != null && (
            <div className="text-xs text-muted-foreground">
              {visit.billableUnits} billable unit{visit.billableUnits !== 1 ? 's' : ''}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <PenLine className="h-4 w-4" />
            Visit Documentation
          </CardTitle>
        </CardHeader>
        <CardContent>
          {finalNote ? (
            <ReadOnlyNote note={finalNote} />
          ) : (
            <VisitNoteForm
              visitId={visit.id}
              initialNote={draftNote}
              onFinalized={() => {
                setLoading(true);
                load();
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
