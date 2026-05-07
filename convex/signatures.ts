// ─────────────────────────────────────────────────────────────────────────────
// signatures.ts — port of routes/signatures.
//
// Multi-account signatures: `accountIds: string[]` is preserved (mailAccount
// ids serialized as strings). The "default" flag is mutually exclusive among
// signatures that target the same scope (same first accountId, or both empty).
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";

async function shape(ctx: { db: any }, sig: Doc<"signatures">) {
  const accountId = sig.accountIds[0] ?? null;
  let account: { id: string; email: string; displayName?: string } | null = null;
  if (accountId) {
    try {
      const acct = await ctx.db.get(accountId as any);
      if (acct) {
        account = {
          id: acct._id,
          email: acct.email,
          displayName: acct.displayName ?? undefined,
        };
      }
    } catch {
      // invalid id — leave null
    }
  }
  return {
    id: sig._id,
    name: sig.name,
    bodyHtml: sig.bodyHtml,
    isDefault: sig.isDefault,
    accountIds: sig.accountIds,
    accountId,
    account,
    createdAt: sig._creationTime,
  };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const sigs = await ctx.db
      .query("signatures")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    sigs.sort((a, b) => a._creationTime - b._creationTime);
    return Promise.all(sigs.map((s) => shape(ctx, s)));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    bodyHtml: v.string(),
    isDefault: v.optional(v.boolean()),
    accountId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const accountIds = args.accountId ? [args.accountId] : [];

    if (args.isDefault) {
      const peers = await ctx.db
        .query("signatures")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      for (const peer of peers) {
        if (!peer.isDefault) continue;
        const sameScope = args.accountId
          ? peer.accountIds.includes(args.accountId)
          : peer.accountIds.length === 0;
        if (sameScope) {
          await ctx.db.patch(peer._id, { isDefault: false });
        }
      }
    }

    const id = await ctx.db.insert("signatures", {
      userId,
      name: args.name,
      bodyHtml: args.bodyHtml,
      isDefault: args.isDefault ?? false,
      accountIds,
    });
    const sig = await ctx.db.get(id);
    return sig ? shape(ctx, sig) : null;
  },
});

export const update = mutation({
  args: {
    id: v.id("signatures"),
    name: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
    accountId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const sig = await ctx.db.get(args.id);
    if (!sig || sig.userId !== userId) throw new Error("Signature not found");

    const targetAccountId =
      args.accountId !== undefined ? args.accountId : sig.accountIds[0] ?? null;

    if (args.isDefault) {
      const peers = await ctx.db
        .query("signatures")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      for (const peer of peers) {
        if (peer._id === args.id) continue;
        if (!peer.isDefault) continue;
        const sameScope = targetAccountId
          ? peer.accountIds.includes(targetAccountId)
          : peer.accountIds.length === 0;
        if (sameScope) {
          await ctx.db.patch(peer._id, { isDefault: false });
        }
      }
    }

    const updates: Partial<Doc<"signatures">> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.bodyHtml !== undefined) updates.bodyHtml = args.bodyHtml;
    if (args.isDefault !== undefined) updates.isDefault = args.isDefault;
    if (args.accountId !== undefined) {
      updates.accountIds = args.accountId ? [args.accountId] : [];
    }
    await ctx.db.patch(args.id, updates);
    const updated = await ctx.db.get(args.id);
    return updated ? shape(ctx, updated) : null;
  },
});

export const remove = mutation({
  args: { id: v.id("signatures") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const sig = await ctx.db.get(id);
    if (!sig || sig.userId !== userId) throw new Error("Signature not found");
    await ctx.db.delete(id);
    return { success: true };
  },
});
