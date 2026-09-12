import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

// Fixed launch baseline: three months before September 11, 2026, Vancouver time.
// Eligible requests stay eligible as they age; mailbox history is never deleted.
export const CLIENT_REPLY_START_AT = Date.parse("2026-06-11T00:00:00-07:00");

export function addresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(a => {
    const email = typeof a === "string" ? a : a?.email ?? a?.address;
    return typeof email === "string" ? [email.trim().toLowerCase()] : [];
  });
}
export async function matchClient(ctx: Pick<QueryCtx, "db">, workspaceId: Id<"workspaces">, version: string, email: string) {
  for (const key of [`email:${email.trim().toLowerCase()}`, `domain:${email.split("@")[1]?.toLowerCase()}`]) {
    const matches = await ctx.db.query("erpClientMatches").withIndex("by_workspaceId_and_version_and_key", q => q.eq("workspaceId", workspaceId).eq("version", version).eq("key", key)).take(3);
    const unique = [...new Set(matches.map(m => m.clientId))];
    if (unique.length > 1) return null; // Ambiguous company: require an exact sender link.
    if (unique.length === 1) return ctx.db.query("erpClients").withIndex("by_workspaceId_and_version_and_erpId", q => q.eq("workspaceId", workspaceId).eq("version", version).eq("erpId", unique[0])).unique();
  }
  return null;
}
export async function scheduleClientRefresh(ctx: MutationCtx, threadId: Id<"threads">) {
  const thread = await ctx.db.get(threadId);
  if (!thread) return;
  const account = await ctx.db.get(thread.accountId);
  if (!account) return;
  const user = await ctx.db.get(account.userId);
  if (!user?.workspaceId) return;
  const sync = await ctx.db.query("clientDirectorySync").withIndex("by_workspaceId", q => q.eq("workspaceId", user.workspaceId!)).unique();
  if (!sync) return;
  const row = await ctx.db.query("clientReplyQueue").withIndex("by_threadId", q => q.eq("threadId", threadId)).unique();
  const revision = (row?.revision ?? 0) + 1;
  const queueId = row?._id ?? await ctx.db.insert("clientReplyQueue", { workspaceId: user.workspaceId, userId: account.userId, accountId: account._id, threadId, revision, pending: true });
  if (row) await ctx.db.patch(row._id, { revision, pending: true });
  await ctx.scheduler.runAfter(0, internal.clients.scanThread, { queueId, revision, cursor: null, sentTo: [] });
}

/** Clear a known request in the successful-send transaction, before reconciliation. */
export async function resolveClientReplyAfterSend(ctx: MutationCtx, email: Doc<"emails">) {
  if (email.isForwarded || /^(fw|fwd):/i.test(email.subject)) return;
  const row = await ctx.db.query("clientReplyQueue").withIndex("by_threadId", q => q.eq("threadId", email.threadId)).unique();
  if (!row?.waitingAt || !row.clientId || (row.latestAt ?? 0) > email.receivedAt) return;
  const sync = await ctx.db.query("clientDirectorySync").withIndex("by_workspaceId", q => q.eq("workspaceId", row.workspaceId)).unique();
  if (!sync) return;
  for (const recipient of new Set([...addresses(email.toAddresses), ...addresses(email.ccAddresses)])) {
    const client = await matchClient(ctx, row.workspaceId, sync.version, recipient);
    if (client?.erpId === row.clientId) {
      await ctx.db.patch(row._id, { waitingAt: undefined });
      return;
    }
  }
}
