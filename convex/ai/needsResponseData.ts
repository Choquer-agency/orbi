// V8-runtime helpers for the needsResponse scorer (which lives in
// `ai/needsResponse.ts` and runs under "use node"). Convex disallows DB
// access inside node-runtime files, so all the reads/writes the scorer
// needs live live here.

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";

// Defaults for v2 settings; matched in convex/needsResponse.ts getSettings.
const DEFAULT_RETENTION_DAYS = 45;
const DEFAULT_CONFIDENCE_FLOOR = 50;

// toAddresses / ccAddresses / bccAddresses are typed `v.any()` because they
// can be either `string[]` or `{name, address}[]` depending on the provider
// (Gmail vs Microsoft). Normalize to a lowercased Set of bare addresses.
function normalizeAddresses(value: unknown): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  const arr = Array.isArray(value) ? value : [value];
  for (const item of arr) {
    if (!item) continue;
    if (typeof item === "string") {
      // Could be "John <john@x.com>" or "john@x.com" or a JSON-stringified
      // structured value. Pull out anything that looks like an email.
      const match = item.match(/[\w.+-]+@[\w.-]+\.\w+/);
      if (match) out.add(match[0].toLowerCase().trim());
      continue;
    }
    if (typeof item === "object") {
      const obj = item as { address?: unknown; email?: unknown };
      const addr =
        typeof obj.address === "string"
          ? obj.address
          : typeof obj.email === "string"
            ? obj.email
            : null;
      if (addr) out.add(addr.toLowerCase().trim());
    }
  }
  return out;
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase().trim();
}

