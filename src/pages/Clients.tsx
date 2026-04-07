import React, { useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Pencil, Trash2, Search } from 'lucide-react';
import { type Client, type TimeWindow, type Frequency, type Priority, DAYS_OF_WEEK, DAY_LABELS } from '@/types/models';
import { toast } from 'sonner';

const emptyClient = (): Client => ({
  id: crypto.randomUUID(),
  name: '',
  address: '',
  visitDurationMinutes: 60,
  frequency: 'weekly',
  priority: 'medium',
  timeWindows: [],
  notes: '',
});

function TimeWindowEditor({ windows, onChange }: { windows: TimeWindow[]; onChange: (w: TimeWindow[]) => void }) {
  const addWindow = () => {
    onChange([...windows, { day: 'monday', startTime: '09:00', endTime: '12:00' }]);
  };
  const removeWindow = (i: number) => onChange(windows.filter((_, idx) => idx !== i));
  const updateWindow = (i: number, field: keyof TimeWindow, value: string) => {
    const updated = [...windows];
    updated[i] = { ...updated[i], [field]: value };
    onChange(updated);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Availability Windows</Label>
        <Button type="button" variant="ghost" size="sm" onClick={addWindow}>
          <Plus className="w-3 h-3 mr-1" /> Add
        </Button>
      </div>
      {windows.map((w, i) => (
        <div key={i} className="flex items-center gap-2 flex-wrap">
          <Select value={w.day} onValueChange={v => updateWindow(i, 'day', v)}>
            <SelectTrigger className="w-24 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAYS_OF_WEEK.map(d => (
                <SelectItem key={d} value={d}>{DAY_LABELS[d]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input type="time" value={w.startTime} onChange={e => updateWindow(i, 'startTime', e.target.value)} className="w-28 h-8 text-xs" />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="time" value={w.endTime} onChange={e => updateWindow(i, 'endTime', e.target.value)} className="w-28 h-8 text-xs" />
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeWindow(i)}>
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      ))}
      {windows.length === 0 && <p className="text-xs text-muted-foreground">No windows yet. Add at least one.</p>}
    </div>
  );
}

function ClientForm({ client, onSave, onCancel }: { client: Client; onSave: (c: Client) => void; onCancel: () => void }) {
  const [form, setForm] = useState<Client>(client);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.address.trim()) {
      toast.error('Name and address are required');
      return;
    }
    if (form.timeWindows.length === 0) {
      toast.error('Add at least one availability window');
      return;
    }
    onSave(form);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="John Smith" />
        </div>
        <div>
          <Label htmlFor="address">Address</Label>
          <Input id="address" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="123 Main St, City" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <Label>Duration (min)</Label>
          <Input type="number" value={form.visitDurationMinutes} min={15} step={15}
            onChange={e => setForm({ ...form, visitDurationMinutes: Number(e.target.value) })} />
        </div>
        <div>
          <Label>Frequency</Label>
          <Select value={form.frequency} onValueChange={(v: Frequency) => setForm({ ...form, frequency: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="biweekly">Biweekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Priority</Label>
          <Select value={form.priority} onValueChange={(v: Priority) => setForm({ ...form, priority: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <TimeWindowEditor windows={form.timeWindows} onChange={tw => setForm({ ...form, timeWindows: tw })} />
      <div>
        <Label>Notes</Label>
        <Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Any special instructions..." rows={2} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit">Save Client</Button>
      </div>
    </form>
  );
}

const priorityColor: Record<Priority, string> = {
  high: 'bg-destructive/10 text-destructive border-destructive/20',
  medium: 'bg-accent/20 text-accent-foreground border-accent/30',
  low: 'bg-muted text-muted-foreground border-border',
};

export default function Clients() {
  const { workspace, addClient, updateClient, removeClient } = useWorkspace();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [search, setSearch] = useState('');

  const filtered = workspace.clients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.address.toLowerCase().includes(search.toLowerCase())
  );

  const handleSave = (client: Client) => {
    if (editing) {
      updateClient(client);
      toast.success('Client updated');
    } else {
      addClient(client);
      toast.success('Client added');
    }
    setDialogOpen(false);
    setEditing(null);
  };

  const handleEdit = (client: Client) => {
    setEditing(client);
    setDialogOpen(true);
  };

  const handleDelete = (id: string) => {
    removeClient(id);
    toast.success('Client removed');
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Clients</h1>
          <p className="text-sm text-muted-foreground">{workspace.clients.length} clients</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={v => { setDialogOpen(v); if (!v) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Add Client</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editing ? 'Edit Client' : 'New Client'}</DialogTitle>
            </DialogHeader>
            <ClientForm
              client={editing ?? emptyClient()}
              onSave={handleSave}
              onCancel={() => { setDialogOpen(false); setEditing(null); }}
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Search clients..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
      </div>

      {filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <p className="font-medium">No clients yet</p>
            <p className="text-sm text-muted-foreground mt-1">Add your first client to get started</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map(client => (
            <Card key={client.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="flex items-start justify-between gap-3 pt-5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold truncate">{client.name}</h3>
                    <Badge variant="outline" className={priorityColor[client.priority]}>
                      {client.priority}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">{client.frequency}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1 truncate">{client.address}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {client.timeWindows.map((tw, i) => (
                      <span key={i} className="text-[10px] bg-muted px-2 py-0.5 rounded-full">
                        {DAY_LABELS[tw.day]} {tw.startTime}–{tw.endTime}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(client)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => handleDelete(client.id)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
