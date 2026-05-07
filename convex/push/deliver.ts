"use node";

// ─────────────────────────────────────────────────────────────────────────────
// deliver.ts — APNs push delivery worker.
//
// Port of packages/backend/src/services/push/send-push.ts (sendPushForNotification).
// Runs in the Node runtime so we can use the `apn` package (HTTP/2 to APNs).
//
// Trigger flow: notifications.createIfAllowed inserts a row, then schedules
// internal.push.onNotification.triggerOnInsert(notificationId), which in turn
// schedules this action (it can't be called directly from a mutation since
// mutations can't schedule "use node" actions).
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

// APNs priority + collapse strategy per notification type. Mirrors the
// PUSH_CONFIG constant from packages/backend/src/services/push/send-push.ts.
type PushType =
  | "NEW_EMAIL"
  | "MENTION"
  | "COMMENT"
  | "ASSIGNMENT"
  | "SLA_WARNING"
  | "SLA_BREACH"
  | "SNOOZE_REMINDER";

const PUSH_CONFIG: Record<
  PushType,
  {
    priority: 5 | 10;
    collapseId?: (data: Record<string, unknown> | null) => string | undefined;
    threadId: (data: Record<string, unknown> | null) => string;
    sound: string;
    relevanceScore: number;
  }
> = {
  NEW_EMAIL: {
    priority: 5,
    collapseId: (data) => `new-email:${(data?.userId as string) || "default"}`,
    threadId: (data) => `account:${(data?.accountId as string) || "inbox"}`,
    sound: "default",
    relevanceScore: 0.4,
  },
  MENTION: {
    priority: 10,
    threadId: () => "mentions",
    sound: "default",
    relevanceScore: 0.8,
  },
  COMMENT: {
    priority: 5,
    collapseId: (data) =>
      data?.threadId ? `comment:${data.threadId as string}` : undefined,
    threadId: (data) =>
      data?.threadId ? `comments:${data.threadId as string}` : "comments",
    sound: "default",
    relevanceScore: 0.3,
  },
  ASSIGNMENT: {
    priority: 10,
    threadId: () => "assignments",
    sound: "default",
    relevanceScore: 0.8,
  },
  SLA_WARNING: {
    priority: 10,
    collapseId: (data) =>
      data?.threadId ? `sla:${data.threadId as string}` : undefined,
    threadId: () => "sla",
    sound: "default",
    relevanceScore: 0.8,
  },
  SLA_BREACH: {
    priority: 10,
    collapseId: (data) =>
      data?.threadId ? `sla:${data.threadId as string}` : undefined,
    threadId: () => "sla",
    sound: "default",
    relevanceScore: 1.0,
  },
  SNOOZE_REMINDER: {
    priority: 10,
    threadId: () => "snooze",
    sound: "default",
    relevanceScore: 0.6,
  },
};

const GENERIC_TITLES: Record<PushType, string> = {
  NEW_EMAIL: "New email",
  MENTION: "New mention",
  COMMENT: "New comment",
  ASSIGNMENT: "New assignment",
  SLA_WARNING: "Action needed",
  SLA_BREACH: "Urgent action needed",
  SNOOZE_REMINDER: "Reminder",
};

function isApnsConfigured(): boolean {
  return !!(
    process.env.APNS_KEY_ID &&
    process.env.APNS_TEAM_ID &&
    (process.env.APNS_KEY_CONTENT || process.env.APNS_KEY_PATH)
  );
}

/**
 * Quiet-hours check matching the source send-push.ts implementation.
 * Returns true when push should be suppressed for the current time.
 */
function isInQuietHours(
  start: string | null,
  end: string | null,
  tz: string | null,
): boolean {
  if (!start || !end) return false;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const currentTime = formatter.format(new Date()); // "HH:MM"
    const [startH, startM] = start.split(":").map(Number);
    const [endH, endM] = end.split(":").map(Number);
    const [nowH, nowM] = currentTime.split(":").map(Number);
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;
    const nowMin = nowH * 60 + nowM;
    if (startMin > endMin) {
      // Overnight (e.g. 22:00 → 07:00).
      return nowMin >= startMin || nowMin < endMin;
    }
    return nowMin >= startMin && nowMin < endMin;
  } catch {
    return false;
  }
}

