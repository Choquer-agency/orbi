import {
  query,
  mutation,
  action,
  internalMutation,
  internalAction,
  internalQuery,
} from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/auth";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Mail Accounts (Gmail / Microsoft / IMAP) — ported from
// packages/backend/src/routes/accounts/index.ts.
//
// Schema rename: Prisma `Account` → Convex `mailAccounts` (the Convex Auth
// `accounts` table holds OAuth login providers; we don't conflict with it).
//
// Token columns store ENCRYPTED ciphertext; encryption is handled in
// convex/oauth/tokenManager.ts using TOKEN_ENCRYPTION_KEY (matches the
// backend's AES-256-GCM format so existing rows remain readable).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Public reads / writes
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/accounts → list connected accounts for the current user. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    return accounts
      .map((a) => ({
        id: a._id,
        provider: a.provider,
        email: a.email,
        displayName: a.displayName ?? null,
        isActive: a.isActive,
        lastSyncAt: a.lastSyncAt ?? null,
        color: a.color ?? null,
        aliases: a.aliases ?? [],
        createdAt: a._creationTime,
        // Token fields intentionally omitted from the public projection.
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

/** GET an individual mailAccount the user owns. */
export const get = query({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    return {
      id: account._id,
      provider: account.provider,
      email: account.email,
      displayName: account.displayName ?? null,
      isActive: account.isActive,
      lastSyncAt: account.lastSyncAt ?? null,
      historicalSyncStatus: account.historicalSyncStatus,
      historicalSyncProgress: account.historicalSyncProgress ?? null,
      historicalSyncCompletedAt: account.historicalSyncCompletedAt ?? null,
    };
  },
});

/** GET /api/accounts/:id/sync-status */
export const getSyncStatus = query({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    return {
      historicalSyncStatus: account.historicalSyncStatus,
      historicalSyncProgress: account.historicalSyncProgress ?? null,
      historicalSyncCompletedAt: account.historicalSyncCompletedAt ?? null,
      lastSyncAt: account.lastSyncAt ?? null,
    };
  },
});

/**
 * Aggregate historical-sync state across ALL the user's accounts. Powers the
 * global "Importing N / ~M…" indicator in the thread list and the
 * "still indexing contacts" footer in compose autocomplete.
 */
export const anyHistoricalSync = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    let inProgress = false;
    let syncedThreads = 0;
    let totalThreads = 0;
    let inProgressEmail: string | null = null;
    let contactBackfillInProgress = false;

    for (const a of accounts) {
      if (a.historicalSyncStatus === "IN_PROGRESS") {
        inProgress = true;
        if (!inProgressEmail) inProgressEmail = a.email;
        const prog = (a.historicalSyncProgress ?? null) as
          | { syncedThreads?: number; totalThreads?: number; syncedMessages?: number; totalMessages?: number }
          | null;
        syncedThreads += prog?.syncedThreads ?? prog?.syncedMessages ?? 0;
        totalThreads += prog?.totalThreads ?? prog?.totalMessages ?? 0;
      }
      if (a.contactBackfillStatus === "IN_PROGRESS") {
        contactBackfillInProgress = true;
      }
    }

    return {
      inProgress,
      syncedThreads,
      totalThreads,
      accountEmail: inProgressEmail,
      contactBackfillInProgress,
    };
  },
});

/**
 * Set the per-account avatar ring color. Accepts either a hex string
 * ("#FF7E16") or null to clear (revert to the deterministic palette default
 * on the client). Validates lightly so a malformed value can't break CSS.
 */
export const setColor = mutation({
  args: {
    accountId: v.id("mailAccounts"),
    color: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { accountId, color }) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    let next: string | undefined;
    if (color === null) {
      next = undefined;
    } else {
      const trimmed = color.trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
        throw new Error("Color must be a 6-digit hex string like #FF7E16");
      }
      next = trimmed;
    }
    await ctx.db.patch(accountId, { color: next });
    return { ok: true, color: next ?? null };
  },
});

