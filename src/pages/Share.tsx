import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { decryptJson, importShareKeyFromHex } from '@/lib/crypto';
import type { ShareSnapshot } from '@/lib/share';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { buildIcs, downloadIcs } from '@/lib/ics';
import { DAY_LABELS } from '@/types/models';
import { Calendar, Download } from 'lucide-react';

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; snapshot: ShareSnapshot };

export default function SharePublicPage() {
  const { id } = useParams();
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!id) throw new Error('Missing share id');
        const fragment = window.location.hash.replace(/^#/, '').trim();
        if (!fragment) throw new Error('This link is missing its decryption key. Open the full URL provided to you.');

        const res = await fetch(`/s/${id}/data`, { credentials: 'omit' });
        if (res.status === 410) throw new Error('This link has been revoked or expired.');
        if (res.status === 404) throw new Error('Link not found.');
        if (!res.ok) throw new Error(`Couldn't load the schedule (HTTP ${res.status}).`);

        const { ciphertext, iv } = (await res.json()) as { ciphertext: string; iv: string };
        const key = await importShareKeyFromHex(fragment);
        const snapshot = await decryptJson<ShareSnapshot>({ ciphertext, iv }, key).catch(() => {
          throw new Error("This link's key didn't match the data. Make sure you copied the full URL.");
        });

        if (!cancelled) setStatus({ kind: 'ready', snapshot });
      } catch (err: any) {
        if (!cancelled) setStatus({ kind: 'error', message: err?.message ?? 'Something went wrong' });
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (status.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Decrypting schedule…
      </div>
    );
  }

  if (status.kind === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader><CardTitle>Unavailable</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm">{status.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { snapshot } = status;

  const downloadCalendar = () => {
    const fakeWeek = {
      weekStartDate: snapshot.weekStartDate,
      totalTravelMinutes: 0,
      totalTimeAwayMinutes: 0,
      days: snapshot.visits.map(v => ({
        day: v.day,
        date: v.date,
        visits: [{
          clientId: 'shared',
          startTime: v.startTime,
          endTime: v.endTime,
          travelTimeFromPrev: 0,
        }],
        totalTravelMinutes: 0,
        leaveHomeTime: v.startTime,
        arriveHomeTime: v.endTime,
      })),
    };
    const ics = buildIcs(fakeWeek as any, {
      workerName: snapshot.workerName,
      clientLookup: { shared: { name: snapshot.client.name, address: snapshot.client.address } },
    });
    downloadIcs(`schedule-${snapshot.client.name || 'visits'}.ics`, ics);
  };

  return (
    <div className="min-h-screen p-4 md:p-8 bg-muted/30">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Calendar className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold">Your visit schedule</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Upcoming visits</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              From <strong>{snapshot.workerName}</strong> for <strong>{snapshot.client.name}</strong>.
              Week of {new Date(snapshot.weekStartDate).toLocaleDateString()}.
            </p>
            {snapshot.visits.length === 0 ? (
              <p className="text-sm">No upcoming visits scheduled.</p>
            ) : (
              <ul className="divide-y">
                {snapshot.visits.map((v, i) => (
                  <li key={i} className="py-3 flex items-center gap-4">
                    <div className="text-sm font-medium w-28">{DAY_LABELS[v.day]}, {new Date(v.date).toLocaleDateString()}</div>
                    <div className="text-sm">{v.startTime} – {v.endTime}</div>
                  </li>
                ))}
              </ul>
            )}
            <Button className="mt-4" variant="outline" onClick={downloadCalendar}>
              <Download className="w-4 h-4 mr-2" /> Download .ics calendar file
            </Button>
          </CardContent>
        </Card>

        {(snapshot.workerContact?.email || snapshot.workerContact?.phone) && (
          <Card>
            <CardHeader>
              <CardTitle>Need to change a visit?</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-1">
              <p>Contact {snapshot.workerName}:</p>
              {snapshot.workerContact?.email && (
                <p>Email: <a className="underline" href={`mailto:${snapshot.workerContact.email}`}>{snapshot.workerContact.email}</a></p>
              )}
              {snapshot.workerContact?.phone && (
                <p>Phone: <a className="underline" href={`tel:${snapshot.workerContact.phone}`}>{snapshot.workerContact.phone}</a></p>
              )}
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground text-center">
          End-to-end encrypted. The server cannot read this schedule.
        </p>
      </div>
    </div>
  );
}
