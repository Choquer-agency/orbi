import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled emails — ported from packages/backend/src/routes/scheduled-emails
// BullMQ delayed jobs are replaced by ctx.scheduler.runAt(sendAt, ...).
// The cron handler `processDueScheduledEmails` is a fallback safety net that
// Phase 4 wires up; per-record scheduling happens at create time.
// ─────────────────────────────────────────────────────────────────────────────

const addressShape = v.object({
  email: v.string(),
  name: v.optional(v.string()),
});

function normalizeAddressList(value: unknown): Array<{ email?: string; name?: string }> {
  if (Array.isArray(value)) return value as Array<{ email?: string; name?: string }>;
  if (!value) return [];
  if (typeof value === "string") return value ? [{ email: value }] : [];
  if (typeof value === "object") return [value as { email?: string; name?: string }];
  return [];
}

/** POST /api/scheduled-emails */
export const create = mutation({
  args: {
    accountId: v.id("mailAccounts"),
    threadId: v.optional(v.id("threads")),
    parentEmailId: v.optional(v.string()),
    mode: v.optional(v.string()),
    to: v.array(addressShape),
    cc: v.optional(v.array(addressShape)),
    bcc: v.optional(v.array(addressShape)),
    subject: v.string(),
    bodyHtml: v.string(),
    bodyText: v.string(),
    sendAt: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();

    if (args.sendAt <= now) {
      throw new Error("sendAt must be in the future");
    }

    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }

    const id = await ctx.db.insert("scheduledEmails", {
      userId,
      accountId: args.accountId,
      threadId: args.threadId,
      parentEmailId: args.parentEmailId,
      mode: args.mode ?? "compose",
      toAddresses: args.to,
      ccAddresses: args.cc,
      bccAddresses: args.bcc,
      subject: args.subject,
      bodyHtml: args.bodyHtml,
      bodyText: args.bodyText,
      sendAt: args.sendAt,
      status: "SCHEDULED",
    });

    // Schedule the actual send (replaces BullMQ delayed job).
    // `internal.scheduledEmails.dispatchOne` runs at sendAt and hands off to
    // emails.actuallySend. If the row is cancelled, the dispatcher no-ops.
    const jobId = await ctx.scheduler.runAt(
      args.sendAt,
      internal.scheduledEmails.dispatchOne,
      { scheduledEmailId: id },
    );

    await ctx.db.patch(id, { jobId: jobId as unknown as string });

    const created = await ctx.db.get(id);
    return created;
  },
});

/** GET /api/scheduled-emails?status=… */
export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    const userId = await requireUser(ctx);

    let rows;
    if (status) {
      rows = await ctx.db
        .query("scheduledEmails")
        .withIndex("by_user_status_sendAt", (q) =>
          q.eq("userId", userId).eq("status", status as never),
        )
        .order("asc")
        .collect();
    } else {
      rows = await ctx.db
        .query("scheduledEmails")
        .withIndex("by_user_sendAt", (q) => q.eq("userId", userId))
        .order("asc")
        .take(200);
    }

    // Hydrate account.email + displayName like the Prisma `include`.
    const accountIds = Array.from(new Set(rows.map((r) => r.accountId)));
    const accounts = await Promise.all(accountIds.map((id) => ctx.db.get(id)));
    const accountMap = new Map(
      accounts
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [a._id, { email: a.email, displayName: a.displayName }]),
    );

    return rows.map((r) => ({
      ...r,
      toAddresses: normalizeAddressList(r.toAddresses),
      ccAddresses: normalizeAddressList(r.ccAddresses),
      bccAddresses: normalizeAddressList(r.bccAddresses),
      account: accountMap.get(r.accountId) ?? null,
    }));
  },
});

export const listByThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    const account = await ctx.db.get(thread.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Thread not found");
    }

    const [scheduled, sending] = await Promise.all([
      ctx.db
        .query("scheduledEmails")
        .withIndex("by_thread_status_sendAt", (q) =>
          q.eq("threadId", threadId).eq("status", "SCHEDULED"),
        )
        .order("asc")
        .take(20),
      ctx.db
        .query("scheduledEmails")
        .withIndex("by_thread_status_sendAt", (q) =>
          q.eq("threadId", threadId).eq("status", "SENDING"),
        )
        .order("asc")
        .take(20),
    ]);

    const rows = [...scheduled, ...sending].sort((a, b) => a.sendAt - b.sendAt);
    const accountIds = Array.from(new Set(rows.map((r) => r.accountId)));
    const accounts = await Promise.all(accountIds.map((id) => ctx.db.get(id)));
    const accountMap = new Map(
      accounts
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [a._id, { email: a.email, displayName: a.displayName }]),
    );

    return rows.map((r) => ({
      ...r,
      toAddresses: normalizeAddressList(r.toAddresses),
      ccAddresses: normalizeAddressList(r.ccAddresses),
      bccAddresses: normalizeAddressList(r.bccAddresses),
      account: accountMap.get(r.accountId) ?? null,
    }));
  },
});

/** GET /api/scheduled-emails/:id */
export const get = query({
  args: { id: v.id("scheduledEmails") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) {
      throw new Error("Scheduled email not found");
    }
    const account = await ctx.db.get(row.accountId);
    return {
      ...row,
      toAddresses: normalizeAddressList(row.toAddresses),
      ccAddresses: normalizeAddressList(row.ccAddresses),
      bccAddresses: normalizeAddressList(row.bccAddresses),
      account: account
        ? { email: account.email, displayName: account.displayName }
        : null,
    };
  },
});

