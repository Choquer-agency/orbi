// ─────────────────────────────────────────────────────────────────────────────
// legacySweep.ts — two one-time cost burn-downs (2026-07-10 spend incident).
//
// 1. sweepLegacyBodies: pre-migration email rows still carry bodyHtml/bodyText
//    IN-ROW (~77KB/doc vs ~1KB lean). Every read of such a doc — list
//    hydration, search enrichment, AI context, classification joins — paid
//    those bytes, forever. This walk preserves the content (searchText for
//    AI search; emailBodies row when inside the 90-day display window; the
//    provider refetch covers older display) and clears the in-row copies.
//
// 2. backfillClassifications: stamp accountId/threadId/receivedAt onto
//    emailClassifications rows so the category list paths never join through
//    the email doc. Run AFTER sweepLegacyBodies so this walk reads lean docs.
//
// Both are batched cursor walks that self-reschedule (storageSweep pattern).
// Kick off:
//   npx convex run sync/legacySweep:sweepLegacyBodies '{}' --prod
//   npx convex run sync/legacySweep:backfillClassifications '{}' --prod
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { upsertEmailSearchText } from "../lib/searchText";
import { computeInboxStamp, patchThread } from "../lib/inboxStamp";

// Fat rows: keep batches small for the 16MB per-mutation read cap.
const BODY_BATCH = 20;
const DISPLAY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const sweepLegacyBodies = internalAction({
  args: {
    cursor: v.optional(v.number()),
    totals: v.optional(v.object({ scanned: v.number(), cleared: v.number() })),
  },
  handler: async (ctx, { cursor, totals }) => {
    const res: { scanned: number; cleared: number; nextCursor?: number } =
      await ctx.runMutation(internal.sync.legacySweep._sweepBodyBatch, {
        cursor,
      });
    const running = {
      scanned: (totals?.scanned ?? 0) + res.scanned,
      cleared: (totals?.cleared ?? 0) + res.cleared,
    };
    if (res.scanned > 0 && res.nextCursor !== undefined) {
      await ctx.scheduler.runAfter(
        1_000,
        internal.sync.legacySweep.sweepLegacyBodies,
        { cursor: res.nextCursor, totals: running },
      );
      return { status: "continuing", ...running };
    }
    console.log(
      `[legacySweep] bodies done: ${running.scanned} scanned, ${running.cleared} in-row bodies cleared`,
    );
    return { status: "done", ...running };
  },
});

export const _sweepBodyBatch = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("emails")
      .withIndex("by_creation_time", (q) =>
        cursor !== undefined ? q.gt("_creationTime", cursor) : q,
      )
      .order("asc")
      .take(BODY_BATCH);

    let cleared = 0;
    for (const e of rows) {
      if (!e.bodyHtml && !e.bodyText) continue; // already lean
      // Rows the send/draft pipelines still need in-row stay untouched:
      // drafts (compose edits read them) and unsent outbound (retry needs
      // the body). Rows without a providerMessageId aren't refetchable from
      // the provider, so their body is the only copy — keep it.
      if (e.isDraft) continue;
      if (e.sendStatus && e.sendStatus !== "SENT") continue;
      if (!e.providerMessageId) continue;

      // Preserve every word for AI search before clearing.
      await upsertEmailSearchText(ctx, {
        emailId: e._id,
        accountId: e.accountId,
        threadId: e.threadId,
        receivedAt: e.receivedAt,
        subject: e.subject,
        bodyText: e.bodyText,
        bodyHtml: e.bodyHtml,
      });

      // Recent mail keeps a display copy in emailBodies (the viewer reads
      // that table); older mail falls back to on-demand provider refetch.
      if (Date.now() - e.receivedAt < DISPLAY_WINDOW_MS) {
        const existingBody = await ctx.db
          .query("emailBodies")
          .withIndex("by_email", (q) => q.eq("emailId", e._id))
          .first();
        if (!existingBody) {
          await ctx.db.insert("emailBodies", {
            emailId: e._id,
            bodyText: e.bodyText,
            bodyHtml: e.bodyHtml,
          });
        }
      }

      await ctx.db.patch(e._id, { bodyHtml: undefined, bodyText: undefined });
      cleared++;
    }

    return {
      scanned: rows.length,
      cleared,
      nextCursor: rows.length > 0 ? rows[rows.length - 1]._creationTime : undefined,
    };
  },
});

