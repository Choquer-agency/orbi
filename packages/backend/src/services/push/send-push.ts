import type { PrismaClient, NotificationType, Notification } from '@prisma/client';
import { getApnsProvider, isApnsConfigured } from './apns-provider.js';
import { env } from '../../config/env.js';

// APNs priority and collapse strategy per notification type
const PUSH_CONFIG: Record<
  NotificationType,
  { priority: 5 | 10; collapseId?: (data: any) => string | undefined; threadId: (data: any) => string; sound: string; relevanceScore: number }
> = {
  NEW_EMAIL: {
    priority: 5,
    collapseId: (data) => `new-email:${data?.userId || 'default'}`,
    threadId: (data) => `account:${data?.accountId || 'inbox'}`,
    sound: 'default',
    relevanceScore: 0.4,
  },
  MENTION: {
    priority: 10,
    threadId: () => 'mentions',
    sound: 'default',
    relevanceScore: 0.8,
  },
  COMMENT: {
    priority: 5,
    collapseId: (data) => data?.threadId ? `comment:${data.threadId}` : undefined,
    threadId: (data) => data?.threadId ? `comments:${data.threadId}` : 'comments',
    sound: 'default',
    relevanceScore: 0.3,
  },
  ASSIGNMENT: {
    priority: 10,
    threadId: () => 'assignments',
    sound: 'default',
    relevanceScore: 0.8,
  },
  SLA_WARNING: {
    priority: 10,
    collapseId: (data) => data?.threadId ? `sla:${data.threadId}` : undefined,
    threadId: () => 'sla',
    sound: 'default',
    relevanceScore: 0.8,
  },
  SLA_BREACH: {
    priority: 10,
    collapseId: (data) => data?.threadId ? `sla:${data.threadId}` : undefined,
    threadId: () => 'sla',
    sound: 'default',
    relevanceScore: 1.0,
  },
  SNOOZE_REMINDER: {
    priority: 10,
    threadId: () => 'snooze',
    sound: 'default',
    relevanceScore: 0.6,
  },
};

/**
 * Check if current time falls within user's quiet hours.
 * Returns true if push should be suppressed.
 */
function isInQuietHours(
  quietHoursStart: string | null,
  quietHoursEnd: string | null,
  quietHoursTimezone: string | null,
): boolean {
  if (!quietHoursStart || !quietHoursEnd) return false;

  try {
    const tz = quietHoursTimezone || 'UTC';
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const currentTime = formatter.format(now); // "HH:MM"

    const [startH, startM] = quietHoursStart.split(':').map(Number);
    const [endH, endM] = quietHoursEnd.split(':').map(Number);
    const [nowH, nowM] = currentTime.split(':').map(Number);

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    const nowMinutes = nowH * 60 + nowM;

    // Handle overnight quiet hours (e.g., 22:00 - 07:00)
    if (startMinutes > endMinutes) {
      return nowMinutes >= startMinutes || nowMinutes < endMinutes;
    }
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } catch {
    return false;
  }
}

/**
 * Sanitize content for push notification payload.
 * Strips HTML, removes signatures, truncates to safe length.
 */
function sanitizeForPush(text: string | null | undefined, maxLength = 200): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '') // strip HTML tags
    .replace(/--\s*\n[\s\S]*$/, '') // remove email signatures
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim()
    .slice(0, maxLength);
}

