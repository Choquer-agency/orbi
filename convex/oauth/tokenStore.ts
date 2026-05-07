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
  },
  handler: async (ctx, { accountId, encryptedAccessToken, tokenExpiry }) => {
    await ctx.db.patch(accountId, {
      accessToken: encryptedAccessToken,
      tokenExpiry,
    });
  },
});
