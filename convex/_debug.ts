import { internalQuery, internalMutation, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Quick read of recent send activity for debugging.
export const recentSends = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("emails")
      .order("desc")
      .take(40);
    return rows
      .filter((r) => r.sendStatus === "FAILED" || r.sendStatus === "PENDING_SEND" || r.sendStatus === "SENDING")
      .map((r) => ({
        id: r._id,
        subject: r.subject,
        sendStatus: r.sendStatus,
        sendError: r.sendError,
        sendAttempts: r.sendAttempts,
        undoDeadlineAt: r.undoDeadlineAt,
        inReplyTo: r.inReplyTo,
        threadId: r.threadId,
        createdAt: r._creationTime,
      }));
  },
});

export const showThread = internalQuery({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const t = await ctx.db.get(threadId);
    if (!t) return null;
    const emails = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", threadId))
      .collect();
    return {
      thread: {
        id: t._id,
        providerThreadId: t.providerThreadId,
        subject: t.subject,
      },
      emails: emails.map((e) => ({
        id: e._id,
        providerMessageId: e.providerMessageId,
        internetMessageId: e.internetMessageId,
        inReplyTo: e.inReplyTo,
        references: e.references,
        sendStatus: e.sendStatus,
        isDraft: e.isDraft,
        subject: e.subject,
        fromAddress: e.fromAddress,
      })),
    };
  },
});

// Heal Gmail threads that got split into ::0/::1 sub-threads. Merges all
// emails for the same base providerThreadId into one thread row (the one
// with the earliest lastMessageAt).
export const healSplitThreads = action({
  args: {
    accountId: v.id("mailAccounts"),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { accountId, dryRun, batchSize },
  ): Promise<{
    totalMerged: number;
    totalDeleted: number;
    batches: number;
  }> => {
    let totalMerged = 0;
    let totalDeleted = 0;
    let batches = 0;
    const cap = batchSize ?? 30;
    while (true) {
      const r: any = await ctx.runMutation(
        internal._debug._healSplitThreadsImpl,
        { accountId, dryRun: dryRun ?? false, maxMerges: cap },
      );
      batches++;
      totalMerged += r.merged;
      totalDeleted += r.deleted;
      if (r.merged < cap) break;
      if (batches > 200) break;
    }
    return { totalMerged, totalDeleted, batches };
  },
});

