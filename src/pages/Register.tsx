import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import {
  derivePdk,
  deriveRecoveryHash,
  deriveRecoveryWrappingKey,
  formatRecoveryKey,
  generatePdkSalt,
  generateRecoveryKey,
  generateWorkspaceKey,
  unwrapWorkspaceKeyFromServerWrap,
  wrapKey,
} from '@/lib/crypto';
import { setActiveWorkspaceId } from '@/lib/api';
import type { AuthMe } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';

type Step = 'credentials' | 'recovery' | 'totp' | 'done';

interface PendingRegistration {
  email: string;
  password: string;
  registrationToken: string;
  recoveryKey: string;
  mfaDisabled: boolean;
}

export default function RegisterPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('credentials');
  const [submitting, setSubmitting] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [pending, setPending] = useState<PendingRegistration | null>(null);
  const [savedAck, setSavedAck] = useState(false);

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpToken, setTotpToken] = useState<string | null>(null);

  const finalizeRegisteredSession = async (p: PendingRegistration, loginOpts: { code?: string }) => {
    await api.post<{ pdkSalt: string }>('/api/auth/login', {
      email: p.email,
      password: p.password,
      ...(loginOpts.code ? { code: loginOpts.code } : {}),
    });
    const meData = await api.get<AuthMe>('/api/auth/me');
    const blob = await api.get<{ wrappedWorkspaceKey: string; workspaceId?: string }>('/api/snapshot');
    if (blob.workspaceId) setActiveWorkspaceId(blob.workspaceId);
    const wk = await unwrapWorkspaceKeyFromServerWrap(blob.wrappedWorkspaceKey, {
      password: p.password,
      pdkSalt: meData.pdkSalt,
    });
    auth.setUnlockedSession(meData, wk, blob.workspaceId);
    setStep('done');
    navigate('/', { replace: true });
  };

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    if (password !== confirmPassword) { toast.error('Passwords do not match'); return; }

    setSubmitting(true);
    try {
      const pdkSalt = generatePdkSalt();
      const recoveryKey = generateRecoveryKey();
      const wk = await generateWorkspaceKey();

      const pdk = await derivePdk(password, pdkSalt);
      const recoveryWrappingKey = await deriveRecoveryWrappingKey(recoveryKey, pdkSalt);

      const wrappedWorkspaceKey = await wrapKey(wk, pdk);
      const wrappedWorkspaceKeyRecovery = await wrapKey(wk, recoveryWrappingKey);
      const recoveryKeyHash = await deriveRecoveryHash(recoveryKey);

      const { registrationToken, mfaDisabled } = await api.post<{
        registrationToken: string;
        mfaDisabled?: boolean;
      }>('/api/auth/register', {
        email: email.trim().toLowerCase(),
        password,
        pdkSalt,
        recoveryKeyHash,
        wrappedWorkspaceKey,
        wrappedWorkspaceKeyRecovery,
      });

      setPending({
        email: email.trim().toLowerCase(),
        password,
        registrationToken,
        recoveryKey,
        mfaDisabled: !!mfaDisabled,
      });
      setStep('recovery');
    } catch (err: any) {
      toast.error(err?.message ?? 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  const continueToTotp = async () => {
    if (!pending) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ registrationToken: string; otpauth: string; qrCode: string }>(
        '/api/auth/totp/enroll',
        { registrationToken: pending.registrationToken },
      );
      setQrDataUrl(res.qrCode);
      setOtpauth(res.otpauth);
      setTotpToken(res.registrationToken);
      setStep('totp');
    } catch (err: any) {
      toast.error(err?.message ?? 'TOTP enrollment failed');
    } finally {
      setSubmitting(false);
    }
  };

  const continueAfterRecovery = async () => {
    if (!pending || !savedAck) return;
    if (pending.mfaDisabled) {
      setSubmitting(true);
      try {
        await finalizeRegisteredSession(pending, {});
      } catch (err: any) {
        toast.error(err?.message ?? 'Sign-in failed');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    await continueToTotp();
  };

  const verifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pending || !totpToken) return;
    setSubmitting(true);
    try {
      await api.post('/api/auth/totp/verify', {
        registrationToken: totpToken,
        code: totpCode.trim(),
      });

      await finalizeRegisteredSession(pending, { code: totpCode.trim() });
    } catch (err: any) {
      toast.error(err?.message ?? 'Verification failed');
    } finally {
      setSubmitting(false);
    }
  };

  const copyRecovery = async () => {
    if (!pending) return;
    await navigator.clipboard.writeText(pending.recoveryKey);
    toast.success('Recovery key copied');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {step === 'credentials' && 'Create your account'}
            {step === 'recovery' && 'Save your recovery key'}
            {step === 'totp' && 'Set up authenticator'}
            {step === 'done' && 'All set'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {step === 'credentials' && (
            <>
              <form className="space-y-4" onSubmit={submitCredentials}>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)} />
                  <p className="text-xs text-muted-foreground mt-1">Minimum 8 characters. Choose carefully — losing both your password and recovery key means losing all data.</p>
                </div>
                <div>
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input id="confirm" type="password" autoComplete="new-password" required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? 'Generating keys…' : 'Continue'}
                </Button>
              </form>
              <div className="mt-4 text-sm text-muted-foreground">
                Already have an account? <Link to="/login" className="underline">Sign in</Link>
              </div>
            </>
          )}

          {step === 'recovery' && pending && (
            <div className="space-y-4">
              <p className="text-sm">
                Your <strong>recovery key</strong> is the only way to regain access if you forget your password.
                Save it offline somewhere safe (password manager, paper) — we will <strong>never</strong> see it again.
              </p>
              {pending.mfaDisabled && (
                <p className="text-sm text-muted-foreground">
                  Your account does not require an authenticator app — after this step you will be signed in directly.
                </p>
              )}
              <div className="rounded-md border bg-muted/40 p-3 font-mono text-sm break-all leading-relaxed">
                {formatRecoveryKey(pending.recoveryKey)}
              </div>
              <Button variant="outline" size="sm" onClick={copyRecovery}>
                <Copy className="w-4 h-4 mr-2" /> Copy to clipboard
              </Button>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={savedAck} onCheckedChange={(v) => setSavedAck(!!v)} className="mt-0.5" />
                <span>I have saved my recovery key. I understand losing it along with my password means losing all my data.</span>
              </label>
              <Button className="w-full" onClick={continueAfterRecovery} disabled={!savedAck || submitting}>
                {submitting ? 'Working…' : pending.mfaDisabled ? 'Finish' : 'Continue'}
              </Button>
            </div>
          )}

          {step === 'totp' && (
            <form className="space-y-4" onSubmit={verifyTotp}>
              <p className="text-sm">
                Scan this QR code in an authenticator app (1Password, Authy, Google Authenticator), then enter the 6-digit code it shows.
              </p>
              {qrDataUrl && <img src={qrDataUrl} alt="TOTP QR code" className="mx-auto bg-white p-2 rounded" />}
              {otpauth && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Can't scan? Enter manually</summary>
                  <code className="block mt-2 break-all bg-muted/40 p-2 rounded">{otpauth}</code>
                </details>
              )}
              <div>
                <Label htmlFor="totp">Authenticator code</Label>
                <Input id="totp" inputMode="numeric" required value={totpCode} onChange={e => setTotpCode(e.target.value)} />
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? 'Verifying…' : 'Verify and finish'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
