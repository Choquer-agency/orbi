import { create } from 'zustand';

// ─────────────────────────────────────────────────────────────────────────────
// authStore — Convex Auth backed.
//
// Convex Auth owns the source-of-truth for sign-in/sign-out state via
// `useConvexAuth()` and `useAuthActions()`. This store remains as a
// thin synchronous accessor for the rest of the app (Header, Compose,
// EmailViewer, etc.) which read `state.user.{id,name,email,avatarUrl}`
// without going through React hooks.
//
// `<AuthBridge />` (mounted in App.tsx) keeps this store in sync with
// Convex Auth using `useQuery(api.users.me)`.
// ─────────────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
}

interface AuthState {
  // Legacy — JWT no longer exists. Kept as `null` for backwards-compat with
  // any code that still reads `s.token`. Will be removed once all callers
  // migrate to Convex Auth's session.
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;

  // Setters used by AuthBridge + components.
  setUser: (user: User | null) => void;
  setIsAuthenticated: (value: boolean) => void;

  // Mutations expected by existing components — re-implemented as
  // delegates that throw clear errors. Components should migrate to
  // `useAuthActions()` (signIn/signOut) and `useMutation(api.users.updateProfile)`.
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setAuth: (token: string, user: User) => void;
  updateUser: (updates: { name?: string; avatarUrl?: string }) => Promise<void>;
}

// AuthBridge registers Convex Auth's signOut here so legacy `logout()` calls
// from Header / MobileSettingsView still tear down the Convex session.
let signOutFn: (() => Promise<void>) | null = null;
export function registerConvexSignOut(fn: (() => Promise<void>) | null) {
  signOutFn = fn;
}

export const useAuthStore = create<AuthState>()((set) => ({
  token: null,
  user: null,
  isAuthenticated: false,

  setUser: (user) => set({ user }),
  setIsAuthenticated: (value) =>
    set({
      isAuthenticated: value,
      ...(value ? {} : { user: null }),
    }),

  // Deprecated — kept for backwards compatibility. New code should call
  // `useAuthActions().signIn("password", { email, password, flow: "signIn" })`.
  login: async () => {
    throw new Error(
      'authStore.login is deprecated. Use useAuthActions() from @convex-dev/auth/react.',
    );
  },

  // Deprecated — components should call `useAuthActions().signOut()` directly,
  // which clears the Convex Auth session. AuthBridge will then null `user`.
  logout: () => {
    set({ token: null, user: null, isAuthenticated: false });
    if (signOutFn) {
      void signOutFn().catch(() => {
        // Best-effort — local state already cleared above.
      });
    }
  },

  setAuth: (_token: string, user: User) => {
    set({ token: null, user, isAuthenticated: true });
  },

  // Deprecated — components should switch to `useMutation(api.users.updateProfile)`.
  updateUser: async () => {
    throw new Error(
      'authStore.updateUser is deprecated. Use useMutation(api.users.updateProfile) instead.',
    );
  },
}));