export const _loadForScoring = internalQuery({
  args: { emailId: v.id("emails"), userId: v.id("users") },
  handler: async (ctx, { emailId, userId }) => {
    const email = await ctx.db.get(emailId);
    if (!email) {
      return null;
    }
    // Is this an outbound (user-sent) email? Walk user accounts and build
    // both the self-email set and the team-internal domain set in one pass.
    const accts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const selfEmails = new Set<string>();
    const teamDomains = new Set<string>();
    for (const a of accts) {
      const primary = a.email.toLowerCase().trim();
      selfEmails.add(primary);
      const primaryDomain = domainOf(primary);
      if (primaryDomain) teamDomains.add(primaryDomain);
      for (const al of a.aliases ?? []) {
        const lower = al.toLowerCase().trim();
        selfEmails.add(lower);
        const aliasDomain = domainOf(lower);
        if (aliasDomain) teamDomains.add(aliasDomain);
      }
    }
    const fromAddress = email.fromAddress.toLowerCase().trim();
    const isUserOutbound = selfEmails.has(fromAddress);

    // Addressee detection: does the user own any address in To vs CC/BCC?
    const toSet = normalizeAddresses(email.toAddresses);
    const ccSet = normalizeAddresses(email.ccAddresses);
    const bccSet = normalizeAddresses(email.bccAddresses);
    const userIsDirectAddressee = [...selfEmails].some((s) => toSet.has(s));
    const userInCcOrBcc = [...selfEmails].some(
      (s) => ccSet.has(s) || bccSet.has(s),
    );
    const userIsCcd = userInCcOrBcc && !userIsDirectAddressee;

    // Team-internal sender: the sender's domain matches one of the user's
    // connected-account domains. Skip if the address is one of the user's
    // own (that's outbound, already handled).
    const fromDomain = domainOf(fromAddress);
    const senderIsTeamInternal =
      !isUserOutbound && !!fromDomain && teamDomains.has(fromDomain);

    const classification = await ctx.db
      .query("emailClassifications")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();

    // "Open signal" = a row for this email with dismissedAt undefined.
    const signal = await ctx.db
      .query("needsResponseSignals")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    const hasOpenSignal = !!(signal && signal.dismissedAt === undefined);

    // Pull the last 3 messages BEFORE this one in the same thread so the
    // scorer can see context. Compute thread-activity stats in the same
    // pass: how many times the user has replied, when they last replied,
    // and how many THEM messages came after their latest reply (signals an
    // ongoing back-and-forth).
    const threadEmails = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", email.threadId))
      .order("desc")
      .take(8);
    const priorMessages: Array<{
      fromUser: boolean;
      snippet: string;
      receivedAt: number;
    }> = [];
    let userAlreadyRepliedInThread = false;
    let userReplyCount = 0;
    let lastUserReplyAt: number | null = null;
    let themMessagesAfterUserReply = 0;
    for (const e of threadEmails) {
      if (e._id === email._id) continue;
      if (e.receivedAt >= email.receivedAt) continue;
      const fromUser = selfEmails.has(e.fromAddress.toLowerCase().trim());
      if (fromUser) {
        userAlreadyRepliedInThread = true;
        userReplyCount++;
        if (lastUserReplyAt === null || e.receivedAt > lastUserReplyAt) {
          lastUserReplyAt = e.receivedAt;
        }
      }
      if (priorMessages.length < 3) {
        priorMessages.push({
          fromUser,
          snippet: (e.snippet ?? e.bodyText ?? "").slice(0, 200),
          receivedAt: e.receivedAt,
        });
      }
    }
    if (lastUserReplyAt !== null) {
      for (const e of threadEmails) {
        if (e._id === email._id) continue;
        if (e.receivedAt <= lastUserReplyAt) continue;
        if (e.receivedAt > email.receivedAt) continue;
        const fromUser = selfEmails.has(e.fromAddress.toLowerCase().trim());
        if (!fromUser) themMessagesAfterUserReply++;
      }
    }
    // Chronological order — oldest first — makes the prompt easier to read.
    priorMessages.reverse();

    // Per-user settings (retention + confidence floor). The scorer enforces
    // the retention window before calling the AI, and uses the confidence
    // floor as the persistence cutoff.
    const settings = await ctx.db
      .query("needsResponseSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const retentionDays = settings?.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const confidenceFloor = settings?.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;

    // Implicit calibration: up to 5 most-recent dismissals from this sender,
    // weighted toward "manual-done" rows (the strongest signal that this
    // sender's emails don't warrant flagging). Used in the prompt.
    const senderFeedback = await ctx.db
      .query("needsResponseFeedback")
      .withIndex("by_user_sender", (q) =>
        q.eq("userId", userId).eq("senderAddress", fromAddress),
      )
      .order("desc")
      .take(10);
    const sortedFeedback = senderFeedback
      .slice()
      .sort((a, b) => {
        const aw = a.kind === "manual-done" ? 0 : 1;
        const bw = b.kind === "manual-done" ? 0 : 1;
        if (aw !== bw) return aw - bw;
        return b._creationTime - a._creationTime;
      })
      .slice(0, 5);
    const now = Date.now();
    const recentFeedback = sortedFeedback.map((f) => ({
      kind: f.kind,
      scoreAtDismissal: f.scoreAtDismissal,
      daysAgo: Math.max(0, Math.floor((now - f._creationTime) / 86_400_000)),
    }));

    return {
      email: {
        _id: email._id,
        threadId: email.threadId,
        fromAddress: email.fromAddress,
        fromName: email.fromName,
        subject: email.subject,
        bodyText: email.bodyText,
        snippet: email.snippet,
        receivedAt: email.receivedAt,
      },
      category: classification?.category ?? null,
      hasOpenSignal,
      isUserOutbound,
      priorMessages,
      userAlreadyRepliedInThread,
      // v2 additions:
      userIsDirectAddressee,
      userIsCcd,
      senderIsTeamInternal,
      threadActivity: {
        userReplyCount,
        lastUserReplyAt,
        themMessagesAfterUserReply,
      },
      recentFeedback,
      retentionDays,
      confidenceFloor,
    };
  },
});

export const _persistSignal = internalMutation({
  args: {
    userId: v.id("users"),
    emailId: v.id("emails"),
    threadId: v.id("threads"),
    score: v.number(),
    reason: v.optional(v.string()),
    dueByHint: v.optional(v.number()),
    // v2 additions
    displayScore: v.optional(v.number()),
    userIsDirectAddressee: v.optional(v.boolean()),
    userIsCcd: v.optional(v.boolean()),
    senderIsTeamInternal: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Race-protection: if a row already exists for this email, patch instead
    // of inserting a duplicate. Open signal stays open.
    const existing = await ctx.db
      .query("needsResponseSignals")
      .withIndex("by_email", (q) => q.eq("emailId", args.emailId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        score: args.score,
        reason: args.reason,
        dueByHint: args.dueByHint,
        displayScore: args.displayScore,
        userIsDirectAddressee: args.userIsDirectAddressee,
        userIsCcd: args.userIsCcd,
        senderIsTeamInternal: args.senderIsTeamInternal,
        computedAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("needsResponseSignals", {
      userId: args.userId,
      emailId: args.emailId,
      threadId: args.threadId,
      score: args.score,
      reason: args.reason,
      dueByHint: args.dueByHint,
      displayScore: args.displayScore,
      userIsDirectAddressee: args.userIsDirectAddressee,
      userIsCcd: args.userIsCcd,
      senderIsTeamInternal: args.senderIsTeamInternal,
      computedAt: Date.now(),
    });
  },
});

// Internal helper for the rescore path: clear the open signal so the scorer
// inserts a fresh one. Closed (dismissed) signals stay intact for history.
export const _clearOpenSignalForEmail = internalMutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const sig = await ctx.db
      .query("needsResponseSignals")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    if (sig && sig.dismissedAt === undefined) {
      await ctx.db.delete(sig._id);
    }
  },
});

