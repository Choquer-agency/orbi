import { useState } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import { Mail } from 'lucide-react';
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
    <div className="flex h-screen items-center justify-center ai-gradient-bg">
      <div className="w-full max-w-sm rounded-lg bg-white/80 p-8 shadow-sm backdrop-blur-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg bg-primary shadow-lg shadow-primary/20">
            <Mail className="h-7 w-7 text-white" />
          </div>
          <h1 className="mt-5 text-2xl font-bold text-text-primary">Orbi Mail</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {flow === 'signIn' ? 'Sign in to your account' : 'Create your account'}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-border px-3 py-2.5 text-sm text-text-primary shadow-sm placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="you@example.com"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-border px-3 py-2.5 text-sm text-text-primary shadow-sm placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="••••••••"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50"
          >
            {loading
              ? flow === 'signIn'
                ? 'Signing in...'
                : 'Creating account...'
              : flow === 'signIn'
              ? 'Sign in'
              : 'Create account'}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-text-tertiary">
          {flow === 'signIn' ? (
            <>
              No account?{' '}
              <button
                type="button"
                className="text-primary hover:underline"
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
                className="text-primary hover:underline"
                onClick={() => setFlow('signIn')}
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