/** PATCH /api/accounts/:id — rename / set displayName. */
export const updateDisplayName = mutation({
  args: {
    accountId: v.id("mailAccounts"),
    displayName: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { accountId, displayName }) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    await ctx.db.patch(accountId, {
      displayName: displayName || undefined,
    });
    const updated = await ctx.db.get(accountId);
    if (!updated) throw new Error("Account not found after update");
    return {
      id: updated._id,
      provider: updated.provider,
      email: updated.email,
      displayName: updated.displayName ?? null,
      isActive: updated.isActive,
    };
  },
});

/** DELETE /api/accounts/:id — disconnect a connected mailbox. */
export const disconnect = mutation({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    await ctx.db.delete(accountId);
    return { success: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Sync triggers — Phase 3 only stages the trigger; the actual sync workers
// are owned by another agent (Phase 4: email sync). Here we just no-op or
// schedule the action they will provide. Until then we simply mark
// `lastSyncAt` to give the UI feedback.
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/accounts/:id/sync — incremental sync. Schedules the real worker. */
export const triggerSync = mutation({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    await ctx.db.patch(accountId, { lastSyncAt: Date.now() });
    if (account.provider === "GMAIL") {
      await ctx.scheduler.runAfter(0, internal.sync.gmail._continueSync, {
        accountId,
        pageToken: undefined,
        mode: "auto",
      });
    } else if (account.provider === "MICROSOFT") {
      await ctx.scheduler.runAfter(0, internal.sync.microsoft.syncIncremental, {
        accountId,
      });
    }
    return { message: "Sync queued", provider: account.provider };
  },
});

/** POST /api/accounts/:id/historical-sync — full historical backfill. */
export const triggerHistoricalSync = mutation({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    if (account.provider !== "GMAIL" && account.provider !== "MICROSOFT") {
      throw new Error("Historical sync is only supported for Gmail and Microsoft accounts");
    }
    if (account.historicalSyncStatus === "IN_PROGRESS") {
      throw new Error("Historical sync already in progress");
    }
    await ctx.db.patch(accountId, {
      historicalSyncStatus: "IN_PROGRESS",
      historicalSyncProgress: { startedAt: Date.now() },
    });
    if (account.provider === "GMAIL") {
      await ctx.scheduler.runAfter(0, internal.sync.gmailHistorical._continueHistorical, {
        accountId,
        pageToken: undefined,
      });
    } else if (account.provider === "MICROSOFT") {
      await ctx.scheduler.runAfter(0, internal.sync.microsoftHistorical.startHistorical, {
        accountId,
      });
    }
    return { message: "Historical sync started" };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// IMAP manual setup — kept as a passthrough so the UI flow stays intact.
// Note: password is encrypted; we still store the IMAP host config in
// `syncCursor` to mirror the backend's pattern (cheap until a proper
// imapConfig column lands).
// ─────────────────────────────────────────────────────────────────────────────
export const createImapAccount = action({
  args: {
    email: v.string(),
    displayName: v.optional(v.string()),
    host: v.string(),
    port: v.number(),
    username: v.string(),
    password: v.string(),
    smtpHost: v.string(),
    smtpPort: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    id: Id<"mailAccounts">;
    provider: "APPLE_IMAP";
    email: string;
    displayName: string | null;
  }> => {
    const userId = await requireUser(ctx);
    // Lazy-import so the v8 runtime version of this file doesn't pull node libs.
    const { encrypt } = await import("./oauth/tokenManager");

    const imapConfig = JSON.stringify({
      host: args.host,
      port: args.port,
      username: args.username,
      smtpHost: args.smtpHost,
      smtpPort: args.smtpPort,
    });

    const accountId: Id<"mailAccounts"> = await ctx.runMutation(
      internal.mailAccounts._insertImapAccount,
      {
        userId,
        email: args.email,
        displayName: args.displayName,
        encryptedPassword: await encrypt(args.password),
        imapConfig,
      },
    );
    return {
      id: accountId,
      provider: "APPLE_IMAP",
      email: args.email,
      displayName: args.displayName ?? null,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// OAuth: produce the consent URL for the connect flow.
// Frontend POSTs to this action, opens the returned URL in a window/tab,
// and the provider redirects back to the HTTP callback in oauth/http.ts.
// ─────────────────────────────────────────────────────────────────────────────
export const getOAuthUrl = action({
  args: {
    provider: v.union(v.literal("GMAIL"), v.literal("MICROSOFT")),
    platform: v.optional(v.string()), // "web" | "desktop" | "capacitor"
  },
  handler: async (ctx, { provider, platform }): Promise<{ url: string }> => {
    const userId = await requireUser(ctx);
    const platformResolved = platform || "web";
    const state = `${userId}|${platformResolved}`;

    if (provider === "GMAIL") {
      const { buildAuthUrl } = await import("./oauth/gmail");
      return { url: buildAuthUrl(state) };
    }
    const { buildAuthUrl } = await import("./oauth/microsoft");
    return { url: buildAuthUrl(state) };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal: read for tokenManager (token fields included)
// ─────────────────────────────────────────────────────────────────────────────
export const _setAliases = internalMutation({
  args: {
    accountId: v.id("mailAccounts"),
    aliases: v.array(v.string()),
  },
  handler: async (ctx, { accountId, aliases }) => {
    const dedup = Array.from(new Set(aliases.map((a) => a.toLowerCase().trim()))).filter(
      (a) => a.includes("@"),
    );
    const before = await ctx.db.get(accountId);
    const prevAliases = new Set((before?.aliases ?? []).map((a) => a.toLowerCase().trim()));
    const changed =
      prevAliases.size !== dedup.length ||
      dedup.some((a) => !prevAliases.has(a));
    await ctx.db.patch(accountId, {
      aliases: dedup,
      aliasesUpdatedAt: Date.now(),
    });
    if (changed && before?.userId) {
      // Aliases moved → re-evaluate every open Needs Response signal for
      // this user. Emails that are now "self" get dismissed; the rest get
      // rescored under the new self-email set. Fixes the class of bug
      // where historical scoring saw an alias as external.
      await ctx.scheduler.runAfter(
        0,
        internal.needsResponse._rescoreAfterConfigChange,
        { userId: before.userId },
      );
    }
    return { ok: true, count: dedup.length };
  },
});

export const _getAccountForToken = internalQuery({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const a = await ctx.db.get(accountId);
    if (!a) return null;
    return {
      _id: a._id,
      provider: a.provider,
      accessToken: a.accessToken,
      refreshToken: a.refreshToken ?? null,
      tokenExpiry: a.tokenExpiry ?? null,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal: upsert from OAuth callback (Gmail + Microsoft)
// ─────────────────────────────────────────────────────────────────────────────
export const _upsertOAuthAccount = internalMutation({
  args: {
    userId: v.id("users"),
    provider: v.union(v.literal("GMAIL"), v.literal("MICROSOFT")),
    email: v.string(),
    displayName: v.optional(v.string()),
    encryptedAccessToken: v.string(),
    encryptedRefreshToken: v.optional(v.string()),
    tokenExpiry: v.optional(v.number()),
    scopes: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"mailAccounts">> => {
    // Match per-user: a Gmail/MS address can be connected to multiple
    // Orbi users independently. Only treat it as "existing" if the same
    // user is reconnecting the same address.
    const userAccounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const existing = userAccounts.find(
      (a) => a.provider === args.provider && a.email === args.email,
    );

    if (existing) {
      await ctx.db.patch(existing._id, {
        accessToken: args.encryptedAccessToken,
        ...(args.encryptedRefreshToken
          ? { refreshToken: args.encryptedRefreshToken }
          : {}),
        tokenExpiry: args.tokenExpiry,
        displayName: args.displayName,
        isActive: true,
      });
      return existing._id;
    }

    const accountId = await ctx.db.insert("mailAccounts", {
      userId: args.userId,
      provider: args.provider,
      email: args.email,
      displayName: args.displayName,
      accessToken: args.encryptedAccessToken,
      refreshToken: args.encryptedRefreshToken,
      tokenExpiry: args.tokenExpiry,
      scopes: args.scopes,
      isActive: true,
      historicalSyncStatus: "IN_PROGRESS",
      historicalSyncProgress: {
        syncedThreads: 0,
        totalThreads: 0,
        startedAt: Date.now(),
        lastBatchAt: Date.now(),
      },
    });
    // Brand-new account: kick off the historical backfill so the user doesn't
    // have to find and click the "Import All" button. Existing accounts (the
    // patch branch above) skip this path so a token refresh doesn't restart sync.
    if (args.provider === "GMAIL") {
      await ctx.scheduler.runAfter(
        0,
        internal.sync.gmailHistorical._continueHistorical,
        { accountId, pageToken: undefined },
      );
    } else if (args.provider === "MICROSOFT") {
      await ctx.scheduler.runAfter(
        0,
        internal.sync.microsoftHistorical.startHistorical,
        { accountId },
      );
    }
    return accountId;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal: insert IMAP account (called from createImapAccount action)
// ─────────────────────────────────────────────────────────────────────────────
export const _insertImapAccount = internalMutation({
  args: {
    userId: v.id("users"),
    email: v.string(),
    displayName: v.optional(v.string()),
    encryptedPassword: v.string(),
    imapConfig: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"mailAccounts">> => {
    return await ctx.db.insert("mailAccounts", {
      userId: args.userId,
      provider: "APPLE_IMAP",
      email: args.email,
      displayName: args.displayName,
      accessToken: args.encryptedPassword,
      syncCursor: args.imapConfig,
      scopes: [],
      isActive: true,
      historicalSyncStatus: "IDLE",
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Historical-sync watchdog. Fired every 5 min by crons.ts.
//
// Two responsibilities:
//   1. Re-schedule `_continueHistorical` for accounts whose historical sync is
//      IN_PROGRESS but `lastBatchAt` is >5 min old (scheduler entry was
//      dropped, action crashed, deploy interrupted, etc.).
//   2. Kick off the one-shot recipient-contact backfill for accounts whose
//      historical sync has COMPLETED but contacts haven't been backfilled.
//      This is what surfaces frequent contacts in compose autocomplete for
//      users who imported their inbox before the per-email outbound recipient
//      extraction landed.
// ─────────────────────────────────────────────────────────────────────────────
const STALL_THRESHOLD_MS = 5 * 60 * 1000;

export const _resumeStalledHistorical = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts: {
      _id: Id<"mailAccounts">;
      provider: "GMAIL" | "MICROSOFT" | "APPLE_IMAP";
      historicalSyncStatus?: "IDLE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
      historicalSyncProgress?: { lastBatchAt?: number; pageToken?: string } | null;
      contactBackfillStatus?: "PENDING" | "IN_PROGRESS" | "COMPLETED";
    }[] = await ctx.runQuery(internal.mailAccounts._listAccountsForWatchdog, {});

    const now = Date.now();
    for (const a of accounts) {
      // 1. Stalled IN_PROGRESS — restart from saved pageToken.
      if (a.historicalSyncStatus === "IN_PROGRESS") {
        const lastBatchAt = a.historicalSyncProgress?.lastBatchAt ?? 0;
        if (now - lastBatchAt > STALL_THRESHOLD_MS) {
          if (a.provider === "GMAIL") {
            await ctx.scheduler.runAfter(
              0,
              internal.sync.gmailHistorical._continueHistorical,
              { accountId: a._id, pageToken: a.historicalSyncProgress?.pageToken },
            );
          } else if (a.provider === "MICROSOFT") {
            // Microsoft's startHistorical idempotently resumes from the saved
            // nextLink, so it's the right entry point for both fresh starts
            // and stall recovery.
            await ctx.scheduler.runAfter(
              0,
              internal.sync.microsoftHistorical.startHistorical,
              { accountId: a._id },
            );
          }
        }
        continue;
      }

      // 2. Contact backfill not yet started. We don't gate on historical
      // status anymore: even if the user only has incrementally-synced
      // emails (the historical button never pressed), we still want their
      // outbound recipients indexed so compose autocomplete catches up.
      if (
        a.contactBackfillStatus !== "COMPLETED" &&
        a.contactBackfillStatus !== "IN_PROGRESS"
      ) {
        await ctx.runMutation(
          internal.contacts._resumeOrStartContactBackfill,
          { accountId: a._id },
        );
      }
    }
  },
});

export const _listAccountsForWatchdog = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("mailAccounts").collect();
    return all.map((a) => ({
      _id: a._id,
      provider: a.provider,
      historicalSyncStatus: a.historicalSyncStatus,
      historicalSyncProgress: (a.historicalSyncProgress ?? null) as {
        lastBatchAt?: number;
        pageToken?: string;
      } | null,
      contactBackfillStatus: a.contactBackfillStatus,
    }));
  },
});
