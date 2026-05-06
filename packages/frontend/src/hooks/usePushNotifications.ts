import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { isNative } from '../lib/platform';
import { api } from '../lib/api';

/**
 * Manages iOS push notification lifecycle:
 * - Requests permission and registers with APNs
 * - Sends device token to backend for push delivery
 * - Handles notification taps (deep links to threads, background actions)
 * - Suppresses foreground notifications (socket handler shows toasts)
 * - Unregisters on logout
 */
export function usePushNotifications() {
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();
  const registeredRef = useRef(false);
  const deviceTokenRef = useRef<string | null>(null);

  // Register for push when authenticated on native
  useEffect(() => {
    if (!isNative() || !token || registeredRef.current) return;

    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications');

        // Check current permission
        const permStatus = await PushNotifications.checkPermissions();
        if (permStatus.receive === 'denied') return;

        if (permStatus.receive === 'prompt') {
          const result = await PushNotifications.requestPermissions();
          if (result.receive !== 'granted') return;
        }

        // Register with APNs
        await PushNotifications.register();

        // Device token received from APNs
        const regListener = await PushNotifications.addListener(
          'registration',
          async (regToken) => {
            deviceTokenRef.current = regToken.value;
            try {
              await api.post('/devices/register', {
                token: regToken.value,
                platform: 'IOS',
                sandbox: import.meta.env.DEV,
              });
              registeredRef.current = true;
            } catch (err) {
              console.error('[push] Device registration failed:', err);
              registeredRef.current = false;
            }
          },
        );

        // Registration error
        const regErrorListener = await PushNotifications.addListener(
          'registrationError',
          (err) => {
            console.error('[push] APNs registration error:', err);
          },
        );

        // Foreground notification — suppress (socket already shows toast).
        // Just invalidate queries so badge/counts stay fresh.
        const fgListener = await PushNotifications.addListener(
          'pushNotificationReceived',
          () => {
            queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] });
          },
        );

        // Notification tapped (from background or terminated state)
        const tapListener = await PushNotifications.addListener(
          'pushNotificationActionPerformed',
          (action) => {
            handleNotificationAction(action.actionId, action.notification.data);
          },
        );

        cleanup = () => {
          regListener.remove();
          regErrorListener.remove();
          fgListener.remove();
          tapListener.remove();
        };
      } catch (err) {
        console.error('[push] Setup failed:', err);
      }
    })();

    return () => cleanup?.();
  }, [token, queryClient]);

  // Unregister all device tokens on logout
  useEffect(() => {
    if (token || !isNative()) return;

    // Token became null = user logged out
    (async () => {
      try {
        await api.delete('/devices/unregister-all');
      } catch {
        // Best effort — user is already logged out
      }
      registeredRef.current = false;
      deviceTokenRef.current = null;
    })();
  }, [token]);

  // Badge clearing is handled natively in AppDelegate.applicationDidBecomeActive
  // which sets UIApplication.shared.applicationIconBadgeNumber = 0 on foreground.
}

/**
 * Handle notification action — either default tap or a specific action button.
 * Maps action IDs to navigation and API calls.
 */
function handleNotificationAction(actionId: string, data: Record<string, any>) {
  const { setSelectedFolder, setSelectedThread, setMobileActiveView } = useUiStore.getState();

  const threadId = data?.threadId;

  switch (actionId) {
    case 'tap': // Default tap
    case 'VIEW_ACTION':
      if (threadId) {
        setSelectedFolder('inbox');
        setSelectedThread(threadId);
        setMobileActiveView('viewer');
      }
      break;

    case 'REPLY_ACTION':
      if (threadId) {
        setSelectedFolder('inbox');
        setSelectedThread(threadId);
        setMobileActiveView('viewer');
        // Signal compose to open with reply
        window.dispatchEvent(
          new CustomEvent('open-reply', { detail: { threadId } }),
        );
      }
      break;

    case 'ARCHIVE_ACTION':
      if (threadId) {
        api.patch(`/threads/${threadId}`, { isArchived: true }).catch(console.error);
      }
      break;

    case 'MARK_READ_ACTION':
      if (threadId) {
        api.patch(`/threads/${threadId}`, { isRead: true }).catch(console.error);
      }
      if (data?.notificationId) {
        api.patch(`/notifications/${data.notificationId}/read`, {}).catch(console.error);
      }
      break;

    case 'ACCEPT_ACTION':
      if (data?.handoffId) {
        api.post(`/handoffs/${data.handoffId}/accept`).catch(console.error);
      }
      break;

    case 'SNOOZE_1H_ACTION':
      if (threadId) {
        const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        api.patch(`/threads/${threadId}`, { snoozedUntil: until }).catch(console.error);
      }
      break;
  }
}