/**
 * Send push notification for a Notification record.
 * Called from createNotificationIfAllowed after DB insert.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function sendPushForNotification(
  prisma: PrismaClient,
  notification: Notification,
): Promise<void> {
  if (!isApnsConfigured()) return;

  // Check user push preferences
  const prefs = await prisma.notificationPreferences.findUnique({
    where: { userId: notification.userId },
  });

  if (prefs?.pushEnabled === false) return;

  // Check quiet hours — SLA_BREACH overrides quiet hours
  if (notification.type !== 'SLA_BREACH' && prefs) {
    if (isInQuietHours(prefs.quietHoursStart, prefs.quietHoursEnd, prefs.quietHoursTimezone)) {
      return;
    }
  }

  // Fetch all device tokens for this user
  const deviceTokens = await prisma.deviceToken.findMany({
    where: { userId: notification.userId },
  });

  if (deviceTokens.length === 0) return;

  const provider = await getApnsProvider();
  if (!provider) return;

  const config = PUSH_CONFIG[notification.type];
  const notifData = notification.data as Record<string, any> | null;

  // Compute badge count
  const badge = await prisma.notification.count({
    where: { userId: notification.userId, isRead: false },
  });

  // Build notification content based on lock screen privacy setting
  let title = notification.title;
  let body = sanitizeForPush(notification.body);

  if (prefs?.showPreviewOnLock === false) {
    // Generic content for privacy
    const genericTitles: Record<NotificationType, string> = {
      NEW_EMAIL: 'New email',
      MENTION: 'New mention',
      COMMENT: 'New comment',
      ASSIGNMENT: 'New assignment',
      SLA_WARNING: 'Action needed',
      SLA_BREACH: 'Urgent action needed',
      SNOOZE_REMINDER: 'Reminder',
    };
    title = genericTitles[notification.type] || 'Orbi Mail';
    body = 'Open Orbi Mail to view';
  }

  // Dynamically import @parse/node-apn for Notification construction
  const apn = await import('@parse/node-apn');

  for (const deviceToken of deviceTokens) {
    try {
      const apnsNotification = new apn.Notification() as any;
      apnsNotification.alert = { title, body: body || '' };
      apnsNotification.badge = badge;
      apnsNotification.topic = env.APNS_BUNDLE_ID;
      apnsNotification.pushType = 'alert';
      apnsNotification.priority = config.priority;
      apnsNotification.threadId = config.threadId(notifData);
      apnsNotification.category = notification.type;
      apnsNotification.mutableContent = true;

      // Sound — respect user preference
      if (prefs?.soundEnabled !== false) {
        apnsNotification.sound = config.sound;
      }

      // Collapse ID to group rapid-fire notifications
      const collapseId = config.collapseId?.(notifData);
      if (collapseId) {
        apnsNotification.collapseId = collapseId;
      }

      // Custom data payload for deep linking
      apnsNotification.payload = {
        notificationId: notification.id,
        type: notification.type,
        threadId: notifData?.threadId,
        emailId: notifData?.emailId,
        ...(notifData || {}),
      };

      const result = await provider.send(apnsNotification, deviceToken.token);

      // Log delivery result
      if (result.sent?.length > 0) {
        await prisma.pushDeliveryLog.create({
          data: {
            userId: notification.userId,
            deviceTokenId: deviceToken.id,
            notificationId: notification.id,
            apnsId: result.sent[0]?.device,
            status: 'sent',
          },
        }).catch(() => {}); // Best-effort logging
      }

      if (result.failed?.length > 0) {
        const failure = result.failed[0];
        const status = failure.status;
        const reason = failure.response?.reason;

        // Handle token invalidation — APNs says this device is gone
        if (status === '410' || reason === 'Unregistered' || reason === 'BadDeviceToken') {
          await prisma.deviceToken.delete({
            where: { id: deviceToken.id },
          }).catch(() => {});

          await prisma.pushDeliveryLog.create({
            data: {
              userId: notification.userId,
              deviceTokenId: deviceToken.id,
              notificationId: notification.id,
              status: 'token_invalid',
              errorMessage: reason || 'Token invalid',
              errorCode: status ? parseInt(status) : null,
            },
          }).catch(() => {});
        } else {
          await prisma.pushDeliveryLog.create({
            data: {
              userId: notification.userId,
              deviceTokenId: deviceToken.id,
              notificationId: notification.id,
              status: status === '429' ? 'rate_limited' : 'failed',
              errorMessage: reason || failure.error?.message || 'Unknown error',
              errorCode: status ? parseInt(status) : null,
            },
          }).catch(() => {});
        }
      }
    } catch (err: any) {
      console.error(
        `[push] Error sending to device ${deviceToken.id.slice(0, 8)}:`,
        err.message,
      );
    }
  }
}

/**
 * Send a silent push to trigger background data refresh.
 * No visible notification — just wakes the app for ~30s.
 */
export async function sendSilentPush(
  prisma: PrismaClient,
  userId: string,
  data: Record<string, any> = {},
): Promise<void> {
  if (!isApnsConfigured()) return;

  const deviceTokens = await prisma.deviceToken.findMany({
    where: { userId },
  });

  if (deviceTokens.length === 0) return;

  const provider = await getApnsProvider();
  if (!provider) return;

  const apn = await import('@parse/node-apn');

  for (const deviceToken of deviceTokens) {
    try {
      const notification = new apn.Notification();
      notification.topic = env.APNS_BUNDLE_ID;
      notification.pushType = 'background';
      notification.priority = 5; // Must be 5 for silent push
      notification.contentAvailable = true;
      notification.payload = data;

      await provider.send(notification, deviceToken.token);
    } catch (err: any) {
      console.error(`[push] Silent push error for device ${deviceToken.id.slice(0, 8)}:`, err.message);
    }
  }
}
