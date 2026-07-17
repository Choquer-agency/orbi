// ─────────────────────────────────────────────────────────────────────────────
// commitments.ts — Team Hub commitment tracker (V8 queries/mutations).
//
// A commitment is either a client's request that landed in a tracked mailbox
// (INBOUND) or a promise we made to a client (OUTBOUND). Rows are extracted
// by the opt-in AI detector in ai/commitments.ts and are NEVER deleted —
// completing or dismissing only stamps status + who/when, so the log is a
// permanent audit trail.
//
// Gating: every public endpoint calls requireTeamHub. Visibility follows the
// same org tree as mailbox viewing: owner sees the whole workspace, a
// manager sees their subtree + self, everyone sees their own.
//
// Cost notes (subscribed queries):
//   - `dashboard` reads exactly one page of commitment rows via an index
//     (by_user_status fan-out over visible members, or by_workspace_status),
//     plus one thread doc per visible row for subject display. It re-runs
//     when a commitment row changes — commitment writes are rare (a few per
//     day per tracked mailbox), NOT per mailbox write.
//   - `listForThread` reads only that thread's rows (by_thread_status).
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import {
  query,
  mutation,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import {
  requireTeamHub,
  listViewableMembers,
  canViewUserMailbox,
} from "./lib/workspace";
import { canAccessThread } from "./lib/threadAccessCheck";
import type { Doc, Id } from "./_generated/dataModel";

const statusArg = v.union(
  v.literal("OPEN"),
  v.literal("COMPLETED"),
  v.literal("DISMISSED"),
);

function forClient(c: Doc<"commitments">) {
  return {
    id: c._id,
    userId: c.userId,
    accountId: c.accountId,
    threadId: c.threadId,
    sourceEmailId: c.sourceEmailId,
    direction: c.direction,
    description: c.description,
    counterpartyEmail: c.counterpartyEmail,
    counterpartyName: c.counterpartyName ?? null,
    requestedAt: c.requestedAt,
    dueAtHint: c.dueAtHint ?? null,
    status: c.status,
    completedAt: c.completedAt ?? null,
    completionNote: c.completionNote ?? null,
    dismissedAt: c.dismissedAt ?? null,
    isStuck: c.isStuck === true,
    snoozedUntil: c.snoozedUntil ?? null,
    createdAt: c._creationTime,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export const dashboard = query({
  args: {
    status: statusArg,
    // Narrow to one member's mailboxes; omitted = every member the viewer
    // may see (self included).
    memberUserId: v.optional(v.id("users")),
    page: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);

    const pageNum = Math.max(args.page ?? 1, 1);
    const limitNum = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const skip = (pageNum - 1) * limitNum;

    // Resolve whose commitments the viewer may see.
    let memberIds: Id<"users">[];
    if (args.memberUserId) {
      if (!(await canViewUserMailbox(ctx, userId, args.memberUserId))) {
        throw new Error("Access denied");
      }
      memberIds = [args.memberUserId];
    } else {
      const viewable = await listViewableMembers(ctx, userId);
      memberIds = [userId, ...viewable.map((m) => m._id)];
    }

    // Per-member indexed reads, newest first, page-bounded (+1 for hasMore).
    const per = skip + limitNum + 1;
    const arrays = await Promise.all(
      memberIds.map((mid) =>
        ctx.db
          .query("commitments")
          .withIndex("by_user_status", (q) =>
            q.eq("userId", mid).eq("status", args.status),
          )
          .order("desc")
          .take(per),
      ),
    );
    const merged = arrays
      .flat()
      .sort((a, b) => sortKey(b) - sortKey(a));
    const total = merged.length;
    const pageRows = merged.slice(skip, skip + limitNum);

    // Hydrate display info: thread subject + member name (one get per row,
    // page-bounded).
    const memberCache = new Map<string, { name: string | null; email: string | null }>();
    const data = await Promise.all(
      pageRows.map(async (c) => {
        const thread = await ctx.db.get(c.threadId);
        let member = memberCache.get(String(c.userId));
        if (!member) {
          const u = (await ctx.db.get(c.userId)) as Doc<"users"> | null;
          member = {
            name: u?.displayName ?? u?.name ?? null,
            email: u?.email ?? null,
          };
          memberCache.set(String(c.userId), member);
        }
        return {
          ...forClient(c),
          threadSubject: thread?.subject ?? "(thread unavailable)",
          memberName: member.name,
          memberEmail: member.email,
        };
      }),
    );

    return {
      data,
      total,
      page: pageNum,
      limit: limitNum,
      hasMore: skip + limitNum < total,
    };
  },
});

// Open items sort by due date first (soonest at top), then newest; closed
// items by completion/dismissal time.
function sortKey(c: Doc<"commitments">): number {
  if (c.status === "OPEN") {
    return c.dueAtHint !== undefined
      ? Number.MAX_SAFE_INTEGER - c.dueAtHint
      : c.requestedAt;
  }
  return c.completedAt ?? c.dismissedAt ?? c.requestedAt;
}

// Small always-cheap badge: open counts per visible member.
export const openCounts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    const viewable = await listViewableMembers(ctx, userId);
    const memberIds = [userId, ...viewable.map((m) => m._id)];
    const MAX_PER_MEMBER = 100;
    const counts = await Promise.all(
      memberIds.map(async (mid) => {
        const rows = await ctx.db
          .query("commitments")
          .withIndex("by_user_status", (q) =>
            q.eq("userId", mid).eq("status", "OPEN"),
          )
          .take(MAX_PER_MEMBER);
        return { userId: mid, open: rows.length };
      }),
    );
    return {
      totalOpen: counts.reduce((s, c) => s + c.open, 0),
      byMember: counts,
    };
  },
});

