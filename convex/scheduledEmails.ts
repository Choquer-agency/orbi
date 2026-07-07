import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import { materializeScheduledEmail } from "./emails";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

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

const attachmentUpload = v.object({
  filename: v.string(),
  mimeType: v.string(),
  size: v.number(),
  storageId: v.id("_storage"),
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
    attachments: v.optional(v.array(attachmentUpload)),
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
      attachments: args.attachments,
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
    // Free the stored attachment bytes — nothing else references them once
    // the scheduled send is cancelled.
    for (const att of existing.attachments ?? []) {
      try {
        await ctx.storage.delete(att.storageId);
      } catch {
        /* already gone — fine */
      }
    }
    await ctx.db.patch(id, {
      status: "CANCELLED",
      cancelledAt: Date.now(),
      attachments: undefined,
    });
    return await ctx.db.get(id);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal: dispatchers (called by scheduler.runAt or cron)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn one due scheduledEmails row into a real outbound email and hand it to
 * `internal.emails.actuallySend({ emailId, scheduledEmailId })`. The
 * SCHEDULED→SENDING patch is transactional with the materialization, so the
 * per-row scheduler job and the cron safety net can never double-dispatch.
 * Validation failures (account deleted, no recipients) mark the row FAILED
 * with a reason the UI can show, instead of wedging it in SENDING.
 *
 * History note: the previous version scheduled `actuallySend` with a payload
 * of recipient fields, but actuallySend takes `{ emailId }` — argument
 * validation failed on every dispatch and the row stayed SENDING forever, so
 * no scheduled email ever sent. An `(internal as any)` cast had defeated the
 * type check that would have caught it.
 */
async function dispatchRow(
  ctx: MutationCtx,
  row: Doc<"scheduledEmails">,
): Promise<boolean> {
  if (row.status !== "SCHEDULED") return false;
  try {
    const emailId = await materializeScheduledEmail(ctx, row);
    await ctx.db.patch(row._id, {
      status: "SENDING",
      sentEmailId: String(emailId),
    });
    await ctx.scheduler.runAfter(0, internal.emails.actuallySend, {
      emailId,
      scheduledEmailId: row._id,
    });
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await ctx.db.patch(row._id, { status: "FAILED", failureReason: reason });
    return false;
  }
}

export const dispatchOne = internalMutation({
  args: { scheduledEmailId: v.id("scheduledEmails") },
  handler: async (ctx, { scheduledEmailId }) => {
    const row = await ctx.db.get(scheduledEmailId);
    if (!row) return;
    await dispatchRow(ctx, row);
  },
});

/**
 * Cron-driven safety net (1-min): picks up SCHEDULED rows whose sendAt has
 * passed but whose per-row scheduler job was lost.
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
      if (await dispatchRow(ctx, row)) dispatched += 1;
    }
    return { dispatched };
  },
});

/**
 * "Send now" on a scheduled email: optionally saves the latest edits, then
 * dispatches immediately through the same transactional path. The original
 * scheduler job no-ops later because the row is no longer SCHEDULED.
 */
export const sendScheduledNow = mutation({
  args: {
    id: v.id("scheduledEmails"),
    subject: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    bodyText: v.optional(v.string()),
    to: v.optional(v.array(addressShape)),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== userId) {
      throw new Error("Scheduled email not found");
    }
    if (row.status !== "SCHEDULED") {
      throw new Error("Can only send emails with SCHEDULED status");
    }
    const patch: Record<string, unknown> = {};
    if (args.subject !== undefined) patch.subject = args.subject;
    if (args.bodyHtml !== undefined) patch.bodyHtml = args.bodyHtml;
    if (args.bodyText !== undefined) patch.bodyText = args.bodyText;
    if (args.to !== undefined && args.to.length > 0) patch.toAddresses = args.to;
    if (Object.keys(patch).length > 0) await ctx.db.patch(args.id, patch);

    const fresh = (await ctx.db.get(args.id)) as Doc<"scheduledEmails">;
    const ok = await dispatchRow(ctx, fresh);
    if (!ok) {
      const after = await ctx.db.get(args.id);
      throw new Error(after?.failureReason ?? "Send failed");
    }
    const after = await ctx.db.get(args.id);
    return {
      data: {
        id: args.id,
        emailId: after?.sentEmailId ?? null,
        threadId: row.threadId ?? null,
      },
    };
  },
});