/** PATCH /api/scheduled-emails/:id */
export const update = mutation({
  args: {
    id: v.id("scheduledEmails"),
    sendAt: v.optional(v.number()),
    subject: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    bodyText: v.optional(v.string()),
    to: v.optional(v.array(addressShape)),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing || existing.userId !== userId) {
      throw new Error("Scheduled email not found");
    }
    if (existing.status !== "SCHEDULED") {
      throw new Error("Can only update emails with SCHEDULED status");
    }

    const patch: Record<string, unknown> = {};
    if (args.subject !== undefined) patch.subject = args.subject;
    if (args.bodyHtml !== undefined) patch.bodyHtml = args.bodyHtml;
    if (args.bodyText !== undefined) patch.bodyText = args.bodyText;
    if (args.to !== undefined) patch.toAddresses = args.to;

    if (args.sendAt !== undefined) {
      if (args.sendAt <= Date.now()) {
        throw new Error("sendAt must be in the future");
      }
      patch.sendAt = args.sendAt;
      // Cancel old scheduler job if we tracked one, then schedule new.
      if (existing.jobId) {
        try {
          await ctx.scheduler.cancel(
            existing.jobId as unknown as never,
          );
        } catch {
          /* job may have already run / been cancelled — no-op */
        }
      }
      const newJobId = await ctx.scheduler.runAt(
        args.sendAt,
        internal.scheduledEmails.dispatchOne,
        { scheduledEmailId: args.id },
      );
      patch.jobId = newJobId as unknown as string;
    }

    await ctx.db.patch(args.id, patch);
    return await ctx.db.get(args.id);
  },
});

/** DELETE /api/scheduled-emails/:id */
export const cancel = mutation({
  args: { id: v.id("scheduledEmails") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db.get(id);
    if (!existing || existing.userId !== userId) {
      throw new Error("Scheduled email not found");
    }
    if (existing.status !== "SCHEDULED") {
      throw new Error("Can only cancel emails with SCHEDULED status");
    }
    if (existing.jobId) {
      try {
        await ctx.scheduler.cancel(existing.jobId as unknown as never);
      } catch {
        /* ok */
      }
    }
    await ctx.db.patch(id, {
      status: "CANCELLED",
      cancelledAt: Date.now(),
    });
    return await ctx.db.get(id);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal: dispatchers (called by scheduler.runAt or cron)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch a single scheduled email row. Marks SENDING and hands off to
 * Agent B's `internal.emails.actuallySend`. Skips cancelled / non-scheduled
 * rows so re-runs are safe.
 */
export const dispatchOne = internalMutation({
  args: { scheduledEmailId: v.id("scheduledEmails") },
  handler: async (ctx, { scheduledEmailId }) => {
    const row = await ctx.db.get(scheduledEmailId);
    if (!row) return;
    if (row.status !== "SCHEDULED") return;

    await ctx.db.patch(scheduledEmailId, { status: "SENDING" });

    // Cross-agent: Agent B owns convex/emails.ts. Expected name:
    // `internal.emails.actuallySend`. If Agent B uses a different name,
    // this reference will fail to type-check and we'll switch to fallback.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = (internal as any).emails?.actuallySend
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ?? (internal as any).emails?.send;

    if (!target) {
      // Agent B not yet committed — leave row in SENDING; cron will retry.
      return;
    }

    await ctx.scheduler.runAfter(0, target, {
      scheduledEmailId,
      accountId: row.accountId,
      threadId: row.threadId ?? null,
      parentEmailId: row.parentEmailId ?? null,
      mode: row.mode,
      toAddresses: row.toAddresses,
      ccAddresses: row.ccAddresses ?? null,
      bccAddresses: row.bccAddresses ?? null,
      subject: row.subject,
      bodyHtml: row.bodyHtml,
      bodyText: row.bodyText,
    });
  },
});

/**
 * Cron-driven safety net. Picks up any SCHEDULED rows whose sendAt has
 * already passed (e.g., scheduler missed them) and dispatches them.
 * Phase 4 will register this on a 1-minute cron.
 */
export const processDueScheduledEmails = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("scheduledEmails")
      .withIndex("by_status_sendAt", (q) =>
        q.eq("status", "SCHEDULED").lte("sendAt", now),
      )
      .take(100);

    let dispatched = 0;
    for (const row of due) {
      await ctx.db.patch(row._id, { status: "SENDING" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const target = (internal as any).emails?.actuallySend
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ?? (internal as any).emails?.send;
      if (!target) continue;
      await ctx.scheduler.runAfter(0, target, {
        scheduledEmailId: row._id,
        accountId: row.accountId,
        threadId: row.threadId ?? null,
        parentEmailId: row.parentEmailId ?? null,
        mode: row.mode,
        toAddresses: row.toAddresses,
        ccAddresses: row.ccAddresses ?? null,
        bccAddresses: row.bccAddresses ?? null,
        subject: row.subject,
        bodyHtml: row.bodyHtml,
        bodyText: row.bodyText,
      });
      dispatched += 1;
    }
    return { dispatched };
  },
});
