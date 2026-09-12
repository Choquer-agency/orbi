import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

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
