import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '../stores/authStore';
import { useNotificationPreferences } from './useNotificationPreferences';
import { showDesktopNotification, updateBadgeCount } from '../lib/desktopNotifications';
import { playNotificationSound } from '../lib/notificationSound';
import { api } from '../lib/api';
import { isWeb } from '../lib/platform';

function getSocketUrl(): string {
  if (!isWeb()) {
    const apiUrl = import.meta.env.VITE_API_URL || 'https://api.orbimail.com/api';
    return apiUrl.replace(/\/api\/?$/, '');
  }
  return '/';
}

export function useSocket() {
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();
  const { data: prefs } = useNotificationPreferences();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!token) return;

    const socket = io(getSocketUrl(), {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socket.on('notification:new', async (notification: { title: string; body?: string }) => {
      // Invalidate queries for instant UI update
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] });

      // Show toast
      toast(notification.title, { duration: 4000 });

      const currentPrefs = prefsRef.current;

      // Desktop notification
      if (currentPrefs?.desktopEnabled) {
        showDesktopNotification(notification.title, notification.body || '');
      }

      // Sound
      if (currentPrefs?.soundEnabled) {
        playNotificationSound();
      }

      // Update Electron badge count
      if (window.electronAPI?.isElectron) {
        try {
          const countData = await api.get<{ data: { count: number } }>('/notifications/unread-count');
          updateBadgeCount(countData.data?.count ?? 0);
        } catch {
          // Badge update is best-effort
        }
      }
    });

    socket.on('threads:updated', (data: { threadIds?: string[] }) => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      if (data.threadIds) {
        for (const id of data.threadIds) {
          queryClient.invalidateQueries({ queryKey: ['thread', id] });
        }
      }
    });

    socket.on('comments:updated', (data: { threadId: string }) => {
      queryClient.invalidateQueries({ queryKey: ['comments', data.threadId] });
    });

    socket.on('drafts:updated', () => {
      queryClient.invalidateQueries({ queryKey: ['draft-count'] });
    });

    // On reconnect, invalidate all queries to catch up on missed events
    let isInitialConnect = true;
    socket.on('connect', () => {
      if (isInitialConnect) {
        isInitialConnect = false;
        return;
      }
      queryClient.invalidateQueries();
    });

    socketRef.current = socket;

    // On app foreground (iOS): force reconnect + refresh stale data
    const handleForeground = () => {
      if (socket.disconnected) {
        socket.connect();
      }
      queryClient.invalidateQueries();
    };
    window.addEventListener('app-foreground', handleForeground);

    return () => {
      window.removeEventListener('app-foreground', handleForeground);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, queryClient]);
}