// ── Inbox-stamp backfill (2026-07-10 read-cost fix) ─────────────────────────
// Stamps inboxAt/unreadInboxAt on every existing thread so the indexed inbox
// query can take over. New/updated threads are stamped by patchThread /
// stampedThreadInsert at write time.

const STAMP_BATCH = 250;

export const backfillInboxStamps = internalAction({
  args: {
    cursor: v.optional(v.number()),
    totals: v.optional(v.object({ scanned: v.number(), stamped: v.number() })),
  },
  handler: async (ctx, { cursor, totals }) => {
    const res: { scanned: number; stamped: number; nextCursor?: number } =
      await ctx.runMutation(internal.sync.legacySweep._stampBatch, { cursor });
    const running = {
      scanned: (totals?.scanned ?? 0) + res.scanned,
      stamped: (totals?.stamped ?? 0) + res.stamped,
    };
    if (res.scanned > 0 && res.nextCursor !== undefined) {
      await ctx.scheduler.runAfter(
        500,
        internal.sync.legacySweep.backfillInboxStamps,
        { cursor: res.nextCursor, totals: running },
      );
      return { status: "continuing", ...running };
    }
    console.log(
      `[legacySweep] inbox stamps done: ${running.scanned} scanned, ${running.stamped} stamped`,
    );
    return { status: "done", ...running };
  },
});

export const _stampBatch = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("threads")
      .withIndex("by_creation_time", (q) =>
        cursor !== undefined ? q.gt("_creationTime", cursor) : q,
      )
      .order("asc")
      .take(STAMP_BATCH);
    let stamped = 0;
    for (const t of rows) {
      const stamp = computeInboxStamp(t);
      if (
        (t.inboxAt ?? undefined) !== stamp.inboxAt ||
        (t.unreadInboxAt ?? undefined) !== stamp.unreadInboxAt
      ) {
        await ctx.db.patch(t._id, stamp);
        stamped++;
      }
    }
    return {
      scanned: rows.length,
      stamped,
      nextCursor: rows.length > 0 ? rows[rows.length - 1]._creationTime : undefined,
    };
  },
});

// ── lastReceivedAt repair (2026-07-28 alias bug) ────────────────────────────
// Replies sent from a send-as alias were counted as INBOUND (alias missing
// from userEmails), stamping lastReceivedAt with the user's own send time and
// bumping the thread to the inbox top. Recompute recent threads' true last
// inbound time from their newest emails; only corrects DOWNWARD.
//   npx convex run sync/legacySweep:repairLastReceived '{}' --prod
export const repairLastReceived = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const accounts = await ctx.db.query("mailAccounts").collect();
    // userId → all own addresses (primaries + aliases)
    const ownByUser = new Map<string, Set<string>>();
    for (const a of accounts) {
      const set = ownByUser.get(String(a.userId)) ?? new Set<string>();
      set.add(a.email.toLowerCase());
      for (const al of (a.aliases ?? []) as string[]) set.add(al.toLowerCase());
      ownByUser.set(String(a.userId), set);
    }
    let repaired = 0;
    for (const a of accounts) {
      const own = ownByUser.get(String(a.userId)) ?? new Set<string>();
      const recent = await ctx.db
        .query("threads")
        .withIndex("by_account_lastReceivedAt", (q) =>
          q.eq("accountId", a._id).gt("lastReceivedAt", cutoff),
        )
        .order("desc")
        .take(300);
      for (const t of recent) {
        const newest = await ctx.db
          .query("emails")
          .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", t._id))
          .order("desc")
          .take(15);
        const lastInbound = newest.find(
          (e) => e.fromAddress && !own.has(e.fromAddress.toLowerCase()),
        );
        if (
          lastInbound &&
          t.lastReceivedAt !== undefined &&
          lastInbound.receivedAt < t.lastReceivedAt
        ) {
          await patchThread(ctx, t._id, {
            lastReceivedAt: lastInbound.receivedAt,
          });
          repaired++;
        }
      }
    }
    return { repaired };
  },
});

// Sanity check before/after switching queries to the sticker indexes: counts
// threads whose stored stamp disagrees with a fresh computation. Must be 0.
//   npx convex run sync/legacySweep:_verifyStamps '{}' --prod
export const _verifyStamps = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("threads").order("desc").take(2000);
    let mismatched = 0;
    let inboxCount = 0;
    for (const t of rows) {
      const stamp = computeInboxStamp(t);
      if (
        (t.inboxAt ?? undefined) !== stamp.inboxAt ||
        (t.unreadInboxAt ?? undefined) !== stamp.unreadInboxAt
      ) {
        mismatched++;
      }
      if (stamp.inboxAt !== undefined) inboxCount++;
    }
    return { checked: rows.length, mismatched, inboxCount };
  },
});