// Commitments attached to one thread (shown in the viewer side panel).
export const listForThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    const thread = await ctx.db.get(threadId);
    if (!thread || !(await canAccessThread(ctx, userId, thread))) {
      throw new Error("Access denied");
    }
    const rows = await ctx.db
      .query("commitments")
      .withIndex("by_thread_status", (q) => q.eq("threadId", threadId))
      .collect();
    return rows.map(forClient);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Manual status changes — logged, never deleted.
// ─────────────────────────────────────────────────────────────────────────────

async function loadForStatusChange(
  ctx: { db: any },
  userId: Id<"users">,
  commitmentId: Id<"commitments">,
): Promise<Doc<"commitments">> {
  const row = (await ctx.db.get(commitmentId)) as Doc<"commitments"> | null;
  if (!row) throw new Error("Commitment not found");
  if (!(await canViewUserMailbox(ctx, userId, row.userId))) {
    throw new Error("Access denied");
  }
  return row;
}

export const complete = mutation({
  args: { commitmentId: v.id("commitments"), note: v.optional(v.string()) },
  handler: async (ctx, { commitmentId, note }) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    const row = await loadForStatusChange(ctx, userId, commitmentId);
    if (row.status === "COMPLETED") return { ok: true };
    await ctx.db.patch(commitmentId, {
      status: "COMPLETED",
      completedAt: Date.now(),
      completedByUserId: userId,
      completionNote: note ?? "Marked done manually",
      dismissedAt: undefined,
      dismissedByUserId: undefined,
      isStuck: undefined,
      snoozedUntil: undefined,
    });
    return { ok: true };
  },
});

export const reopen = mutation({
  args: { commitmentId: v.id("commitments") },
  handler: async (ctx, { commitmentId }) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    const row = await loadForStatusChange(ctx, userId, commitmentId);
    if (row.status === "OPEN") return { ok: true };
    await ctx.db.patch(commitmentId, {
      status: "OPEN",
      completedAt: undefined,
      completedByEmailId: undefined,
      completedByUserId: undefined,
      completionNote: undefined,
      dismissedAt: undefined,
      dismissedByUserId: undefined,
    });
    return { ok: true };
  },
});

// Flag / unflag an item as stuck (blocked on something). Status unchanged.
export const setStuck = mutation({
  args: { commitmentId: v.id("commitments"), stuck: v.boolean() },
  handler: async (ctx, { commitmentId, stuck }) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    await loadForStatusChange(ctx, userId, commitmentId);
    await ctx.db.patch(commitmentId, { isStuck: stuck ? true : undefined });
    return { ok: true };
  },
});

