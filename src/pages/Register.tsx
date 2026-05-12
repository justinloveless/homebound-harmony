import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { api, ApiError } from '@/lib/api';
import { buildTenantHostname, getBrowserRegistrationHost } from '@/lib/tenantHost';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

type Step = 'credentials' | 'totp' | 'done';

export default function RegisterPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const regHost = getBrowserRegistrationHost();
  const [step, setStep] = useState<Step>('credentials');
  const [submitting, setSubmitting] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [qrCode, setQrCode] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpToken, setTotpToken] = useState<string | null>(null);

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post<{
        registrationToken: string;
        mfaDisabled?: boolean;
      }>('/api/auth/register', {
        email: email.trim().toLowerCase(),
        password,
      });
      if (res.mfaDisabled) {
        await auth.login(email.trim().toLowerCase(), password);
        setStep('done');
        navigate('/', { replace: true });
        return;
      }

      const enroll = await api.post<{
        registrationToken: string;
        qrCode?: string;
      }>('/api/auth/totp/enroll', { registrationToken: res.registrationToken });
      setTotpToken(enroll.registrationToken);
      setQrCode(enroll.qrCode ?? null);
      setStep('totp');
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? String(err.body && (err.body as { error?: string }).error) : 'Registration failed';
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const verifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!totpToken) return;
    setSubmitting(true);
    try {
      await api.post('/api/auth/totp/verify', {
        registrationToken: totpToken,
        code: totpCode.trim(),
      });
      await auth.login(email.trim().toLowerCase(), password, totpCode.trim());
      setStep('done');
      navigate('/', { replace: true });
    } catch {
      toast.error('Invalid code');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create account</CardTitle>
          {regHost.kind === 'tenant' && (
            <p className="text-sm text-muted-foreground font-normal pt-1">
              Joining workspace <span className="font-mono text-foreground">{regHost.slug}</span>
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {regHost.kind === 'apex' && (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                Registration is only available on your clinic&apos;s subdomain, for example{' '}
                <span className="font-mono text-xs text-foreground">
                  https://{buildTenantHostname('your-clinic')}/register
                </span>
                .
              </p>
              <p>Ask your RouteCare administrator to create the tenant and share the correct link.</p>
              <Button variant="outline" className="w-full" asChild>
                <Link to="/login">Back to sign in</Link>
              </Button>
            </div>
          )}

          {regHost.kind === 'tenant' && step === 'credentials' && (
            <form className="space-y-4" onSubmit={submitCredentials}>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? 'Continuing…' : 'Continue'}
              </Button>
            </form>
          )}

          {regHost.kind === 'tenant' && step === 'totp' && (
            <form className="space-y-4" onSubmit={verifyTotp}>
              {qrCode && (
                <div className="flex justify-center">
                  <img src={qrCode} alt="TOTP QR" className="max-w-[200px]" />
                </div>
              )}
              <div>
                <Label htmlFor="totp">Authenticator code</Label>
                <Input
                  id="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? 'Verifying…' : 'Complete registration'}
              </Button>
            </form>
          )}

          {regHost.kind === 'tenant' && step === 'done' && (
            <p className="text-sm text-muted-foreground">Redirecting…</p>
          )}

          {regHost.kind === 'tenant' && (
            <div className="text-sm text-muted-foreground">
              <Link to="/login" className="underline">
                Already have an account?
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