// ── Classification purge (2026-07-10: category feature deleted) ─────────────
// Deletes every emailClassifications row. The classifier no longer runs on
// new mail, list paths no longer read the table, and the UI is removed —
// this clears the stored data per Bryce's "delete it altogether".

const PURGE_BATCH = 400;

export const purgeClassifications = internalAction({
  args: {
    totals: v.optional(v.object({ deleted: v.number() })),
  },
  handler: async (ctx, { totals }) => {
    const res: { deleted: number } = await ctx.runMutation(
      internal.sync.legacySweep._purgeClsBatch,
      {},
    );
    const running = { deleted: (totals?.deleted ?? 0) + res.deleted };
    if (res.deleted > 0) {
      await ctx.scheduler.runAfter(
        500,
        internal.sync.legacySweep.purgeClassifications,
        { totals: running },
      );
      return { status: "continuing", ...running };
    }
    console.log(`[legacySweep] classifications purged: ${running.deleted} rows`);
    return { status: "done", ...running };
  },
});

export const _purgeClsBatch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("emailClassifications")
      .withIndex("by_creation_time", (q) => q)
      .order("asc")
      .take(PURGE_BATCH);
    for (const r of rows) {
      await ctx.db.delete(r._id);
    }
    return { deleted: rows.length };
  },
});

// ── Classification denorm backfill ──────────────────────────────────────────
// OBSOLETE (2026-07-10): superseded by purgeClassifications the same day the
// backfill shipped — the category feature was deleted outright. Kept so an
// in-flight chained run terminates cleanly (it stops once rows are gone).

const CLS_BATCH = 100;

export const backfillClassifications = internalAction({
  args: {
    cursor: v.optional(v.number()),
    totals: v.optional(v.object({ scanned: v.number(), stamped: v.number() })),
  },
  handler: async (ctx, { cursor, totals }) => {
    const res: { scanned: number; stamped: number; nextCursor?: number } =
      await ctx.runMutation(internal.sync.legacySweep._backfillClsBatch, {
        cursor,
      });
    const running = {
      scanned: (totals?.scanned ?? 0) + res.scanned,
      stamped: (totals?.stamped ?? 0) + res.stamped,
    };
    if (res.scanned > 0 && res.nextCursor !== undefined) {
      await ctx.scheduler.runAfter(
        1_000,
        internal.sync.legacySweep.backfillClassifications,
        { cursor: res.nextCursor, totals: running },
      );
      return { status: "continuing", ...running };
    }
    console.log(
      `[legacySweep] classifications done: ${running.scanned} scanned, ${running.stamped} stamped`,
    );
    return { status: "done", ...running };
  },
});

export const _backfillClsBatch = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("emailClassifications")
      .withIndex("by_creation_time", (q) =>
        cursor !== undefined ? q.gt("_creationTime", cursor) : q,
      )
      .order("asc")
      .take(CLS_BATCH);

    let stamped = 0;
    for (const c of rows) {
      if (c.accountId && c.threadId && c.receivedAt !== undefined) continue;
      const email = await ctx.db.get(c.emailId);
      if (!email) continue;
      await ctx.db.patch(c._id, {
        accountId: email.accountId,
        threadId: email.threadId,
        receivedAt: email.receivedAt,
      });
      stamped++;
    }

    return {
      scanned: rows.length,
      stamped,
      nextCursor: rows.length > 0 ? rows[rows.length - 1]._creationTime : undefined,
    };
  },
});

// Debug probe (2026-08-20): full attachment state for emails matching a
// search phrase. npx convex run sync/legacySweep:_debugAttachmentState '{"text":"..."}'
export const _debugAttachmentState = internalQuery({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const hits = await ctx.db
      .query("emailSearchText")
      .withSearchIndex("search_text", (q) => q.search("text", text))
      .take(5);
    const out: any[] = [];
    for (const h of hits) {
      const email = await ctx.db.get(h.emailId);
      if (!email) continue;
      const atts = await ctx.db
        .query("attachments")
        .withIndex("by_email", (q) => q.eq("emailId", h.emailId))
        .collect();
      out.push({
        emailId: h.emailId,
        subject: email.subject,
        from: email.fromAddress,
        receivedAt: new Date(email.receivedAt).toISOString(),
        hasAttachments: email.hasAttachments ?? null,
        attachmentRows: atts.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          contentId: a.contentId ?? null,
          providerAttachmentId: a.providerAttachmentId ? "yes" : null,
          storageId: a.storageId ? "yes" : null,
        })),
      });
    }
    return out;
  },
});

