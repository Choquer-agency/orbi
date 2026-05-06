import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { api } from '../lib/api';
import { secureStorage } from '../lib/secureStorage';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
}

interface AuthState {
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setAuth: (token: string, user: User) => void;
  updateUser: (updates: { name?: string; avatarUrl?: string }) => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      isAuthenticated: false,

      login: async (email: string, password: string) => {
        const res = await api.post<{ data: { user: User; token: string } }>('/auth/login', {
          email,
          password,
        });
        const { user, token } = res.data;
        api.setToken(token);
        set({ token, user, isAuthenticated: true });
      },

      logout: () => {
        api.setToken(null);
        set({ token: null, user: null, isAuthenticated: false });
      },

      setAuth: (token: string, user: User) => {
        api.setToken(token);
        set({ token, user, isAuthenticated: true });
      },

      updateUser: async (updates: { name?: string; avatarUrl?: string }) => {
        const res = await api.patch<{ data: User }>('/users/me', updates);
        set({ user: res.data });
      },
    }),
    {
      name: 'orbi-auth',
      storage: createJSONStorage(() => secureStorage),
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);

// Sync token to api client on store changes (covers both rehydration and login)
useAuthStore.subscribe((state) => {
  api.setToken(state.token);
});

// Also set immediately from current persisted state
api.setToken(useAuthStore.getState().token);

// Auto-logout on 401 responses
api.setOnUnauthorized(() => {
  useAuthStore.getState().logout();
});
