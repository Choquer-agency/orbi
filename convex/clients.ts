import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import { requireTeamHub } from "./lib/workspace";
import { addresses, matchClient, scheduleClientRefresh } from "./lib/clientQueue";
import type { Doc } from "./_generated/dataModel";

export const status = query({ args: {}, handler: async ctx => {
  const userId = await requireUser(ctx);
  const user = await ctx.db.get(userId);
  if (!user?.workspaceId) return null;
  const workspace = await ctx.db.get(user.workspaceId);
  if (!workspace?.features.includes("team_hub")) return null;
  const sync = await ctx.db.query("clientDirectorySync").withIndex("by_workspaceId", q => q.eq("workspaceId", user.workspaceId!)).unique();
  const pending = await ctx.db.query("clientReplyQueue").withIndex("by_workspaceId_and_pending", q => q.eq("workspaceId", user.workspaceId!).eq("pending", true)).first();
  return { syncedAt: sync?.syncedAt ?? null, indexing: !!sync?.rebuilding || !!pending, error: sync?.error ?? null };
} });
export const list = query({
  args: { accountId: v.optional(v.id("mailAccounts")), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    const base = args.accountId
      ? ctx.db.query("clientReplyQueue").withIndex("by_userId_and_accountId_and_waitingAt", q => q.eq("userId", userId).eq("accountId", args.accountId!).gt("waitingAt", 0))
      : ctx.db.query("clientReplyQueue").withIndex("by_userId_and_waitingAt", q => q.eq("userId", userId).gt("waitingAt", 0));
    const result = await base.order("asc").paginate(args.paginationOpts);
    const page = [];
    for (const row of result.page) {
      const thread = await ctx.db.get(row.threadId);
      const account = await ctx.db.get(row.accountId);
      if (!thread || !account?.isActive || account.userId !== userId || thread.isTrashed || thread.isSpam || thread.labels.includes("SPAM")) continue;
      page.push({ ...row, subject: thread.subject, snippet: thread.snippet ?? "", isRead: thread.isRead });
    }
    return { ...result, page };
  },
});
export const dismiss = mutation({
  args: { threadId: v.id("threads"), latestEmailId: v.id("emails") }, handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    const row = await ctx.db.query("clientReplyQueue").withIndex("by_threadId", q => q.eq("threadId", args.threadId)).unique();
    if (!row || row.userId !== userId) throw new Error("Conversation not found");
    if (row.latestEmailId !== args.latestEmailId) throw new Error("A new message arrived. Review it before clearing this conversation.");
    await ctx.db.patch(row._id, { dismissedThrough: row.latestAt, waitingAt: undefined });
    await scheduleClientRefresh(ctx, args.threadId);
  },
});
const candidate = v.object({ clientId: v.string(), clientName: v.string(), sender: v.string(), senderName: v.optional(v.string()), latestAt: v.number(), latestEmailId: v.id("emails"), waitingAt: v.number() });
export const scanThread = internalMutation({
  args: { queueId: v.id("clientReplyQueue"), revision: v.number(), cursor: v.union(v.string(), v.null()), sentTo: v.array(v.string()), candidate: v.optional(candidate) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.queueId);
    if (!row || row.revision !== args.revision) return;
    const thread = await ctx.db.get(row.threadId);
    const account = await ctx.db.get(row.accountId);
    const sync = await ctx.db.query("clientDirectorySync").withIndex("by_workspaceId", q => q.eq("workspaceId", row.workspaceId)).unique();
    const clear = { pending: false, waitingAt: undefined, latestEmailId: undefined, latestAt: undefined, clientId: undefined, clientName: undefined, sender: undefined, senderName: undefined };
    if (!thread || !account?.isActive || !sync || thread.isTrashed || thread.isSpam || thread.labels.includes("SPAM")) { await ctx.db.patch(row._id, clear); return; }
    const accounts = await ctx.db.query("mailAccounts").withIndex("by_user", q => q.eq("userId", row.userId)).take(100);
    const own = new Set(accounts.flatMap(a => [a.email.toLowerCase(), ...(a.aliases ?? []).map(s => s.toLowerCase())]));
    const page = await ctx.db.query("emails").withIndex("by_thread_receivedAt", q => q.eq("threadId", row.threadId)).order("desc").paginate({ numItems: 8, cursor: args.cursor });
    const sentTo = new Set(args.sentTo);
    let pending = args.candidate;
    let finished = false;
    const cache = new Map<string, Doc<"erpClients"> | null>();
    const match = async (email: string) => {
      if (!cache.has(email)) cache.set(email, await matchClient(ctx, row.workspaceId, sync.version, email));
      return cache.get(email)!;
    };
    for (const email of page.page) {
      if (email.isDraft || !["NONE", "SENT"].includes(email.sendStatus)) continue;
      const from = email.fromAddress.trim().toLowerCase();
      if (own.has(from)) {
        const recipients = [...addresses(email.toAddresses), ...addresses(email.ccAddresses)];
        // A forward/internal note doesn't count as a response to the client.
        if (/^(fw|fwd):/i.test(email.subject) || email.isForwarded) continue;
        for (const recipient of recipients) {
          const client = await match(recipient);
          if (client) sentTo.add(client.erpId);
        }
        if (pending && sentTo.has(pending.clientId)) { finished = true; break; }
        continue;
      }
      if (/^(no[._-]?reply|mailer-daemon|postmaster)@/i.test(from) || email.labels.includes("SPAM") || email.labels.includes("TRASH")) continue;
      const client = await match(from);
      if (!client) continue;
      if (!pending) {
        // Latest client message defines this conversation. A later sent reply
        // or explicit dismissal resolves it, independent of read/archive state.
        if (sentTo.has(client.erpId) || email.receivedAt <= (row.dismissedThrough ?? 0)) { finished = true; break; }
        pending = { clientId: client.erpId, clientName: client.name, sender: from, senderName: email.fromName, latestAt: email.receivedAt, latestEmailId: email._id, waitingAt: email.receivedAt };
      } else if (client.erpId === pending.clientId) {
        if (email.receivedAt <= (row.dismissedThrough ?? 0)) { finished = true; break; }
        pending.waitingAt = Math.min(pending.waitingAt, email.receivedAt);
      }
    }
    if (!finished && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.clients.scanThread, { ...args, cursor: page.continueCursor, sentTo: [...sentTo], candidate: pending });
    } else await ctx.db.patch(row._id, pending ? { ...pending, pending: false } : clear);
  },
});