// One-time ghost-draft purge (2026-08-21): reply autosave used to count the
// auto-filled recipients as content, minting EMPTY drafts that force-open
// the composer on every thread visit. Deletes Orbi-created drafts
// (providerMessageId "draft-*") with no body text and no subject-worthy
// content. Provider-synced drafts are never touched.
//   npx convex run sync/legacySweep:purgeGhostDrafts '{}'
export const purgeGhostDrafts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("mailAccounts").collect();
    let deleted = 0;
    for (const a of accounts) {
      const drafts = await ctx.db
        .query("emails")
        .withIndex("by_account_isDraft_receivedAt", (q) =>
          q.eq("accountId", a._id).eq("isDraft", true),
        )
        .collect();
      for (const d of drafts) {
        if (!d.providerMessageId?.startsWith("draft-")) continue; // Orbi-created only
        const bodyRow = await ctx.db
          .query("emailBodies")
          .withIndex("by_email", (q) => q.eq("emailId", d._id))
          .first();
        const text = (d.bodyText ?? bodyRow?.bodyText ?? "").trim();
        const html = (d.bodyHtml ?? bodyRow?.bodyHtml ?? "")
          .replace(/<[^>]+>/g, "")
          .trim();
        if (text === "" && html === "") {
          if (bodyRow) await ctx.db.delete(bodyRow._id);
          await ctx.db.delete(d._id);
          deleted++;
        }
      }
    }
    return { deleted };
  },
});

// Debug (2026-08-21): list all current draft rows with provenance.
export const _debugListDrafts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("mailAccounts").collect();
    const out: any[] = [];
    for (const a of accounts) {
      const drafts = await ctx.db
        .query("emails")
        .withIndex("by_account_isDraft_receivedAt", (q) =>
          q.eq("accountId", a._id).eq("isDraft", true),
        )
        .collect();
      for (const d of drafts) {
        out.push({
          account: a.email,
          emailId: d._id,
          subject: (d.subject ?? "").slice(0, 60),
          providerMessageId: d.providerMessageId?.slice(0, 24),
          labels: d.labels ?? null,
          created: new Date(d._creationTime).toISOString(),
        });
      }
    }
    return out;
  },
});

// Debug (2026-08-25): counts of states that can hide threads.
export const _debugSyncHealth = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("mailAccounts").collect();
    const out: any[] = [];
    for (const a of accounts) {
      const orphans = await ctx.db
        .query("threads")
        .withIndex("by_account_needsRepair", (q) =>
          q.eq("accountId", a._id).eq("needsRepair", true),
        )
        .collect();
      out.push({
        account: a.email,
        isActive: a.isActive,
        needsReauth: (a as any).needsReauth ?? null,
        syncCursor: a.syncCursor ? "set" : "MISSING",
        watchExpiration: (a as any).watchExpiration
          ? new Date((a as any).watchExpiration).toISOString()
          : null,
        orphanThreads: orphans.length,
        orphanSample: orphans.slice(0, 3).map((t) => ({
          subject: (t.subject ?? "").slice(0, 50),
          created: new Date(t._creationTime).toISOString(),
        })),
      });
    }
    return out;
  },
});

