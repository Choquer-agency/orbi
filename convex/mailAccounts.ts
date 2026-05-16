import {
  query,
  mutation,
  action,
  internalMutation,
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

/** Back-compat: legacy clients call api.mailAccounts.anyHistoricalSync. */
export const anyHistoricalSync = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const syncingAccounts = accounts.filter(
      (a) => a.historicalSyncStatus === "IN_PROGRESS",
    );
    // This function exists only for older deployed clients. The missing
    // function report came from code that is not in the current repo, so keep
    // the safest legacy shape: an iterable array of syncing accounts. Returning
    // an object here can crash stale clients that do `[...(result ?? [])]`.
    return syncingAccounts.map((a) => ({
      id: a._id,
      email: a.email,
      provider: a.provider,
      historicalSyncStatus: a.historicalSyncStatus,
      historicalSyncProgress: a.historicalSyncProgress ?? null,
    }));
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

/** POST /api/accounts/:id/sync — incremental sync. */
export const triggerSync = mutation({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    // Stub: queue placeholder. The sync agent will replace this with
    // ctx.scheduler.runAfter(0, internal.sync.<provider>.run, { accountId }).
    await ctx.db.patch(accountId, { lastSyncAt: Date.now() });
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
    // Stub: mark IN_PROGRESS; sync agent owns the worker.
    await ctx.db.patch(accountId, {
      historicalSyncStatus: "IN_PROGRESS",
      historicalSyncProgress: { startedAt: Date.now() },
    });
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
    const existing = await ctx.db
      .query("mailAccounts")
      .withIndex("by_provider_email", (q) =>
        q.eq("provider", args.provider).eq("email", args.email),
      )
      .first();

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

    return await ctx.db.insert("mailAccounts", {
      userId: args.userId,
      provider: args.provider,
      email: args.email,
      displayName: args.displayName,
      accessToken: args.encryptedAccessToken,
      refreshToken: args.encryptedRefreshToken,
      tokenExpiry: args.tokenExpiry,
      scopes: args.scopes,
      isActive: true,
      historicalSyncStatus: "IDLE",
    });
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
