import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import {
  derivePdk,
  deriveRecoveryHash,
  deriveRecoveryWrappingKey,
  generatePdkSalt,
  unwrapKey,
  wrapKey,
} from '@/lib/crypto';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

export default function RecoverPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) { toast.error('New password must be at least 8 characters'); return; }
    if (newPassword !== confirmPassword) { toast.error('Passwords do not match'); return; }

    setSubmitting(true);
    try {
      const recoveryKeyHash = await deriveRecoveryHash(recoveryKey);
      const init = await api.post<{ pdkSalt: string; wrappedWorkspaceKeyRecovery: string }>(
        '/api/auth/recovery/init',
        { email: email.trim().toLowerCase(), recoveryKeyHash },
      );

      const recoveryWrappingKey = await deriveRecoveryWrappingKey(recoveryKey, init.pdkSalt);
      let wk: CryptoKey;
      try {
        wk = await unwrapKey(init.wrappedWorkspaceKeyRecovery, recoveryWrappingKey);
      } catch {
        toast.error('Recovery key did not decrypt the workspace');
        return;
      }

      const newPdkSalt = generatePdkSalt();
      const newPdk = await derivePdk(newPassword, newPdkSalt);
      const newWrappedWorkspaceKey = await wrapKey(wk, newPdk);

      await api.post('/api/auth/recovery', {
        email: email.trim().toLowerCase(),
        recoveryKeyHash,
        newPassword,
        newPdkSalt,
        newWrappedWorkspaceKey,
      });

      toast.success('Password reset. Sign in with your new password.');
      navigate('/login', { replace: true });
    } catch (err: any) {
      toast.error(err?.message ?? 'Recovery failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Recover access</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Enter your account email, your recovery key (saved at signup), and a new password.
            Your data is decrypted and re-encrypted entirely on this device.
          </p>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="rk">Recovery key</Label>
              <Input id="rk" required value={recoveryKey} onChange={e => setRecoveryKey(e.target.value)} placeholder="abcd 1234 …" />
            </div>
            <div>
              <Label htmlFor="np">New password</Label>
              <Input id="np" type="password" required value={newPassword} onChange={e => setNewPassword(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="cp">Confirm new password</Label>
              <Input id="cp" type="password" required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Resetting…' : 'Reset password'}
            </Button>
          </form>
          <div className="mt-4 text-sm text-muted-foreground">
            <Link to="/login" className="underline">Back to sign in</Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