// Debug (2026-08-25): full trace of one sender across blocks, threads, emails.
export const _debugTraceSender = internalQuery({
  args: { senderEmail: v.string() },
  handler: async (ctx, { senderEmail }) => {
    const target = senderEmail.toLowerCase();
    const blocks = (await ctx.db.query("blockedSenders").collect()).filter(
      (b: any) =>
        (b.email && b.email.toLowerCase() === target) ||
        (b.domain && target.endsWith(b.domain.toLowerCase())),
    );
    const accounts = await ctx.db.query("mailAccounts").collect();
    const threads: any[] = [];
    for (const a of accounts) {
      const recent = await ctx.db
        .query("threads")
        .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", a._id))
        .order("desc")
        .take(1500);
      for (const t of recent) {
        if (t.participantEmails?.some((e: string) => e.toLowerCase() === target)) {
          threads.push({
            account: a.email,
            threadId: t._id,
            subject: (t.subject ?? "").slice(0, 60),
            lastMessageAt: new Date(t.lastMessageAt).toISOString(),
            isTrashed: t.isTrashed,
            isArchived: t.isArchived,
            isSpam: t.isSpam ?? null,
            snoozedUntil: t.snoozedUntil ?? null,
            inboxAt: t.inboxAt ? "set" : null,
            lastReceivedAt: t.lastReceivedAt
              ? new Date(t.lastReceivedAt).toISOString()
              : null,
            labels: t.labels,
            needsRepair: t.needsRepair ?? null,
          });
        }
      }
    }
    return { blocks, threads };
  },
});

// One-off repair: clear a wrongly-trashed thread (restamps inbox sticker).
export const _unTrashThread = internalMutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    await patchThread(ctx, threadId, { isTrashed: false });
    const t = await ctx.db.get(threadId);
    return { isTrashed: t?.isTrashed, inboxAt: t?.inboxAt ?? null };
  },
});

// Bulk draft purge (2026-08-25, Bryce: "remove all drafts"). Scope: ONLY the
// named user's own accounts — never teammates'. Deletes local rows and
// trashes provider-synced drafts Gmail-side (recoverable from Gmail trash
// for 30 days; without the provider trash they would just resync back).
export const purgeAllDraftsForUser = internalMutation({
  args: { ownerEmail: v.string() },
  handler: async (ctx, { ownerEmail }) => {
    const owner = (await ctx.db.query("mailAccounts").collect()).find(
      (a) => a.email.toLowerCase() === ownerEmail.toLowerCase(),
    );
    if (!owner) throw new Error("owner account not found");
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", owner.userId))
      .collect();
    let deleted = 0;
    let providerTrashed = 0;
    const byAccount: Record<string, number> = {};
    for (const a of accounts) {
      const drafts = await ctx.db
        .query("emails")
        .withIndex("by_account_isDraft_receivedAt", (q) =>
          q.eq("accountId", a._id).eq("isDraft", true),
        )
        .collect();
      byAccount[a.email] = drafts.length;
      for (const d of drafts) {
        const pmid = d.providerMessageId ?? "";
        if (
          a.provider === "GMAIL" &&
          pmid &&
          !pmid.startsWith("local-") &&
          !pmid.startsWith("draft-")
        ) {
          await ctx.scheduler.runAfter(0, internal.sync.gmail._trashProviderMessage, {
            accountId: a._id,
            providerMessageId: pmid,
          });
          providerTrashed++;
        }
        const bodyRow = await ctx.db
          .query("emailBodies")
          .withIndex("by_email", (q) => q.eq("emailId", d._id))
          .first();
        if (bodyRow) await ctx.db.delete(bodyRow._id);
        const search = await ctx.db
          .query("emailSearchText")
          .withIndex("by_email", (q) => q.eq("emailId", d._id))
          .first();
        if (search) await ctx.db.delete(search._id);
        await ctx.db.delete(d._id);
        deleted++;
      }
    }
    return { deleted, providerTrashed, byAccount };
  },
});

// Debug (2026-08-27): find emails by search phrase, with full thread state.
export const _debugFindThread = internalQuery({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const hits = await ctx.db
      .query("emailSearchText")
      .withSearchIndex("search_text", (q) => q.search("text", text))
      .take(8);
    const out: any[] = [];
    for (const h of hits) {
      const email = await ctx.db.get(h.emailId);
      if (!email) continue;
      const t = await ctx.db.get(email.threadId);
      const account = await ctx.db.get(email.accountId);
      out.push({
        subject: (email.subject ?? "").slice(0, 70),
        from: email.fromAddress,
        receivedAt: new Date(email.receivedAt).toISOString(),
        account: account?.email,
        thread: t
          ? {
              id: t._id,
              isTrashed: t.isTrashed,
              isArchived: t.isArchived,
              isSpam: t.isSpam ?? null,
              snoozedUntil: t.snoozedUntil
                ? new Date(t.snoozedUntil).toISOString()
                : null,
              inboxAt: t.inboxAt ? "set" : null,
              labels: t.labels,
              lastReceivedAt: t.lastReceivedAt
                ? new Date(t.lastReceivedAt).toISOString()
                : null,
            }
          : "THREAD MISSING",
      });
    }
    return out;
  },
});