export const actor = internalQuery({ args: {}, handler: async ctx => {
  const userId = await requireUser(ctx);
  const { user, workspace } = await requireTeamHub(ctx, userId);
  if (!user.email) throw new Error("Your account needs an email address");
  return { userId, workspaceId: workspace._id, actorEmail: user.email.toLowerCase() };
} });
export const syncState = internalQuery({ args: { workspaceId: v.id("workspaces") }, handler: (ctx, args) => ctx.db.query("clientDirectorySync").withIndex("by_workspaceId", q => q.eq("workspaceId", args.workspaceId)).unique() });
export const installPage = internalMutation({
  args: { workspaceId: v.id("workspaces"), version: v.string(), clients: v.array(v.object({ id: v.string(), name: v.string(), domains: v.array(v.string()), emails: v.array(v.string()), specialistId: v.union(v.string(), v.null()) })) },
  handler: async (ctx, args) => {
    for (const c of args.clients) {
      await ctx.db.insert("erpClients", { workspaceId: args.workspaceId, version: args.version, erpId: c.id, name: c.name, specialistId: c.specialistId ?? undefined });
      for (const key of new Set([...c.emails.map(e => `email:${e.toLowerCase()}`), ...c.domains.map(d => `domain:${d.toLowerCase()}`)])) {
        await ctx.db.insert("erpClientMatches", { workspaceId: args.workspaceId, version: args.version, key, clientId: c.id });
      }
    }
  },
});
export const activate = internalMutation({
  args: { workspaceId: v.id("workspaces"), version: v.string(), fingerprint: v.string(), actorEmail: v.string() },
  handler: async (ctx, args) => {
    const old = await ctx.db.query("clientDirectorySync").withIndex("by_workspaceId", q => q.eq("workspaceId", args.workspaceId)).unique();
    const changed = old?.fingerprint !== args.fingerprint;
    const fields = { ...args, version: changed ? args.version : old!.version, syncedAt: Date.now(), rebuilding: changed || old?.rebuilding || false, error: undefined };
    if (old) await ctx.db.patch(old._id, fields); else await ctx.db.insert("clientDirectorySync", fields);
    if (changed && old) await ctx.scheduler.runAfter(0, internal.clients.cleanVersion, { workspaceId: args.workspaceId, version: old.version });
    // A concurrent identical refresh may have staged an unused version.
    if (!changed && args.version !== old!.version) await ctx.scheduler.runAfter(0, internal.clients.cleanVersion, { workspaceId: args.workspaceId, version: args.version });
    if (changed) await ctx.scheduler.runAfter(0, internal.clients.rebuild, { workspaceId: args.workspaceId, cursor: null, version: args.version });
  },
});
export const rebuild = internalMutation({
  args: { workspaceId: v.id("workspaces"), version: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const sync = await ctx.db.query("clientDirectorySync").withIndex("by_workspaceId", q => q.eq("workspaceId", args.workspaceId)).unique();
    if (!sync || sync.version !== args.version) return;
    // Walk the complete table in bounded pages; no age cutoff hides old mail.
    const page = await ctx.db.query("threads").paginate({ numItems: 40, cursor: args.cursor });
    for (const thread of page.page) {
      const account = await ctx.db.get(thread.accountId);
      const user = account ? await ctx.db.get(account.userId) : null;
      if (user?.workspaceId === args.workspaceId) await scheduleClientRefresh(ctx, thread._id);
    }
    if (page.isDone) await ctx.db.patch(sync._id, { rebuilding: false });
    else await ctx.scheduler.runAfter(0, internal.clients.rebuild, { ...args, cursor: page.continueCursor });
  },
});
export const syncTargets = internalQuery({ args: {}, handler: ctx => ctx.db.query("clientDirectorySync").take(100) });
export const syncError = internalMutation({ args: { workspaceId: v.id("workspaces"), error: v.string() }, handler: async (ctx, args) => {
  const row = await ctx.db.query("clientDirectorySync").withIndex("by_workspaceId", q => q.eq("workspaceId", args.workspaceId)).unique();
  if (row) await ctx.db.patch(row._id, { error: args.error });
} });

export const cleanVersion = internalMutation({
  args: { workspaceId: v.id("workspaces"), version: v.string() }, handler: async (ctx, args) => {
    const active = await ctx.db.query("clientDirectorySync").withIndex("by_workspaceId", q => q.eq("workspaceId", args.workspaceId)).unique();
    if (active?.version === args.version) return;
    const matches = await ctx.db.query("erpClientMatches").withIndex("by_workspaceId_and_version_and_key", q => q.eq("workspaceId", args.workspaceId).eq("version", args.version)).take(200);
    for (const row of matches) await ctx.db.delete(row._id);
    const clients = await ctx.db.query("erpClients").withIndex("by_workspaceId_and_version", q => q.eq("workspaceId", args.workspaceId).eq("version", args.version)).take(50);
    for (const row of clients) await ctx.db.delete(row._id);
    if (matches.length === 200 || clients.length === 50) await ctx.scheduler.runAfter(0, internal.clients.cleanVersion, args);
  },
});