export const _healSplitThreadsImpl = internalMutation({
  args: {
    accountId: v.id("mailAccounts"),
    dryRun: v.boolean(),
    maxMerges: v.optional(v.number()),
  },
  handler: async (ctx, { accountId, dryRun, maxMerges }) => {
    const cap = maxMerges ?? 50;
    // First pass: collect only sub-threaded rows (providerThreadId containing
    // "::"). These are <5% of total — keeps the read budget small.
    let inspected = 0;
    const it = ctx.db
      .query("threads")
      .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", accountId));
    type ThreadRow = Awaited<ReturnType<typeof ctx.db.get<"threads">>>;
    const splitThreads: NonNullable<ThreadRow>[] = [];
    for await (const t of it) {
      inspected++;
      if (t.providerThreadId && t.providerThreadId.includes("::")) {
        splitThreads.push(t);
        if (splitThreads.length >= cap * 6) break; // enough to fill a batch
      }
    }
    const groups = new Map<string, NonNullable<ThreadRow>[]>();
    for (const t of splitThreads) {
      const base = t.providerThreadId!.split("::")[0];
      const arr = groups.get(base) ?? [];
      arr.push(t);
      groups.set(base, arr);
    }
    // For each base, look up the plain (no-suffix) thread by index.
    for (const base of Array.from(groups.keys())) {
      const plain = await ctx.db
        .query("threads")
        .withIndex("by_account_providerThreadId", (q) =>
          q.eq("accountId", accountId).eq("providerThreadId", base),
        )
        .unique();
      if (plain) groups.get(base)!.push(plain);
    }

    let merged = 0;
    let deleted = 0;
    const plan: Array<{
      base: string;
      keep: string;
      drop: string[];
      emailMoves: number;
    }> = [];

    for (const [base, grp] of groups) {
      if (merged >= cap) break;
      if (grp.length < 2) continue;
      // Keep the thread with the most messages (or earliest creation time)
      grp.sort((a, b) => {
        const ac = a.messageCount ?? 0;
        const bc = b.messageCount ?? 0;
        if (ac !== bc) return bc - ac;
        return a._creationTime - b._creationTime;
      });
      const keep = grp[0];
      const drops = grp.slice(1);
      let moves = 0;
      for (const drop of drops) {
        const emails = await ctx.db
          .query("emails")
          .withIndex("by_thread_receivedAt", (q) =>
            q.eq("threadId", drop._id),
          )
          .collect();
        moves += emails.length;
        if (!dryRun) {
          for (const e of emails) {
            await ctx.db.patch(e._id, { threadId: keep._id });
          }
          await ctx.db.delete(drop._id);
        }
        deleted++;
      }
      if (!dryRun) {
        // Normalize keep's providerThreadId to the plain base id and bump
        // messageCount/lastMessageAt to reflect merged contents.
        const allEmails = await ctx.db
          .query("emails")
          .withIndex("by_thread_receivedAt", (q) =>
            q.eq("threadId", keep._id),
          )
          .collect();
        const lastMessageAt = Math.max(
          ...allEmails.map((e) => e.receivedAt ?? e._creationTime),
          keep.lastMessageAt ?? 0,
        );
        await ctx.db.patch(keep._id, {
          providerThreadId: base,
          messageCount: allEmails.length,
          lastMessageAt,
        });
      }
      merged++;
      plan.push({
        base,
        keep: keep._id,
        drop: drops.map((d) => d._id),
        emailMoves: moves,
      });
    }

    return {
      merged,
      deleted,
      inspected,
      plan: plan.slice(0, 30),
    };
  },
});

// Heaviest single emailBodies rows in the DB (sample). Useful for sizing.
export const heaviestBodies = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const sample = await ctx.db.query("emailBodies").order("desc").take(200);
    const out = sample.map((b) => ({
      emailId: b.emailId,
      bodyHtml: b.bodyHtml?.length ?? 0,
      bodyHtmlClean: b.bodyHtmlClean?.length ?? 0,
      bodyHtmlTrimmed: b.bodyHtmlTrimmed?.length ?? 0,
    }));
    return out
      .sort((a, b) => b.bodyHtml - a.bodyHtml)
      .slice(0, limit ?? 10);
  },
});

// Find threads with the largest cumulative body byte-size — these are the
// ones likely to time out in `threads.get` and leave the viewer stuck.
export const heaviestThreads = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = limit ?? 12;
    const threads = await ctx.db.query("threads").order("desc").take(800);
    const out: Array<{
      threadId: string;
      subject?: string;
      messageCount?: number;
      totalBytes: number;
      maxBytes: number;
    }> = [];
    for (const t of threads) {
      const emails = await ctx.db
        .query("emails")
        .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", t._id))
        .collect();
      let total = 0;
      let max = 0;
      for (const e of emails) {
        const body = await ctx.db
          .query("emailBodies")
          .withIndex("by_email", (q) => q.eq("emailId", e._id))
          .unique();
        const size =
          (body?.bodyHtml?.length ?? e.bodyHtml?.length ?? 0) +
          (body?.bodyHtmlClean?.length ?? e.bodyHtmlClean?.length ?? 0) +
          (body?.bodyHtmlTrimmed?.length ?? e.bodyHtmlTrimmed?.length ?? 0);
        total += size;
        if (size > max) max = size;
      }
      out.push({
        threadId: t._id,
        subject: t.subject,
        messageCount: t.messageCount,
        totalBytes: total,
        maxBytes: max,
      });
    }
    return out
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .slice(0, cap);
  },
});

