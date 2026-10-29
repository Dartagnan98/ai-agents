'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SplashScreen } from '@/components/layout/splash-screen';
import { AuthMark, useBrand } from '@/components/brand';

export default function LoginPage() {
  const router = useRouter();
  const brand = useBrand();
  const [error, setError] = useState('');
  const [resend, setResend] = useState<{ email: string; state: 'offer' | 'busy' | 'sent' } | null>(null); // invited, never set up (D, 2026-10-23)
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showSplash, setShowSplash] = useState(false);
  const accounts = null as { agency?: string } | null; // email sign-in is not part of this app
  const [twoStep, setTwoStep] = useState<false | 'app' | 'email'>(false); // email = a code was emailed (D 2026-10-12)

  // CSRF token strategy: fetch once, hold in a ref, inject on submit.
  // React state bound with value={csrfToken} and imperative writes via
  // querySelector both fail — React reconciliation resets uncontrolled
  // input values between the useEffect completion and the next render, so
  // the hidden input never carries the real token at submit time. The
  // hidden input in the JSX below is a placeholder; the real token is put
  // on the request body in handleSubmit().
  const csrfTokenRef = useRef<string>('');
  const [csrfReady, setCsrfReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
        const data = await res.json();
        if (cancelled) return;
        const token = data?.csrfToken;
        if (!token) {
          console.error('[login] /api/auth/csrf returned no token', data);
          return;
        }
        csrfTokenRef.current = token;
        setCsrfReady(true);
      } catch (err) {
        console.error('[login] csrf fetch failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // POST the credentials callback ourselves with an
    // application/x-www-form-urlencoded body. NextAuth's CSRF validator
    // reads the csrfToken field from urlencoded bodies; a multipart/form-data
    // body (what `new FormData()` produces) fails with MissingCSRF because
    // the parser doesn't recover the token from the multipart stream.
    // Bypassing signIn() from next-auth/react lets us control the exact body.
    e.preventDefault();
    setLoading(true);
    setError('');
    setResend(null);

    const form = e.currentTarget;
    const usernameInput = form.querySelector('input[name="username"]') as HTMLInputElement | null;
    const passwordInput = form.querySelector('input[name="password"]') as HTMLInputElement | null;
    const codeInput = form.querySelector('input[name="code"]') as HTMLInputElement | null;

    // Re-fetch CSRF token at submit time so body token matches the current
    // cookie. React StrictMode double-invokes the mount-time CSRF useEffect
    // in dev; if the two in-flight /api/auth/csrf responses resolve out of
    // order, the browser's authjs.csrf-token cookie can end up pinned to a
    // different token than csrfTokenRef.current — which the server rejects
    // as MissingCSRF. An atomic fetch-then-submit here forces cookie and
    // body into sync regardless of earlier mount-time races.
    let submitToken = csrfTokenRef.current;
    try {
      const freshCsrf = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
      const freshData = await freshCsrf.json();
      if (freshData?.csrfToken) submitToken = freshData.csrfToken;
    } catch {
      // Fall back to the mount-time token if the refetch fails.
    }

    // Validate same-origin: must start with / but not // (which is a protocol-relative URL)
    const callbackParam = new URL(window.location.href).searchParams.get('callbackUrl');
    const safeTarget = callbackParam && callbackParam.startsWith('/') && !callbackParam.startsWith('//') ? callbackParam : '/';

    const body = new URLSearchParams();
    body.set('csrfToken', submitToken || '');
    body.set('username', usernameInput?.value || '');
    body.set('password', passwordInput?.value || '');
    if (twoStep && codeInput?.value.trim()) body.set('code', codeInput.value.trim()); // empty in email mode = send a new code
    // Without this, Auth.js falls back to the authjs.callback-url cookie, which can be stale
    // (e.g. /login after a sign-out) and makes a successful sign-in land back on this page.
    body.set('callbackUrl', safeTarget);

    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'same-origin',
        redirect: 'follow',
      });
      const landed = res.redirected ? new URL(res.url) : null;
      const code = landed?.pathname.startsWith('/login') ? landed.searchParams.get('error') : null;
      const detail = landed?.searchParams.get('code');
      if (code && detail === 'two_step_required') { setTwoStep('app'); setError(''); setLoading(false); return; }
      if (code && detail === 'two_step_email') { setTwoStep('email'); setError(''); setLoading(false); return; }
      if (landed?.pathname.startsWith('/api/auth/error')) { setError('Sign-in hit a problem on our side. Try again in a minute.'); setLoading(false); return; } // not the browser's cookies
      if (code && detail === 'no_login') { setError('There is no login for this email. Use the exact email your invite went to (check the dots and spelling).'); setLoading(false); return; }
      if (code && detail === 'not_set_up') { setError('You have not set up your login yet. Open the invite email from the agency and click the link to choose a password.'); setResend({ email: usernameInput?.value.trim() ?? '', state: 'offer' }); setLoading(false); return; }
      if (code && detail === 'wrong_password') { setError('Wrong password for this email. Try again, or use Forgot password below.'); setLoading(false); return; }
      if (code && detail === 'rate_limited') { setError('Too many tries for this login. Wait 15 minutes, then sign in again.'); setLoading(false); return; }
      if (code && detail === 'two_step_invalid') { setError(twoStep === 'email' ? 'That code did not work. Check the newest email, or send a new code.' : 'That code did not work. Try the newest one, or a recovery code.'); setLoading(false); return; }
      if (code) {
        // CallbackRouteError usually means the rate limiter blocked the request.
        // Show a human-readable message instead of the raw error code.
        const msg = code === 'CallbackRouteError'
          ? 'Too many attempts. Please wait a few minutes and try again.'
          : code === 'CredentialsSignin' ? 'Wrong username or password.' : `Sign-in failed: ${code}`;
        setError(msg);
        setLoading(false);
        return;
      }
      // The session is the source of truth, not where the redirect landed. Navigate with a
      // relative-only target — res.url can be http://localhost:3000/ behind a reverse proxy
      // (when AUTH_URL is not set), which would send the browser to the wrong host.
      const session = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (session?.user) {
        window.location.href = safeTarget;
        return;
      }
      setError(res.ok || res.redirected
        ? 'Signed in, but this browser did not keep the session. Clear cookies for this site and try again.'
        : `Sign-in failed with status ${res.status}`);
      setLoading(false);
    } catch (err) {
      console.error('[login] submit error:', err);
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  // Splash just needs to stay visible long enough - navigation happens in parallel
  const handleSplashComplete = useCallback(() => {
    // No-op: navigation already started above
  }, []);

  return (
    <>
      {showSplash && <SplashScreen onComplete={handleSplashComplete} />}
    <div className={`canvas-grid flex min-h-screen items-center justify-center ${showSplash ? 'invisible' : ''}`}>
      <div className="w-full max-w-sm space-y-6 px-4">
        {/* Logo */}
        <div className="text-center space-y-2">
          <AuthMark />
          <p className="micro-label pt-2">{brand.name}</p>
          <h1 className="font-heading text-[26px] font-semibold tracking-[-0.02em]">Welcome back</h1>
        </div>

        {/* Login Card */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Sign in</CardTitle>
            <CardDescription className="text-xs">
              Enter your credentials to access the dashboard
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} method="POST" action="/api/auth/callback/credentials" className="space-y-4" suppressHydrationWarning>
              <input type="hidden" name="csrfToken" defaultValue="" suppressHydrationWarning />
              {twoStep && (
                <div className="space-y-1.5">
                  <Label htmlFor="code" className="text-xs">{twoStep === 'email' ? 'Code from your email' : 'Two-step code'}</Label>
                  <Input id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus required={twoStep === 'app'} placeholder={twoStep === 'email' ? '123456' : '123456 or a recovery code'} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                  {twoStep === 'email'
                    ? <p className="text-[11.5px] text-muted-foreground">We emailed you a 6-digit code (works for 10 minutes). Not there? Check spam, or <button type="button" onClick={(e) => { const f = e.currentTarget.form; const i = f?.querySelector('input[name="code"]') as HTMLInputElement | null; if (i) i.value = ''; f?.requestSubmit(); }} className="font-semibold text-primary hover:underline">send a new code</button>.</p>
                    : <p className="text-[11.5px] text-muted-foreground">From your authenticator app. Lost your phone? Use one of your recovery codes.</p>}
                </div>
              )}
              <div className={twoStep ? 'hidden' : 'space-y-1.5'}>
                <Label htmlFor="username" className="text-xs">{accounts ? 'Email or username' : 'Username'}</Label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  required
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="username"
                  placeholder={accounts ? 'you@agency.com' : 'admin'}
                  suppressHydrationWarning
                />
              </div>
              <div className={twoStep ? 'hidden' : 'space-y-1.5'}>
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-xs">Password</Label>
                  {/* see what the keyboard typed (an Arabic keyboard's ١٢٣, a missing capital) */}
                  <button type="button" onClick={() => setShowPassword((v) => !v)} aria-controls="password" aria-pressed={showPassword}
                    className="text-xs font-semibold text-primary hover:underline">{showPassword ? 'Hide' : 'Show'}</button>
                </div>
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="current-password"
                  placeholder="Enter password"
                  suppressHydrationWarning
                />
              </div>
              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}
              <Button type="submit" className="w-full" disabled={loading || !csrfReady}>
                {loading ? 'Signing in...' : csrfReady ? (twoStep ? 'Verify' : 'Sign In') : 'Loading…'}
              </Button>
              {twoStep && <button type="button" onClick={() => { setTwoStep(false); setError(''); }} className="text-xs font-semibold text-primary hover:underline">Back</button>}
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-[11px] text-muted-foreground/60">
          {brand.name}
        </p>
      </div>
    </div>
    </>
  );
}