// Repair (2026-08-27): threads poisoned into isTrashed by a trashed draft
// BEFORE the 08-25 rule fix. Signature is exact: locally trashed, but labels
// still carry INBOX + DRAFT + TRASH (a live conversation with a discarded
// draft). Genuinely user-deleted threads lose INBOX on their next sync, and
// rarely carry DRAFT — the triple signature keeps this surgical.
export const repairPoisonedTrash = internalMutation({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("mailAccounts").collect();
    const repaired: any[] = [];
    for (const a of accounts) {
      const recent = await ctx.db
        .query("threads")
        .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", a._id))
        .order("desc")
        .take(2000);
      for (const t of recent) {
        if (
          t.isTrashed &&
          t.labels.includes("INBOX") &&
          t.labels.includes("DRAFT") &&
          t.labels.includes("TRASH")
        ) {
          await patchThread(ctx, t._id, { isTrashed: false });
          repaired.push({ account: a.email, subject: (t.subject ?? "").slice(0, 50) });
        }
      }
    }
    return { count: repaired.length, repaired };
  },
});

// Debug (2026-09-07): peek at one email row + its body — image srcs, draft
// content length — for the "images missing in Instagram mail" and
// "composer auto-opens on empty Gmail drafts" investigations.
//   npx convex run sync/legacySweep:_debugEmailPeek '{"emailId":"..."}'
export const _debugEmailPeek = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const e = await ctx.db.get(emailId);
    if (!e) return null;
    const body = await ctx.db
      .query("emailBodies")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .first();
    const html = body?.bodyHtml ?? e.bodyHtml ?? "";
    const clean = body?.bodyHtmlClean ?? e.bodyHtmlClean ?? "";
    const imgs: string[] = [];
    for (const m of html.matchAll(/<img\b[^>]*?\bsrc=["']([^"']+)["']/gi)) {
      if (imgs.length < 15) imgs.push(m[1].slice(0, 700));
    }
    const cleanImgs = (clean.match(/<img\b/gi) ?? []).length;
    return {
      subject: e.subject,
      from: e.fromAddress,
      isDraft: e.isDraft ?? false,
      providerMessageId: e.providerMessageId,
      snippet: (e as any).snippet ?? null,
      bodyTextLen: (body?.bodyText ?? e.bodyText ?? "").length,
      bodyTextHead: (body?.bodyText ?? e.bodyText ?? "").slice(0, 200),
      bodyHtmlLen: html.length,
      bodyHtmlCleanLen: clean.length,
      imgCountRaw: (html.match(/<img\b/gi) ?? []).length,
      imgCountClean: cleanImgs,
      imgSrcs: imgs,
      trimmedLen: (body?.bodyHtmlTrimmed ?? e.bodyHtmlTrimmed ?? "").length,
      doubleEscapedAmp: {
        raw: (html.match(/&amp;amp;/g) ?? []).length,
        clean: (clean.match(/&amp;amp;/g) ?? []).length,
        trimmed: ((body?.bodyHtmlTrimmed ?? e.bodyHtmlTrimmed ?? "").match(/&amp;amp;/g) ?? []).length,
      },
      trimmedFirstImg: ((body?.bodyHtmlTrimmed ?? e.bodyHtmlTrimmed ?? "").match(/<img\b[^>]*>/i)?.[0] ?? "").slice(0, 300),
      imgTags: Array.from(html.matchAll(/<img\b[^>]*>/gi)).slice(0, 4).map((m) => m[0].replace(/src="[^"]*"/, 'src="…"').slice(0, 500)),
      firstImgContext: (() => {
        const i = html.search(/<img\b/i);
        return i < 0 ? "" : html.slice(Math.max(0, i - 700), i + 900).replace(/src="[^"]*"/g, 'src="…"');
      })(),
      styleHideRules: Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
        .map((m) => m[1])
        .join("\n")
        .split("}")
        .filter((r) => /display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0/i.test(r))
        .slice(0, 8)
        .map((r) => r.replace(/\s+/g, " ").trim().slice(0, 200)),
    };
  },
});

// Debug: raw stored HTML of one email (for offline pipeline repros).
export const _debugEmailHtml = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const e = await ctx.db.get(emailId);
    if (!e) return null;
    const body = await ctx.db
      .query("emailBodies")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .first();
    return body?.bodyHtml ?? e.bodyHtml ?? "";
  },
});