// Read body fields directly for a single id.
export const showBody = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const e = await ctx.db.get(emailId);
    if (!e) return null;
    const body = await ctx.db
      .query("emailBodies")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    return {
      subject: e.subject,
      from: e.fromAddress,
      bodyHtmlLen: (body?.bodyHtml ?? e.bodyHtml ?? "").length,
      bodyTextLen: (body?.bodyText ?? e.bodyText ?? "").length,
      bodyHtmlCleanLen: (body?.bodyHtmlClean ?? e.bodyHtmlClean ?? "").length,
      bodyHtmlTrimmedLen: (body?.bodyHtmlTrimmed ?? e.bodyHtmlTrimmed ?? "").length,
      hasQuotedHistory: body?.hasQuotedHistory ?? e.hasQuotedHistory,
      isForwarded: body?.isForwarded ?? e.isForwarded,
      cleanIsEmptyString: (body?.bodyHtmlClean === "") || (e.bodyHtmlClean === ""),
      cleanIsUndefined: body?.bodyHtmlClean === undefined && e.bodyHtmlClean === undefined,
    };
  },
});

// Dump first 8 KB of bodyHtml for the most-recent email matching a from/subject.
// Use to debug iframe height collapses.
export const peekRecentByFrom = internalQuery({
  args: { fromContains: v.string(), max: v.optional(v.number()) },
  handler: async (ctx, { fromContains, max }) => {
    const all = await ctx.db.query("emails").order("desc").take(400);
    const matched = all.filter(
      (e) => (e.fromAddress || "").toLowerCase().includes(fromContains.toLowerCase()) ||
             (e.fromName || "").toLowerCase().includes(fromContains.toLowerCase()) ||
             (e.subject || "").toLowerCase().includes(fromContains.toLowerCase()),
    ).slice(0, max ?? 3);
    const out = [];
    for (const e of matched) {
      const body = await ctx.db
        .query("emailBodies")
        .withIndex("by_email", (q) => q.eq("emailId", e._id))
        .unique();
      out.push({
        id: e._id,
        from: e.fromAddress,
        subject: e.subject,
        receivedAt: e.receivedAt,
        bodyHtmlPreview: (body?.bodyHtml ?? e.bodyHtml ?? "").slice(0, 8000),
        bodyHtmlCleanPreview: (body?.bodyHtmlClean ?? e.bodyHtmlClean ?? "").slice(0, 8000),
        bodyHtmlTrimmedPreview: (body?.bodyHtmlTrimmed ?? e.bodyHtmlTrimmed ?? "").slice(0, 8000),
        len: (body?.bodyHtml ?? e.bodyHtml ?? "").length,
      });
    }
    return out;
  },
});

export const listAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accs = await ctx.db.query("mailAccounts").take(20);
    return accs.map((a) => ({
      id: a._id,
      email: a.email,
      provider: a.provider,
    }));
  },
});

export const setSendingStatus = internalMutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    await ctx.db.patch(emailId, {
      sendStatus: "SENDING",
      sendError: undefined,
    });
    return { ok: true };
  },
});

// Run actuallySend synchronously for debugging.
export const debugRunSend = action({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }): Promise<{ ok: boolean }> => {
    try {
      await ctx.runMutation(internal._debug.setSendingStatus, { emailId });
      await ctx.runAction(internal.emails.actuallySend, { emailId });
      return { ok: true };
    } catch (e: any) {
      console.error("debugRunSend error", e?.message, e?.stack);
      throw e;
    }
  },
});

// Force-fail a stuck send row so retrySend can be triggered.
export const forceFailStuck = internalMutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    await ctx.db.patch(emailId, {
      sendStatus: "FAILED",
      sendError: "Recovered from stuck SENDING/PENDING state",
    });
    return { ok: true };
  },
});
