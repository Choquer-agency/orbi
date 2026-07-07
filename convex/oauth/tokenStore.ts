// V8-runtime mutations for token persistence.
// Split out from tokenManager.ts because that file is "use node" (for node:crypto)
// and Convex disallows mutations in the node runtime.
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Persist a refreshed token (called from oauth/*.ts refresh actions).
// ─────────────────────────────────────────────────────────────────────────────
export const persistRefreshedToken = internalMutation({
  args: {
    accountId: v.id("mailAccounts"),
    encryptedAccessToken: v.string(),
    tokenExpiry: v.optional(v.number()),
    // Microsoft rotates refresh tokens on every refresh; discarding the new
    // one (the old behavior) meant the stored token aged out and the account
    // silently died. Gmail rarely rotates, but persists it when present too.
    encryptedRefreshToken: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { accountId, encryptedAccessToken, tokenExpiry, encryptedRefreshToken },
  ) => {
    const account = await ctx.db.get(accountId);
    if (!account) return;
    const patch: Record<string, unknown> = {
      accessToken: encryptedAccessToken,
      tokenExpiry,
    };
    if (encryptedRefreshToken) patch.refreshToken = encryptedRefreshToken;
    // A successful refresh proves the account is healthy again.
    if (account.needsReauth) patch.needsReauth = undefined;
    await ctx.db.patch(accountId, patch);
  },
});

// Flag an account whose refresh token no longer works — the ONLY fix is the
// user re-running the OAuth consent flow, so the UI must tell them.
export const markNeedsReauth = internalMutation({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    if (!account || account.needsReauth) return;
    await ctx.db.patch(accountId, { needsReauth: true });
  },
});
