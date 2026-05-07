import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Meeting detections — CRUD only.
// Detection (Claude-driven) is owned by Agent C (`convex/ai/meetingDetector.ts`).
// Source: packages/backend/src/routes/meetings/index.ts
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/threads/:threadId/meeting-detection */
export const listForThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    await requireUser(ctx);
    const detections = await ctx.db
      .query("meetingDetections")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .take(5);
    return detections;
  },
});

/** GET /api/meetings/:id */
export const get = query({
  args: { id: v.id("meetingDetections") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const detection = await ctx.db.get(id);
    if (!detection) {
      throw new Error("Meeting detection not found");
    }
    return detection;
  },
});

/**
 * Generic update — used by the AI detector (via internal mutation in Agent C)
 * and by future UI flows. Status transitions are also enforced here.
 */
export const update = mutation({
  args: {
    id: v.id("meetingDetections"),
    status: v.optional(
      v.union(
        v.literal("DETECTED"),
        v.literal("AVAILABILITY_CHECKED"),
        v.literal("ACCEPTED"),
        v.literal("DECLINED"),
        v.literal("EXPIRED"),
      ),
    ),
    selectedTime: v.optional(v.number()),
    calendarEventId: v.optional(v.string()),
    summary: v.optional(v.string()),
    requestedTimes: v.optional(v.any()),
  },
  handler: async (ctx, { id, ...patch }) => {
    await requireUser(ctx);
    const detection = await ctx.db.get(id);
    if (!detection) throw new Error("Meeting detection not found");

    const cleaned: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) cleaned[k] = val;
    }
    if (Object.keys(cleaned).length > 0) {
      await ctx.db.patch(id, cleaned);
    }
    return await ctx.db.get(id);
  },
});

/**
 * POST /api/meetings/:id/accept
 * Records the chosen time and (optionally) the calendar event id created
 * by the calendar provider. The actual Google Calendar / Microsoft Graph
 * call is left to the caller; the source has it as a TODO.
 */
export const accept = mutation({
  args: {
    id: v.id("meetingDetections"),
    selectedTime: v.number(),
    calendarEventId: v.optional(v.string()),
  },
  handler: async (ctx, { id, selectedTime, calendarEventId }) => {
    await requireUser(ctx);
    const detection = await ctx.db.get(id);
    if (!detection) throw new Error("Meeting detection not found");
    await ctx.db.patch(id, {
      status: "ACCEPTED",
      selectedTime,
      calendarEventId,
    });
    return await ctx.db.get(id);
  },
});

/** POST /api/meetings/:id/decline */
export const decline = mutation({
  args: { id: v.id("meetingDetections") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const detection = await ctx.db.get(id);
    if (!detection) throw new Error("Meeting detection not found");
    await ctx.db.patch(id, { status: "DECLINED" });
    return await ctx.db.get(id);
  },
});
