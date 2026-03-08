import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../lib/api';

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
    }),
    {
      name: 'orbi-auth',
      onRehydrate: (state) => {
        return (rehydratedState) => {
          if (rehydratedState?.token) {
            api.setToken(rehydratedState.token);
          }
        };
      },
    },
  ),
);