// "Remind me later" — hides the row in the Snoozed section until the time
// passes. Pass no `until` to un-snooze.
export const snooze = mutation({
  args: { commitmentId: v.id("commitments"), until: v.optional(v.number()) },
  handler: async (ctx, { commitmentId, until }) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    await loadForStatusChange(ctx, userId, commitmentId);
    if (until !== undefined && (!Number.isFinite(until) || until <= Date.now())) {
      throw new Error("Remind-me time must be in the future");
    }
    await ctx.db.patch(commitmentId, { snoozedUntil: until });
    return { ok: true };
  },
});

// "This wasn't actually a request/promise" — kept in the log as DISMISSED.
export const dismiss = mutation({
  args: { commitmentId: v.id("commitments") },
  handler: async (ctx, { commitmentId }) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    const row = await loadForStatusChange(ctx, userId, commitmentId);
    if (row.status === "DISMISSED") return { ok: true };
    await ctx.db.patch(commitmentId, {
      status: "DISMISSED",
      dismissedAt: Date.now(),
      dismissedByUserId: userId,
    });
    return { ok: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal — used by the AI detector (ai/commitments.ts).
// ─────────────────────────────────────────────────────────────────────────────

// Everything the extractor needs in ONE query: email + body text + thread's
// account/workspace gating info + open commitments on the thread.
export const _loadForExtraction = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return null;
    const thread = await ctx.db.get(email.threadId);
    if (!thread) return null;
    // Gate on the THREAD's mailbox (where commitments live) — a manager
    // replying from their own account into a tracked report's thread still
    // counts against that tracked mailbox.
    const threadAccount = await ctx.db.get(thread.accountId);
    if (!threadAccount) return null;
    const owner = (await ctx.db.get(threadAccount.userId)) as Doc<"users"> | null;
    const workspace = owner?.workspaceId
      ? await ctx.db.get(owner.workspaceId)
      : null;

    // Junk gate: never extract from spam/promo/social/forum threads.
    const junkLabels = [
      "SPAM",
      "CATEGORY_PROMOTIONS",
      "CATEGORY_SOCIAL",
      "CATEGORY_FORUMS",
    ];
    const isJunk =
      thread.isSpam === true ||
      thread.isTrashed === true ||
      (thread.labels ?? []).some((l: string) => junkLabels.includes(l));

    // Existing extraction for this email = idempotency stop.
    const alreadyExtracted = await ctx.db
      .query("commitments")
      .withIndex("by_sourceEmail", (q) => q.eq("sourceEmailId", emailId))
      .first();

    // Determine outbound: sender is one of the thread owner's account
    // addresses, or the email row itself is labeled SENT (in-app sends).
    const ownerAccounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", threadAccount.userId))
      .collect();
    const ownEmails = new Set(
      ownerAccounts.map((a: Doc<"mailAccounts">) => a.email.toLowerCase()),
    );
    // A send from ANY workspace mailbox (e.g. the owner replying from
    // inside a report's inbox) counts as outbound for completion purposes.
    const senderAccount = await ctx.db.get(email.accountId);
    const senderIsWorkspaceMember =
      !!senderAccount &&
      !!(await (async () => {
        const su = (await ctx.db.get(senderAccount.userId)) as Doc<"users"> | null;
        return su?.workspaceId && owner?.workspaceId && su.workspaceId === owner.workspaceId;
      })());
    const isOutbound =
      ownEmails.has(email.fromAddress.toLowerCase()) ||
      ((email.labels ?? []).includes("SENT") && senderIsWorkspaceMember);

    // Body text: emailSearchText (lean, always populated once the body
    // fetch lands) → emailBodies text → legacy in-row → snippet.
    let bodyText = "";
    const searchRow = await ctx.db
      .query("emailSearchText")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    if (searchRow) {
      bodyText = searchRow.text.startsWith(email.subject)
        ? searchRow.text.slice(email.subject.length).trim()
        : searchRow.text;
    } else {
      const bodyRow = await ctx.db
        .query("emailBodies")
        .withIndex("by_email", (q) => q.eq("emailId", emailId))
        .first();
      bodyText = bodyRow?.bodyText || email.bodyText || email.snippet || "";
    }
    // Strip quoted reply history. Without this, every reply in a long thread
    // re-contains the whole conversation below it, and the detector re-logs
    // the same requests once per message (a single client thread produced
    // 100+ duplicate rows in the first backfill).
    bodyText = stripQuotedHistory(bodyText);

    const openRows = await ctx.db
      .query("commitments")
      .withIndex("by_thread_status", (q) =>
        q.eq("threadId", email.threadId).eq("status", "OPEN"),
      )
      .collect();
    // Everything ever tracked on this thread (open + completed + dismissed)
    // goes to the model as "already tracked — do not re-log". Uses the same
    // index, three point-range reads.
    const completedRows = await ctx.db
      .query("commitments")
      .withIndex("by_thread_status", (q) =>
        q.eq("threadId", email.threadId).eq("status", "COMPLETED"),
      )
      .collect();
    const dismissedRows = await ctx.db
      .query("commitments")
      .withIndex("by_thread_status", (q) =>
        q.eq("threadId", email.threadId).eq("status", "DISMISSED"),
      )
      .collect();

    return {
      email: {
        _id: email._id,
        threadId: email.threadId,
        fromAddress: email.fromAddress,
        fromName: email.fromName ?? null,
        toAddresses: email.toAddresses,
        subject: email.subject,
        receivedAt: email.receivedAt,
        sentAt: email.sentAt ?? null,
      },
      bodyText: bodyText.slice(0, 6000),
      isOutbound,
      isJunk,
      alreadyExtracted: !!alreadyExtracted,
      trackingEnabled: threadAccount.commitmentTrackingEnabled === true,
      accountId: threadAccount._id,
      mailboxOwnerUserId: threadAccount.userId,
      workspaceId: (workspace?._id ?? null) as Id<"workspaces"> | null,
      teamHubEnabled:
        !!workspace && (workspace.features ?? []).includes("team_hub"),
      commitmentsDailyCapUsd: workspace?.commitmentsDailyCapUsd ?? null,
      threadSubject: thread.subject,
      openCommitments: openRows.map((c: Doc<"commitments">) => ({
        id: c._id,
        direction: c.direction,
        description: c.description,
        counterpartyEmail: c.counterpartyEmail,
        requestedAt: c.requestedAt,
      })),
      alreadyTrackedDescriptions: [
        ...openRows,
        ...completedRows,
        ...dismissedRows,
      ].map((c: Doc<"commitments">) => c.description),
    };
  },
});

