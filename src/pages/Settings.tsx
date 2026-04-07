import React, { useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Download, Upload, Trash2, Plus } from 'lucide-react';
import { DAYS_OF_WEEK, DAY_LABELS, type DayOfWeek, type WorkerProfile } from '@/types/models';
import { AddressSearch } from '@/components/AddressSearch';
import { exportWorkspace, importWorkspace, downloadJson } from '@/lib/storage';
import { toast } from 'sonner';

export default function SettingsPage() {
  const { workspace, updateWorker, replaceWorkspace } = useWorkspace();
  const [form, setForm] = useState<WorkerProfile>(workspace.worker);

  const handleSave = () => {
    updateWorker(form);
    toast.success('Profile saved');
  };

  const toggleDay = (day: DayOfWeek) => {
    setForm(prev => ({
      ...prev,
      daysOff: prev.daysOff.includes(day)
        ? prev.daysOff.filter(d => d !== day)
        : [...prev.daysOff, day],
    }));
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

  const handleExport = () => {
    const json = exportWorkspace(workspace);
    downloadJson(json, `routecare-backup-${new Date().toISOString().split('T')[0]}.json`);
    toast.success('Workspace exported');
  };

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
        toast.success('Workspace imported');
      } catch {
        toast.error('Invalid workspace file');
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
            <Label className="mb-2 block">Days Off</Label>
            <div className="flex flex-wrap gap-3">
              {DAYS_OF_WEEK.map(day => (
                <label key={day} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.daysOff.includes(day)} onCheckedChange={() => toggleDay(day)} />
                  {DAY_LABELS[day]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Breaks</Label>
              <Button type="button" variant="ghost" size="sm" onClick={addBreak}>
                <Plus className="w-3 h-3 mr-1" /> Add
              </Button>
            </div>
            {form.breaks.map((b, i) => (
              <div key={i} className="flex items-center gap-2 mb-2">
                <Input value={b.label} onChange={e => updateBreak(i, 'label', e.target.value)} placeholder="Label" className="w-24 h-8 text-xs" />
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

      <Card>
        <CardHeader>
          <CardTitle>Data Management</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Export your workspace as a JSON file for backup or to sync across devices via Google Drive, iCloud, etc.
          </p>
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleExport}>
              <Download className="w-4 h-4 mr-2" /> Export Workspace
            </Button>
            <Button variant="outline" onClick={handleImport}>
              <Upload className="w-4 h-4 mr-2" /> Import Workspace
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