// Debug (2026-09-07): trace every thread whose participants include a domain,
// with the flags that decide whether it shows in the Inbox. For the
// "Amazon mail disappears" report.
//   npx convex run sync/legacySweep:_debugTraceDomain '{"domain":"amazon"}'
export const _debugTraceDomain = internalQuery({
  args: { domain: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { domain, limit }) => {
    const needle = domain.toLowerCase();
    const cap = limit ?? 40;
    const accounts = await ctx.db.query("mailAccounts").collect();
    const out: any[] = [];
    for (const a of accounts) {
      const recent = await ctx.db
        .query("threads")
        .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", a._id))
        .order("desc")
        .take(3000);
      for (const t of recent) {
        if (!t.participantEmails?.some((e: string) => e.toLowerCase().includes(needle))) continue;
        out.push({
          account: a.email,
          threadId: t._id,
          subject: (t.subject ?? "").slice(0, 60),
          from: t.participantEmails.filter((e: string) => e.toLowerCase().includes(needle)).slice(0, 2),
          lastMessageAt: new Date(t.lastMessageAt).toISOString(),
          isTrashed: t.isTrashed,
          isArchived: t.isArchived,
          isSpam: t.isSpam ?? null,
          inboxAt: t.inboxAt ? new Date(t.inboxAt).toISOString() : null,
          snoozedUntil: t.snoozedUntil ? new Date(t.snoozedUntil).toISOString() : null,
          labels: t.labels,
          needsRepair: (t as any).needsRepair ?? null,
          messageCount: t.messageCount,
        });
        if (out.length >= cap) return out;
      }
    }
    return out;
  },
});

// Debug (2026-09-07): find threads that SHOULD be in the inbox but aren't
// reachable through the by_account_inbox sticker index (or vice-versa).
// A mismatch = a thread that silently vanished from the Inbox view.
//   npx convex run sync/legacySweep:_debugInboxStampDrift '{}'
export const _debugInboxStampDrift = internalQuery({
  args: { perAccount: v.optional(v.number()) },
  handler: async (ctx, { perAccount }) => {
    const cap = perAccount ?? 2000;
    const accounts = await ctx.db.query("mailAccounts").collect();
    const out: any[] = [];
    const counts: Record<string, any> = {};
    for (const a of accounts) {
      const recent = await ctx.db
        .query("threads")
        .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", a._id))
        .order("desc")
        .take(cap);
      let drift = 0;
      let inboxLabelNoReceived = 0;
      for (const t of recent) {
        const shouldBeInInbox =
          !t.isTrashed &&
          !t.isArchived &&
          !t.snoozedUntil &&
          !t.isSpam &&
          !(t.labels ?? []).includes("SPAM") &&
          t.lastReceivedAt !== undefined;
        const stamped = t.inboxAt !== undefined && t.inboxAt !== null;
        // Threads Gmail still labels INBOX but that we dropped from the view.
        const gmailSaysInbox =
          (t.labels ?? []).includes("INBOX") && !t.isTrashed && !t.snoozedUntil;
        if (gmailSaysInbox && t.lastReceivedAt === undefined) inboxLabelNoReceived++;
        if (shouldBeInInbox !== stamped || (gmailSaysInbox && !stamped)) {
          drift++;
          if (out.length < 25) {
            out.push({
              account: a.email,
              threadId: t._id,
              subject: (t.subject ?? "").slice(0, 55),
              participants: (t.participantEmails ?? []).slice(0, 2),
              labels: t.labels,
              isTrashed: t.isTrashed,
              isArchived: t.isArchived,
              isSpam: t.isSpam ?? null,
              lastReceivedAt: t.lastReceivedAt
                ? new Date(t.lastReceivedAt).toISOString()
                : null,
              lastMessageAt: new Date(t.lastMessageAt).toISOString(),
              inboxAt: t.inboxAt ? new Date(t.inboxAt).toISOString() : null,
              reason:
                shouldBeInInbox !== stamped ? "stamp-mismatch" : "gmail-inbox-not-stamped",
            });
          }
        }
      }
      counts[a.email] = {
        scanned: recent.length,
        drift,
        gmailInboxButNoLastReceived: inboxLabelNoReceived,
      };
    }
    return { counts, samples: out };
  },
});