// Mark every open signal on a thread as dismissed. Called by auto-dismiss
// hooks (user replies / archives / trashes) and the manual "Done" button.
// `kind` records WHY the signal was dismissed so the scorer can use it as
// implicit calibration feedback on future scoring decisions.
export const _dismissOpenSignalsForThread = internalMutation({
  args: {
    threadId: v.id("threads"),
    kind: v.optional(
      v.union(
        v.literal("replied"),
        v.literal("archived"),
        v.literal("manual-done"),
        v.literal("auto-other-acc"),
      ),
    ),
  },
  handler: async (ctx, { threadId, kind }) => {
    const rows = await ctx.db
      .query("needsResponseSignals")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    const now = Date.now();
    let count = 0;
    for (const r of rows) {
      if (r.dismissedAt !== undefined) continue;
      await ctx.db.patch(r._id, { dismissedAt: now });
      count++;
      if (!kind) continue;
      // Capture an implicit-feedback row so the scorer can learn from the
      // dismissal pattern (e.g. user keeps Done-ing emails from this
      // sender → bias their future scores down).
      const email = await ctx.db.get(r.emailId);
      if (!email) continue;
      const senderAddress = email.fromAddress.toLowerCase().trim();
      const at = senderAddress.lastIndexOf("@");
      const senderDomain =
        at >= 0 && at < senderAddress.length - 1
          ? senderAddress.slice(at + 1)
          : "";
      const classification = await ctx.db
        .query("emailClassifications")
        .withIndex("by_email", (q) => q.eq("emailId", r.emailId))
        .unique();
      await ctx.db.insert("needsResponseFeedback", {
        userId: r.userId,
        threadId: r.threadId,
        emailId: r.emailId,
        senderAddress,
        senderDomain,
        category: classification?.category ?? undefined,
        scoreAtDismissal: r.score,
        reasonAtDismissal: r.reason,
        kind,
        timeOnList: Math.max(0, now - r.computedAt),
      });
    }
    return { dismissed: count };
  },
});