// Cut a plain-text email body down to the NEW content: drop quoted lines
// and everything below the first reply/forward marker.
function stripQuotedHistory(text: string): string {
  const markers = [
    /^On .{5,80} wrote:\s*$/i,
    /^-{2,}\s*Original Message\s*-{2,}/i,
    /^-{2,}\s*Forwarded message\s*-{2,}/i,
    /^From:\s.+$/i,
    /^Le .{5,80} a écrit\s*:/i,
    /^_{10,}\s*$/,
  ];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (markers.some((re) => re.test(trimmed))) break;
    if (trimmed.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// One-shot backfill — run from the CLI, never callable from clients:
//   npx convex run --prod commitments:backfillCommitments \
//     '{"accountEmails":["a@x.com","b@x.com"]}'
//
// Walks each account's emails from the last `sinceDays` (default 14) OLDEST
// FIRST — order matters: an inbound request must be logged before the later
// outbound reply that completes it. Emails are processed one at a time
// (serial, no parallel AI bursts) in self-rescheduling chunks. Spend is
// logged under feature "commitments_backfill" with its own hard budget
// (default $5) checked before every call — the live detector's daily cap is
// untouched. Read cost: one indexed range walk per account, page-sized.
// ─────────────────────────────────────────────────────────────────────────────

export const _accountsByEmails = internalQuery({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, { emails }) => {
    const wanted = emails.map((e) => e.toLowerCase().trim());
    const out: Array<{ id: Id<"mailAccounts">; email: string }> = [];
    for (const email of wanted) {
      for (const provider of ["GMAIL", "MICROSOFT", "APPLE_IMAP"] as const) {
        const acc = await ctx.db
          .query("mailAccounts")
          .withIndex("by_provider_email", (q) =>
            q.eq("provider", provider).eq("email", email),
          )
          .first();
        if (acc) {
          out.push({ id: acc._id, email: acc.email });
          break;
        }
      }
    }
    return out;
  },
});

export const _enableTracking = internalMutation({
  args: {
    accountIds: v.array(v.id("mailAccounts")),
    // false = emergency off-switch: the extractor's opt-in gate makes every
    // in-flight scheduled extraction a no-op immediately.
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, { accountIds, enabled }) => {
    const want = enabled !== false;
    for (const id of accountIds) {
      const acc = await ctx.db.get(id);
      if (acc && (acc.commitmentTrackingEnabled === true) !== want) {
        await ctx.db.patch(id, {
          commitmentTrackingEnabled: want ? true : undefined,
        });
      }
    }
  },
});

// Dev reset for a buggy extraction run — wipes ALL commitment rows. (The
// "never delete" product rule is about user workflow; rebuilding a bad
// machine-generated backfill is maintenance.) CLI only:
//   npx convex run --prod commitments:_wipeAll '{"confirm":"WIPE"}'
export const _wipeAll = internalMutation({
  args: { confirm: v.string() },
  handler: async (ctx, { confirm }) => {
    if (confirm !== "WIPE") throw new Error('Pass {"confirm":"WIPE"}');
    const rows = await ctx.db.query("commitments").take(1000);
    for (const r of rows) await ctx.db.delete(r._id);
    if (rows.length === 1000) {
      await ctx.scheduler.runAfter(500, internal.commitments._wipeAll, {
        confirm,
      });
    }
    return { deleted: rows.length };
  },
});

export const _backfillPage = internalQuery({
  args: {
    accountId: v.id("mailAccounts"),
    since: v.number(),
    afterReceivedAt: v.optional(v.number()),
    batch: v.number(),
  },
  handler: async (ctx, { accountId, since, afterReceivedAt, batch }) => {
    const lower = Math.max(since, (afterReceivedAt ?? 0) + 1);
    const rows = await ctx.db
      .query("emails")
      .withIndex("by_account_receivedAt", (q) =>
        q.eq("accountId", accountId).gte("receivedAt", lower),
      )
      .order("asc")
      .take(batch);
    return rows.map((e) => ({ id: e._id, receivedAt: e.receivedAt }));
  },
});

export const backfillCommitments = internalAction({
  args: {
    accountEmails: v.array(v.string()),
    sinceDays: v.optional(v.number()),
    budgetUsd: v.optional(v.number()),
    // Internal continuation state — leave unset when kicking off.
    accountIdx: v.optional(v.number()),
    afterReceivedAt: v.optional(v.number()),
    processed: v.optional(v.number()),
    extracted: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const sinceDays = args.sinceDays ?? 14;
    const budgetUsd = args.budgetUsd ?? 5;
    const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const BATCH = 15;

    const accounts = (await ctx.runQuery(internal.commitments._accountsByEmails, {
      emails: args.accountEmails,
    })) as Array<{ id: Id<"mailAccounts">; email: string }>;

    // First invocation: turn tracking on for these mailboxes (the extractor's
    // opt-in gate requires it, and the user asked for these to be tracked).
    if (args.accountIdx === undefined) {
      await ctx.runMutation(internal.commitments._enableTracking, {
        accountIds: accounts.map((a) => a.id),
      });
      console.log(
        `[commitments-backfill] starting: ${accounts.map((a) => a.email).join(", ")} — last ${sinceDays}d, budget $${budgetUsd}`,
      );
    }

    const accountIdx = args.accountIdx ?? 0;
    let processed = args.processed ?? 0;
    let extracted = args.extracted ?? 0;

    if (accountIdx >= accounts.length) {
      console.log(
        `[commitments-backfill] DONE — ${processed} emails scanned, ${extracted} produced commitments/completions`,
      );
      return;
    }

    // Budget gate (checked per chunk; the extractor re-checks per email).
    const window = (await ctx.runQuery(internal.ai.usageData._featureWindow, {
      hours: 48,
      feature: "commitments_backfill",
    })) as { total: { estimatedCostUsd: number } };
    if (window.total.estimatedCostUsd >= budgetUsd) {
      console.warn(
        `[commitments-backfill] STOPPED at budget $${budgetUsd} after ${processed} emails`,
      );
      return;
    }

    const account = accounts[accountIdx];
    const page = (await ctx.runQuery(internal.commitments._backfillPage, {
      accountId: account.id,
      since,
      afterReceivedAt: args.afterReceivedAt,
      batch: BATCH,
    })) as Array<{ id: Id<"emails">; receivedAt: number }>;

    if (page.length === 0) {
      // This account is drained — move to the next one.
      await ctx.scheduler.runAfter(500, internal.commitments.backfillCommitments, {
        ...args,
        accountIdx: accountIdx + 1,
        afterReceivedAt: undefined,
        processed,
        extracted,
      });
      return;
    }

    // Serial, oldest-first. The extractor itself skips junk, short bodies,
    // already-extracted emails, and anything else that doesn't qualify.
    for (const e of page) {
      const result = (await ctx.runAction(internal.ai.commitments.extractFromEmail, {
        emailId: e.id,
        maxAgeMs: (sinceDays + 1) * 24 * 60 * 60 * 1000,
        featureKey: "commitments_backfill",
        capUsd: budgetUsd,
      })) as { ran: boolean; inserted?: number; completed?: number };
      processed++;
      if (result.ran && ((result.inserted ?? 0) > 0 || (result.completed ?? 0) > 0)) {
        extracted++;
      }
    }

    console.log(
      `[commitments-backfill] ${account.email}: ${processed} scanned so far (${extracted} hits)`,
    );
    await ctx.scheduler.runAfter(1_000, internal.commitments.backfillCommitments, {
      ...args,
      accountIdx,
      afterReceivedAt: page[page.length - 1].receivedAt,
      processed,
      extracted,
    });
  },
});

export const _persistExtraction = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.id("mailAccounts"),
    userId: v.id("users"),
    threadId: v.id("threads"),
    sourceEmailId: v.id("emails"),
    requestedAt: v.number(),
    newCommitments: v.array(
      v.object({
        direction: v.union(v.literal("INBOUND"), v.literal("OUTBOUND")),
        description: v.string(),
        counterpartyEmail: v.string(),
        counterpartyName: v.optional(v.string()),
        dueAtHint: v.optional(v.number()),
      }),
    ),
    completions: v.array(
      v.object({
        commitmentId: v.id("commitments"),
        note: v.string(),
        completedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // Idempotency: bail if another run already wrote rows for this email.
    if (args.newCommitments.length > 0) {
      const existing = await ctx.db
        .query("commitments")
        .withIndex("by_sourceEmail", (q) =>
          q.eq("sourceEmailId", args.sourceEmailId),
        )
        .first();
      if (existing) return { inserted: 0, completed: 0 };
    }
    let inserted = 0;
    for (const c of args.newCommitments) {
      await ctx.db.insert("commitments", {
        workspaceId: args.workspaceId,
        accountId: args.accountId,
        userId: args.userId,
        threadId: args.threadId,
        sourceEmailId: args.sourceEmailId,
        direction: c.direction,
        description: c.description.slice(0, 500),
        counterpartyEmail: c.counterpartyEmail.toLowerCase(),
        counterpartyName: c.counterpartyName,
        requestedAt: args.requestedAt,
        dueAtHint: c.dueAtHint,
        status: "OPEN",
      });
      inserted++;
    }
    let completed = 0;
    for (const done of args.completions) {
      const row = (await ctx.db.get(done.commitmentId)) as
        | Doc<"commitments">
        | null;
      if (!row || row.status !== "OPEN") continue;
      // Guard against a hallucinated id pointing at another thread.
      if (row.threadId !== args.threadId) continue;
      await ctx.db.patch(done.commitmentId, {
        status: "COMPLETED",
        completedAt: done.completedAt,
        completedByEmailId: args.sourceEmailId,
        completionNote: done.note.slice(0, 300),
      });
      completed++;
    }
    return { inserted, completed };
  },
});