/** Strip HTML, signatures, and clamp to a sane preview length. */
function sanitizeForPush(text: string | null | undefined, max = 200): string {
  if (!text) return "";
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/--\s*\n[\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// _deliverPushNotification — fan out one notification to every device token
// the recipient owns.
// ─────────────────────────────────────────────────────────────────────────────

export const _deliverPushNotification = internalAction({
  args: {
    notificationId: v.id("notifications"),
    userId: v.id("users"),
  },
  handler: async (ctx, { notificationId, userId }): Promise<void> => {
    // 1. Pull notification + prefs + badge count in one query.
    const fetched = await ctx.runQuery(
      internal.push.deliverData._getNotificationForDelivery,
      { notificationId },
    );
    if (!fetched) return;
    const { notification, prefs, badgeCount } = fetched;

    // Sanity: the trigger may pass userId from the mutation call, but verify
    // alignment with the persisted notification row.
    if (notification.userId !== userId) return;

    // 2. Master push toggle.
    if (prefs && prefs.pushEnabled === false) return;

    // 3. Quiet hours (SLA_BREACH overrides — matches source behavior).
    if (notification.type !== "SLA_BREACH" && prefs) {
      if (
        isInQuietHours(
          prefs.quietHoursStart,
          prefs.quietHoursEnd,
          prefs.quietHoursTimezone,
        )
      ) {
        return;
      }
    }

    // 4. Look up device tokens. No tokens → nothing to do.
    const tokens = await ctx.runQuery(
      internal.push.deliverData._listDeviceTokens,
      { userId },
    );
    if (tokens.length === 0) return;

    const today = ymd(new Date());

    // 5. APNs not configured (e.g. local dev) — record one synthetic log row
    //    per token so the admin dashboard stays accurate, then bail.
    if (!isApnsConfigured()) {
      for (const token of tokens) {
        await ctx.runMutation(internal.push.deliverData._recordDeliveryLog, {
          userId,
          deviceTokenId: token._id,
          notificationId,
          status: "failed" as const,
          errorMessage: "APNS not configured",
        });
        await ctx.runMutation(internal.push.deliverData._incrementCounter, {
          userId,
          status: "failed",
          date: today,
        });
      }
      return;
    }

    // 6. Lazy-import the APNs SDK only when we're about to send.
    const apn = (await import("@parse/node-apn")) as typeof import("@parse/node-apn");

    const keyContent = process.env.APNS_KEY_CONTENT
      ? Buffer.from(process.env.APNS_KEY_CONTENT, "base64").toString("utf-8")
      : process.env.APNS_KEY_PATH;

    const provider = new apn.Provider({
      token: {
        key: keyContent as string,
        keyId: process.env.APNS_KEY_ID as string,
        teamId: process.env.APNS_TEAM_ID as string,
      },
      production: process.env.APNS_PRODUCTION === "true",
    });

    const config = PUSH_CONFIG[notification.type as PushType];
    const notifData =
      (notification.data as Record<string, unknown> | null) ?? null;

    // 7. Build the alert payload (respects preview-on-lock privacy setting).
    let title = notification.title;
    let body = sanitizeForPush(notification.body);

    if (prefs && prefs.showPreviewOnLock === false) {
      title = GENERIC_TITLES[notification.type as PushType] ?? "Orbi Mail";
      body = "Open Orbi Mail to view";
    }

    try {
      for (const token of tokens) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const apnsNotification = new apn.Notification() as any;
          apnsNotification.alert = { title, body: body || "" };
          apnsNotification.badge = badgeCount;
          apnsNotification.topic =
            token.bundleId || process.env.APNS_BUNDLE_ID || "com.orbimail.app";
          apnsNotification.pushType = "alert";
          apnsNotification.priority = config?.priority ?? 5;
          apnsNotification.threadId = config?.threadId(notifData) ?? "default";
          apnsNotification.category = notification.type;
          apnsNotification.mutableContent = true;
          if (prefs?.soundEnabled !== false) {
            apnsNotification.sound = config?.sound ?? "default";
          }
          const collapseId = config?.collapseId?.(notifData);
          if (collapseId) apnsNotification.collapseId = collapseId;

          apnsNotification.payload = {
            notificationId,
            type: notification.type,
            ...(notifData ?? {}),
          };

          const result = await provider.send(apnsNotification, token.token);

          // ─── Successes ─────────────────────────────────────────────────
          if (result.sent && result.sent.length > 0) {
            await ctx.runMutation(
              internal.push.deliverData._recordDeliveryLog,
              {
                userId,
                deviceTokenId: token._id,
                notificationId,
                status: "sent" as const,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                apnsId: (result.sent[0] as any)?.device,
              },
            );
            await ctx.runMutation(internal.push.deliverData._incrementCounter, {
              userId,
              status: "sent",
              date: today,
            });
          }

          // ─── Failures ──────────────────────────────────────────────────
          if (result.failed && result.failed.length > 0) {
            const failure = result.failed[0];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const status = (failure as any).status as string | undefined;
            const reason = failure.response?.reason;

            const isInvalidToken =
              status === "410" ||
              reason === "Unregistered" ||
              reason === "BadDeviceToken";
            const finalStatus = isInvalidToken
              ? ("token_invalid" as const)
              : status === "429"
                ? ("rate_limited" as const)
                : ("failed" as const);

            await ctx.runMutation(
              internal.push.deliverData._recordDeliveryLog,
              {
                userId,
                deviceTokenId: token._id,
                notificationId,
                status: finalStatus,
                errorMessage:
                  reason ||
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (failure as any).error?.message ||
                  "Unknown error",
                errorCode: status ? parseInt(status, 10) : undefined,
              },
            );
            await ctx.runMutation(internal.push.deliverData._incrementCounter, {
              userId,
              status: finalStatus,
              date: today,
            });

            if (isInvalidToken) {
              await ctx.runMutation(
                internal.push.deliverData._invalidateToken,
                { tokenId: token._id },
              );
            }
          }
        } catch (err: unknown) {
          // Per-token exception — log and carry on.
          const message =
            err instanceof Error ? err.message : "Unknown delivery error";
          await ctx.runMutation(
            internal.push.deliverData._recordDeliveryLog,
            {
              userId,
              deviceTokenId: token._id,
              notificationId,
              status: "failed" as const,
              errorMessage: message,
            },
          );
          await ctx.runMutation(internal.push.deliverData._incrementCounter, {
            userId,
            status: "failed",
            date: today,
          });
        }
      }
    } finally {
      // Always close the provider so the action can finalize its connections.
      try {
        provider.shutdown();
      } catch {
        // ignore shutdown errors
      }
    }
  },
});
