import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

export default function UnlockPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await auth.unlock(password);
      navigate('/', { replace: true });
    } catch (err: any) {
      toast.error(err?.message ?? 'Unlock failed');
    } finally {
      setSubmitting(false);
    }
  };

  const switchAccount = async () => {
    await auth.logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Unlock workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Signed in as <strong>{auth.me?.email}</strong>. Enter your password to decrypt your workspace.
          </p>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Unlocking…' : 'Unlock'}
            </Button>
          </form>
          <Button variant="link" className="mt-3 px-0" onClick={switchAccount}>
            Use a different account
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
