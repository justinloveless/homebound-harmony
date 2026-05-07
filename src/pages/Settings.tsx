import React, { useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Download, Upload, Trash2, Plus, Copy, KeyRound } from 'lucide-react';
import { DAYS_OF_WEEK, DAY_LABELS, STRATEGY_LABELS, type DayOfWeek, type WorkerProfile, type SchedulingStrategy } from '@/types/models';
import { AddressSearch } from '@/components/AddressSearch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { exportWorkspace, importWorkspace, downloadJson } from '@/lib/storage';
import { api } from '@/lib/api';
import { derivePdk, generatePdkSalt, wrapKey } from '@/lib/crypto';
import { toast } from 'sonner';

export default function SettingsPage() {
  const { workspace, updateWorker, replaceWorkspace } = useWorkspace();
  const auth = useAuth();
  const [form, setForm] = useState<WorkerProfile>(workspace.worker);

  const handleSave = () => {
    updateWorker(form);
    toast.success('Profile saved');
  };

  type DayKind = 'regular' | 'makeup' | 'off';
  const dayKind = (w: WorkerProfile, d: DayOfWeek): DayKind => {
    if (w.daysOff.includes(d)) return 'off';
    if ((w.makeUpDays ?? []).includes(d)) return 'makeup';
    return 'regular';
  };
  const setDayKind = (day: DayOfWeek, kind: DayKind) => {
    setForm(prev => {
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
    });
  };

  const addBreak = () => {
    setForm(prev => ({
      ...prev,
      breaks: [...prev.breaks, { startTime: '12:00', endTime: '13:00', label: '' }],
    }));
  };

  const removeBreak = (i: number) => {
    setForm(prev => ({ ...prev, breaks: prev.breaks.filter((_, idx) => idx !== i) }));
  };

  const updateBreak = (i: number, field: string, value: string) => {
    setForm(prev => {
      const breaks = [...prev.breaks];
      breaks[i] = { ...breaks[i], [field]: value };
      return { ...prev, breaks };
    });
  };

  const handleCopyToClipboard = async () => {
    const json = exportWorkspace(workspace);
    await navigator.clipboard.writeText(json);
    toast.success('Workspace JSON copied');
  };

  const handleExport = () => {
    const json = exportWorkspace(workspace);
    downloadJson(json, `routecare-backup-${new Date().toISOString().split('T')[0]}.json`);
    toast.success('Workspace exported');
  };

  // Importer: read a workspace JSON file and replace the current encrypted
  // blob with it. The encryption happens in useWorkspace.persist().
  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const ws = importWorkspace(text);
        replaceWorkspace(ws);
        setForm(ws.worker);
        toast.success('Workspace imported and uploaded');
      } catch (err: any) {
        toast.error(err?.message ?? 'Invalid workspace file');
      }
    };
    input.click();
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Worker Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="wname">Your Name</Label>
              <Input id="wname" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" />
            </div>
            <div>
              <Label htmlFor="waddr">Home Address</Label>
              <AddressSearch id="waddr" value={form.homeAddress} onChange={(homeAddress, coords) => setForm({ ...form, homeAddress, homeCoords: coords ?? form.homeCoords })} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Work Start</Label>
              <Input type="time" value={form.workingHours.startTime}
                onChange={e => setForm({ ...form, workingHours: { ...form.workingHours, startTime: e.target.value } })} />
            </div>
            <div>
              <Label>Work End</Label>
              <Input type="time" value={form.workingHours.endTime}
                onChange={e => setForm({ ...form, workingHours: { ...form.workingHours, endTime: e.target.value } })} />
            </div>
          </div>

          <div>
            <Label className="mb-2 block">Weekdays</Label>
            <p className="text-xs text-muted-foreground mb-3">
              Regular days are used for automatic scheduling. Make-up days stay on your calendar for manual visits only (make-ups, evaluations). Off means you do not work that day.
            </p>
            <div className="space-y-2">
              {DAYS_OF_WEEK.map(day => {
                const k = dayKind(form, day);
                return (
                  <div key={day} className="flex items-center justify-between gap-2 flex-wrap border rounded-md px-3 py-2">
                    <span className="text-sm font-medium w-12">{DAY_LABELS[day]}</span>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" variant={k === 'regular' ? 'default' : 'outline'} className="h-8 text-xs" onClick={() => setDayKind(day, 'regular')}>
                        Regular
                      </Button>
                      <Button type="button" size="sm" variant={k === 'makeup' ? 'secondary' : 'outline'} className="h-8 text-xs" onClick={() => setDayKind(day, 'makeup')}>
                        Make-up
                      </Button>
                      <Button type="button" size="sm" variant={k === 'off' ? 'destructive' : 'outline'} className="h-8 text-xs" onClick={() => setDayKind(day, 'off')}>
                        Off
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <Label className="mb-2 block">Scheduling Strategy</Label>
            <Select value={form.schedulingStrategy ?? 'spread'} onValueChange={(v) => setForm({ ...form, schedulingStrategy: v as SchedulingStrategy })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(STRATEGY_LABELS) as [SchedulingStrategy, string][]).map(([key, label]) => (
                  <SelectItem key={key} value={key}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Controls how clients are distributed across your working days.</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Breaks</Label>
              <Button type="button" variant="ghost" size="sm" onClick={addBreak}>
                <Plus className="w-3 h-3 mr-1" /> Add
              </Button>
            </div>
            {form.breaks.map((b, i) => (
              <div key={i} className="flex items-center gap-2 mb-2 flex-wrap">
                <Input value={b.label} onChange={e => updateBreak(i, 'label', e.target.value)} placeholder="Label" className="w-full sm:w-24 h-8 text-xs" />
                <Input type="time" value={b.startTime} onChange={e => updateBreak(i, 'startTime', e.target.value)} className="w-28 h-8 text-xs" />
                <span className="text-xs text-muted-foreground">to</span>
                <Input type="time" value={b.endTime} onChange={e => updateBreak(i, 'endTime', e.target.value)} className="w-28 h-8 text-xs" />
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeBreak(i)}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
          </div>

          <Button onClick={handleSave}>Save Profile</Button>
        </CardContent>
      </Card>

      <Separator />

      <ChangePasswordCard pdkSalt={auth.me?.pdkSalt} workspaceKey={auth.workspaceKey} />

      <Card>
        <CardHeader>
          <CardTitle>Import / Export</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Export your workspace as JSON for offline backup. Importing replaces your current encrypted workspace
            with the file's contents (re-encrypted on this device before upload).
          </p>
          <div className="flex gap-3 flex-wrap">
            <Button variant="outline" onClick={handleCopyToClipboard}>
              <Copy className="w-4 h-4 mr-2" /> Copy JSON
            </Button>
            <Button variant="outline" onClick={handleExport}>
              <Download className="w-4 h-4 mr-2" /> Export File
            </Button>
            <Button variant="outline" onClick={handleImport}>
              <Upload className="w-4 h-4 mr-2" /> Import File
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface ChangePasswordProps {
  pdkSalt?: string;
  workspaceKey: CryptoKey | null;
}

function ChangePasswordCard({ pdkSalt, workspaceKey }: ChangePasswordProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pdkSalt || !workspaceKey) { toast.error('Workspace not unlocked'); return; }
    if (newPassword.length < 8) { toast.error('New password must be at least 8 characters'); return; }
    if (newPassword !== confirm) { toast.error('Passwords do not match'); return; }

    setSubmitting(true);
    try {
      // Re-wrap WK under the new PDK locally, then send both wrapped envelopes
      // alongside the current/new passwords. We also re-derive the recovery
      // wrapping key against the new salt so the recovery envelope keeps
      // working without the user re-typing their recovery key.
      const newPdkSalt = generatePdkSalt();
      const newPdk = await derivePdk(newPassword, newPdkSalt);
      const newWrappedWorkspaceKey = await wrapKey(workspaceKey, newPdk);
      // Recovery envelope is left untouched: the recovery key + old salt
      // combination still unwraps WK because the WK itself didn't change.
      // (The plan calls out that password change re-wraps WK, not the
      // recovery envelope.)
      const blob = await api.get<{ wrappedWorkspaceKeyRecovery: string }>('/api/snapshot');

      await api.post('/api/auth/password/change', {
        currentPassword,
        newPassword,
        newPdkSalt,
        newWrappedWorkspaceKey,
        newWrappedWorkspaceKeyRecovery: blob.wrappedWorkspaceKeyRecovery,
      });

      toast.success('Password updated. Sign in again next time you reload.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (err: any) {
      toast.error(err?.message ?? 'Password change failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="w-5 h-5" /> Change password</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={onSubmit}>
          <div>
            <Label htmlFor="cur">Current password</Label>
            <Input id="cur" type="password" required value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="np">New password</Label>
            <Input id="np" type="password" required value={newPassword} onChange={e => setNewPassword(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="conf">Confirm new password</Label>
            <Input id="conf" type="password" required value={confirm} onChange={e => setConfirm(e.target.value)} />
          </div>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Updating…' : 'Update password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
