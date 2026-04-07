import React, { useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Download, Upload, Trash2, Plus, Copy, HardDrive, FolderOpen, Save } from 'lucide-react';
import { DAYS_OF_WEEK, DAY_LABELS, STRATEGY_LABELS, type DayOfWeek, type WorkerProfile, type SchedulingStrategy } from '@/types/models';
import { AddressSearch } from '@/components/AddressSearch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { exportWorkspace, importWorkspace, downloadJson, isFileSystemAccessSupported, saveWorkspaceToFile, openWorkspaceFromFile, getCurrentFileHandle, clearFileHandle } from '@/lib/storage';
import { toast } from 'sonner';

export default function SettingsPage() {
  const { workspace, updateWorker, replaceWorkspace, fileAutoSaveEnabled, setFileAutoSaveEnabled } = useWorkspace();
  const [form, setForm] = useState<WorkerProfile>(workspace.worker);
  const [linkedFileName, setLinkedFileName] = useState<string | null>(
    getCurrentFileHandle()?.name ?? null
  );

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

  const handleCopyToClipboard = async () => {
    const json = exportWorkspace(workspace);
    await navigator.clipboard.writeText(json);
    toast.success('Workspace copied to clipboard');
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

  // --- File System Access API handlers ---
  const handleSaveToFile = async () => {
    try {
      const handle = await saveWorkspaceToFile(workspace);
      setLinkedFileName(handle.name);
      toast.success(`Saved to ${handle.name}`);
    } catch (err: any) {
      if (err?.name !== 'AbortError') toast.error('Failed to save file');
    }
  };

  const handleSaveToCurrentFile = async () => {
    try {
      const handle = await saveWorkspaceToFile(workspace, getCurrentFileHandle());
      setLinkedFileName(handle.name);
      toast.success(`Saved to ${handle.name}`);
    } catch (err: any) {
      if (err?.name !== 'AbortError') toast.error('Failed to save file');
    }
  };

  const handleOpenFromFile = async () => {
    try {
      const { workspace: ws, handle } = await openWorkspaceFromFile();
      replaceWorkspace(ws);
      setForm(ws.worker);
      setLinkedFileName(handle.name);
      toast.success(`Loaded from ${handle.name}`);
    } catch (err: any) {
      if (err?.name !== 'AbortError') toast.error('Failed to open file');
    }
  };

  const handleUnlinkFile = () => {
    clearFileHandle();
    setLinkedFileName(null);
    setFileAutoSaveEnabled(false);
    toast.success('File unlinked');
  };

  const fsSupported = isFileSystemAccessSupported();

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

      {/* Cloud File Sync */}
      {fsSupported && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="w-5 h-5" /> Cloud File Sync
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Save and open your workspace directly from cloud storage folders like iCloud Drive, Google Drive, OneDrive, or Dropbox.
              Requires their desktop sync app to be installed.
            </p>

            {linkedFileName && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/50 border text-sm">
                <HardDrive className="w-4 h-4 text-primary shrink-0" />
                <span className="flex-1 truncate">Linked: <strong>{linkedFileName}</strong></span>
                <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={handleUnlinkFile}>
                  Unlink
                </Button>
              </div>
            )}

            <div className="flex gap-3 flex-wrap">
              {linkedFileName ? (
                <Button variant="outline" onClick={handleSaveToCurrentFile}>
                  <Save className="w-4 h-4 mr-2" /> Save to File
                </Button>
              ) : null}
              <Button variant="outline" onClick={handleSaveToFile}>
                <Save className="w-4 h-4 mr-2" /> {linkedFileName ? 'Save As…' : 'Save to File…'}
              </Button>
              <Button variant="outline" onClick={handleOpenFromFile}>
                <FolderOpen className="w-4 h-4 mr-2" /> Open from File…
              </Button>
            </div>

            {linkedFileName && (
              <div className="flex items-center gap-3">
                <Switch
                  checked={fileAutoSaveEnabled}
                  onCheckedChange={setFileAutoSaveEnabled}
                />
                <Label className="text-sm">Auto-save changes to linked file</Label>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Data Management</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Export your workspace as a JSON file for backup or to sync across devices.
          </p>
          <div className="flex gap-3 flex-wrap">
            <Button variant="outline" onClick={handleCopyToClipboard}>
              <Copy className="w-4 h-4 mr-2" /> Copy to Clipboard
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
