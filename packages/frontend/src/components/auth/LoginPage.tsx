import { useState } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import { Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';

type Flow = 'signIn' | 'signUp';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [flow, setFlow] = useState<Flow>('signIn');
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuthActions();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await signIn('password', { email, password, flow });
      // App.tsx routes on auth state change via useConvexAuth
    } catch (err) {
      const fallback =
        flow === 'signIn'
          ? 'Invalid credentials'
          : 'Could not create account';
      const message =
        err instanceof Error && err.message ? err.message : fallback;
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-surface">
      {/* Warm brand wash behind the card */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 55% 45% at 50% 8%, rgba(255,140,0,0.12), transparent 70%), radial-gradient(ellipse 40% 35% at 85% 90%, rgba(255,140,0,0.07), transparent 70%)',
        }}
      />

      <div className="relative w-full max-w-[380px] px-6">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center">
          <img
            src="/orbi-logo.svg"
            alt="Orbi"
            className="h-16 w-16 object-contain drop-shadow-[0_6px_16px_rgba(255,126,22,0.35)]"
            draggable={false}
          />
          <h1 className="font-brand mt-5 text-[26px] tracking-tight text-text-primary">
            Orbi&nbsp;Mail
          </h1>
          <p className="mt-1 text-[13px] text-text-tertiary">
            {flow === 'signIn'
              ? 'Welcome back — sign in to your workspace'
              : 'Create your account'}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-border/70 bg-white p-6 shadow-[0_18px_50px_-20px_rgba(26,26,26,0.25)]">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                autoComplete="email"
                className="block w-full rounded-xl border border-border bg-surface/40 px-3.5 py-2.5 text-sm text-text-primary transition-colors placeholder:text-text-tertiary focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/25"
                placeholder="you@choquer.agency"
                required
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={flow === 'signIn' ? 'current-password' : 'new-password'}
                className="block w-full rounded-xl border border-border bg-surface/40 px-3.5 py-2.5 text-sm text-text-primary transition-colors placeholder:text-text-tertiary focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/25"
                placeholder="••••••••"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-primary/25 transition-all hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/30 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 active:scale-[0.99] disabled:opacity-60"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading
                ? flow === 'signIn'
                  ? 'Signing in…'
                  : 'Creating account…'
                : flow === 'signIn'
                ? 'Sign in'
                : 'Create account'}
            </button>
          </form>
        </div>

        {/* Flow toggle */}
        <p className="mt-5 text-center text-[12px] text-text-tertiary">
          {flow === 'signIn' ? (
            <>
              No account?{' '}
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => setFlow('signUp')}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => setFlow('signIn')}
              >
                Sign in
              </button>
            </>
          )}
        </p>

        <p className="mt-8 text-center text-[11px] text-text-tertiary/70">
          Choquer Creative · invite-only
        </p>
      </div>
    </div>
  );
}
