import { useEffect, useRef } from 'react';
import { useConvexAuth, useMutation, useConvex } from 'convex/react';
import { useUiStore } from '../stores/uiStore';
import { isNative } from '../lib/platform';
import { api } from '../../../../convex/_generated/api';

/**
 * Manages iOS push notification lifecycle:
 * - Requests permission and registers with APNs
 * - Sends device token to Convex for push delivery
 * - Handles notification taps (deep links to threads, background actions)
 * - Suppresses foreground notifications (socket handler shows toasts)
 * - Unregisters on logout
 */
export function usePushNotifications() {
  const { isAuthenticated } = useConvexAuth();
  const registerDevice = useMutation(api.devices.register);
  const unregisterAllDevices = useMutation(api.devices.unregisterAll);
  // Used by notification action handlers (mark-read, archive, snooze, accept).
  const convex = useConvex();
  const updateThread = useMutation(api.threads.update);
  const markNotificationRead = useMutation(api.notifications.markRead);
  const acceptHandoff = useMutation(api.handoffs.accept);
  const registeredRef = useRef(false);
  const deviceTokenRef = useRef<string | null>(null);

  // Register for push when authenticated on native
  useEffect(() => {
    if (!isNative() || !isAuthenticated || registeredRef.current) return;

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
              await registerDevice({
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
        // Convex queries auto-invalidate, so no manual cache busting needed.
        const fgListener = await PushNotifications.addListener(
          'pushNotificationReceived',
          () => {
            // Convex subscriptions update automatically.
          },
        );

        // Notification tapped (from background or terminated state)
        const tapListener = await PushNotifications.addListener(
          'pushNotificationActionPerformed',
          (action) => {
            handleNotificationAction(
              action.actionId,
              action.notification.data,
              { updateThread, markNotificationRead, acceptHandoff },
            );
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
  }, [isAuthenticated, registerDevice, updateThread, markNotificationRead, acceptHandoff]);

  // Unregister all device tokens on logout
  useEffect(() => {
    if (isAuthenticated || !isNative()) return;

    // Auth flipped to false = user logged out
    (async () => {
      try {
        await unregisterAllDevices({});
      } catch {
        // Best effort — user is already logged out
      }
      registeredRef.current = false;
      deviceTokenRef.current = null;
    })();
  }, [isAuthenticated, unregisterAllDevices]);

  // `convex` reference suppresses unused-var if needed in future.
  void convex;

  // Badge clearing is handled natively in AppDelegate.applicationDidBecomeActive
  // which sets UIApplication.shared.applicationIconBadgeNumber = 0 on foreground.
}

/**
 * Handle notification action — either default tap or a specific action button.
 * Maps action IDs to navigation and Convex mutations.
 */
function handleNotificationAction(
  actionId: string,
  data: Record<string, any>,
  mutations: {
    updateThread: (args: any) => Promise<any>;
    markNotificationRead: (args: any) => Promise<any>;
    acceptHandoff: (args: any) => Promise<any>;
  },
) {
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
        mutations
          .updateThread({ id: threadId, isArchived: true })
          .catch(console.error);
      }
      break;

    case 'MARK_READ_ACTION':
      if (threadId) {
        mutations
          .updateThread({ id: threadId, isRead: true })
          .catch(console.error);
      }
      if (data?.notificationId) {
        mutations
          .markNotificationRead({ id: data.notificationId })
          .catch(console.error);
      }
      break;

    case 'ACCEPT_ACTION':
      if (data?.handoffId) {
        mutations
          .acceptHandoff({ id: data.handoffId })
          .catch(console.error);
      }
      break;

    case 'SNOOZE_1H_ACTION':
      if (threadId) {
        const until = Date.now() + 60 * 60 * 1000;
        mutations
          .updateThread({ id: threadId, snoozedUntil: until })
          .catch(console.error);
      }
      break;
  }
}
