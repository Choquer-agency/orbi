// ─────────────────────────────────────────────────────────────────────────────
// onNotification.ts — V8 trigger mutation called by notifications.createIfAllowed
// after a row is inserted, to fan out APNs delivery.
//
// Mutations cannot schedule "use node" actions directly via runAfter to a
// non-internal action, but they can schedule internal actions in any runtime.
// This file lives in the V8 runtime (no "use node") so it can be invoked from
// any other mutation; it then schedules the Node-runtime delivery action.
// ─────────────────────────────────────────────────────────────────────────────

import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

/**
 * Schedule push delivery for a freshly-inserted notification row.
 * Idempotent and best-effort — if the notification was deleted between insert
 * and delivery, the action no-ops.
 */
export const triggerOnInsert = internalMutation({
  args: {
    notificationId: v.id("notifications"),
    userId: v.id("users"),
  },
  handler: async (ctx, { notificationId, userId }) => {
    await ctx.scheduler.runAfter(
      0,
      internal.push.deliver._deliverPushNotification,
      { notificationId, userId },
    );
  },
});