// Debug (2026-09-07): threads Gmail labels INBOX, not trashed/spam, that are
// INVISIBLE in Orbi's inbox because lastReceivedAt never got computed — and
// that genuinely have an outside sender (so "self-sent only" is excluded).
//   npx convex run sync/legacySweep:_debugInvisibleInbox '{}'
export const _debugInvisibleInbox = internalQuery({
  args: { perAccount: v.optional(v.number()) },
  handler: async (ctx, { perAccount }) => {
    const cap = perAccount ?? 2500;
    const accounts = await ctx.db.query("mailAccounts").collect();
    const out: any[] = [];
    for (const a of accounts) {
      const own = a.email.toLowerCase();
      const recent = await ctx.db
        .query("threads")
        .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", a._id))
        .order("desc")
        .take(cap);
      for (const t of recent) {
        if (t.isTrashed || t.isSpam || t.snoozedUntil) continue;
        if (!(t.labels ?? []).includes("INBOX")) continue;
        if (t.inboxAt !== undefined && t.inboxAt !== null) continue;
        // Who actually sent the newest message?
        const newest = await ctx.db
          .query("emails")
          .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", t._id))
          .order("desc")
          .take(3);
        const senders = newest.map((e) => (e.fromAddress ?? "").toLowerCase());
        const hasOutsideSender = senders.some(
          (s) => s && s !== own && !s.endsWith("@choquer.agency"),
        );
        out.push({
          account: a.email,
          threadId: t._id,
          subject: (t.subject ?? "").slice(0, 55),
          senders: senders.slice(0, 2),
          hasOutsideSender,
          lastMessageAt: new Date(t.lastMessageAt).toISOString(),
          lastReceivedAt: t.lastReceivedAt
            ? new Date(t.lastReceivedAt).toISOString()
            : null,
          isArchived: t.isArchived,
          emailCount: newest.length,
        });
        if (out.length >= 60) return out;
      }
    }
    return out;
  },
});

// Debug (2026-09-07): for a set of threads, show WHO trashed them —
// folderStateLocalAt is stamped only when the change came from an Orbi UI
// action, so its absence means the state was mirrored in from the provider.
export const _debugThreadProvenance = internalQuery({
  args: { threadIds: v.array(v.id("threads")) },
  handler: async (ctx, { threadIds }) => {
    const out: any[] = [];
    for (const id of threadIds) {
      const t = await ctx.db.get(id);
      if (!t) {
        out.push({ threadId: id, missing: true });
        continue;
      }
      out.push({
        threadId: id,
        subject: (t.subject ?? "").slice(0, 50),
        isTrashed: t.isTrashed,
        isArchived: t.isArchived,
        labels: t.labels,
        providerThreadId: t.providerThreadId,
        rowCreated: new Date(t._creationTime).toISOString(),
        lastMessageAt: new Date(t.lastMessageAt).toISOString(),
        folderStateLocalAt: (t as any).folderStateLocalAt
          ? new Date((t as any).folderStateLocalAt).toISOString()
          : null,
        readStateLocalAt: (t as any).readStateLocalAt
          ? new Date((t as any).readStateLocalAt).toISOString()
          : null,
      });
    }
    return out;
  },
});

// Debug (2026-09-07): how many threads carry a split sub-thread id ("::"),
// broken down per account, plus samples for one domain.
export const _debugSplitThreads = internalQuery({
  args: { domain: v.optional(v.string()) },
  handler: async (ctx, { domain }) => {
    const needle = (domain ?? "").toLowerCase();
    const accounts = await ctx.db.query("mailAccounts").collect();
    const counts: Record<string, { scanned: number; split: number }> = {};
    const samples: any[] = [];
    for (const a of accounts) {
      const recent = await ctx.db
        .query("threads")
        .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", a._id))
        .order("desc")
        .take(2500);
      let split = 0;
      for (const t of recent) {
        if (!t.providerThreadId.includes("::")) continue;
        split++;
        if (
          needle &&
          samples.length < 12 &&
          t.participantEmails?.some((e: string) => e.toLowerCase().includes(needle))
        ) {
          samples.push({
            account: a.email,
            subject: (t.subject ?? "").slice(0, 50),
            providerThreadId: t.providerThreadId,
            lastMessageAt: new Date(t.lastMessageAt).toISOString(),
            inboxAt: t.inboxAt ? "set" : null,
            isTrashed: t.isTrashed,
          });
        }
      }
      counts[a.email] = { scanned: recent.length, split };
    }
    return { counts, samples };
  },
});
