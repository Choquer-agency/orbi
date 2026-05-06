import type { PrismaClient, NotificationType } from '@prisma/client';
import type { Server } from 'socket.io';
import { sendPushForNotification } from './push/send-push.js';

const TYPE_TO_PREF: Record<NotificationType, string> = {
  NEW_EMAIL: 'enableNewEmail',
  MENTION: 'enableMention',
  COMMENT: 'enableComment',
  ASSIGNMENT: 'enableAssignment',
  SLA_WARNING: 'enableSlaWarning',
  SLA_BREACH: 'enableSlaBreach',
  SNOOZE_REMINDER: 'enableSnoozeReminder',
};

export async function createNotificationIfAllowed(
  prisma: PrismaClient,
  data: {
    userId: string;
    type: NotificationType;
    title: string;
    body?: string;
    data?: any;
  },
  io?: Server,
) {
  // Check user's notification preferences
  const prefs = await prisma.notificationPreferences.findUnique({
    where: { userId: data.userId },
  });

  // If no prefs record, all notifications are enabled by default
  if (prefs) {
    const prefKey = TYPE_TO_PREF[data.type] as keyof typeof prefs;
    if (prefKey && prefs[prefKey] === false) {
      return null; // User has disabled this notification type
    }
  }

  const notification = await prisma.notification.create({ data });

  // Emit real-time event to the target user
  if (io) {
    io.to(`user:${data.userId}`).emit('notification:new', notification);
  }

  // Send push notification to all registered devices (fire-and-forget)
  sendPushForNotification(prisma, notification).catch((err) => {
    console.error(`[push] Failed for notification ${notification.id}:`, err.message);
  });

  return notification;
}
