import { v } from "convex/values";
import { action, internalAction, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import { requireTeamHub } from "./lib/workspace";
import { matchClient } from "./lib/clientQueue";
import { downloadAttachmentForUser } from "./emails";

export interface Directory {
  clients: Array<{ id: string; name: string; domains: string[]; emails: string[]; specialistId: string | null }>;
  team: Array<{ id: string; name: string; email: string; role: string }>;
}
export interface WorkflowContext {
  userId: Id<"users">; actorEmail: string; threadId: Id<"threads">; sourceEmailId: Id<"emails">; sourceKey: string; sourceUrl: string;
  sender: string; senderName: string; clientId: string | null; subject: string; text: string;
  attachments: Array<{ id: Id<"attachments">; filename: string; mimeType: string; size: number }>; contextTruncated: boolean;
}
export interface PreparedWorkflow { directory: Directory; context: WorkflowContext; tickets: CreatedTicket[] }
export interface CreatedTicket { id: string; number: string; title: string; dueDate: string | null; url: string }
export interface TicketProposal { key: string; title: string; description: string; assigneeId: string; dueDate: string; priority: "low" | "normal" | "high" | "urgent"; attachmentIds: string[] }
async function erp<T>(operation: string, actorEmail: string, payload: Record<string, unknown> = {}): Promise<T> {
  const key = process.env.CHOQUER_INTAKE_KEY;
  if (!key) throw new Error("Choquer ERP connection is not configured");
  const response = await fetch(`${(process.env.CHOQUER_APP_URL ?? "https://choquer.app").replace(/\/$/, "")}/api/external/orbi/workflow`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, operation, actorEmail }) });
  let body;
  try { body = await response.json(); } catch { throw new Error("The ERP ticket connection is not available yet"); }
  if (!response.ok) throw new Error(body.error ?? `ERP request failed (${response.status})`);
  return body as T;
}
async function install(ctx: ActionCtx, workspaceId: Id<"workspaces">, actorEmail: string, directory: Directory) {
  if (!Array.isArray(directory.clients) || directory.clients.length > 2000 || !Array.isArray(directory.team)) throw new Error("Invalid ERP directory");
  const canonical = JSON.stringify(directory.clients.slice().sort((a, b) => a.id.localeCompare(b.id)));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const fingerprint = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  const current = await ctx.runQuery(internal.clients.syncState, { workspaceId });
  const version = crypto.randomUUID();
  if (current?.fingerprint !== fingerprint) {
    for (let i = 0; i < directory.clients.length; i += 10) {
      await ctx.runMutation(internal.clients.installPage, { workspaceId, version, clients: directory.clients.slice(i, i + 10) });
    }
  }
  await ctx.runMutation(internal.clients.activate, { workspaceId, version, fingerprint, actorEmail });
}
export const directory = action({ args: {}, handler: async (ctx): Promise<Directory> => {
  const actor = await ctx.runQuery(internal.clients.actor, {});
  const result = await erp<Directory>("directory", actor.actorEmail);
  await install(ctx, actor.workspaceId, actor.actorEmail, result);
  return result;
} });
export const linkSender = action({ args: { email: v.string(), name: v.optional(v.string()), clientId: v.string() }, handler: async (ctx, args): Promise<Directory> => {
  const actor = await ctx.runQuery(internal.clients.actor, {});
  const result = await erp<Directory>("link", actor.actorEmail, args);
  await install(ctx, actor.workspaceId, actor.actorEmail, result);
  return result;
} });
export const refreshDirectories = internalAction({ args: {}, handler: async ctx => {
  const targets = await ctx.runQuery(internal.clients.syncTargets, {});
  for (const target of targets) {
    try { await install(ctx, target.workspaceId, target.actorEmail, await erp<Directory>("directory", target.actorEmail)); }
    catch (error) { await ctx.runMutation(internal.clients.syncError, { workspaceId: target.workspaceId, error: error instanceof Error ? error.message : "Client sync failed" }); }
  }
} });

export const context = internalQuery({
  args: { threadId: v.id("threads"), sourceEmailId: v.optional(v.id("emails")) },
  handler: async (ctx, args): Promise<WorkflowContext> => {
    const userId = await requireUser(ctx);
    const { user, workspace } = await requireTeamHub(ctx, userId);
    const thread = await ctx.db.get(args.threadId);
    const account = thread ? await ctx.db.get(thread.accountId) : null;
    if (!thread || !account || account.userId !== userId) throw new Error("Open a conversation in your own mailbox");
    const accounts = await ctx.db.query("mailAccounts").withIndex("by_user", q => q.eq("userId", userId)).take(100);
    const own = new Set(accounts.flatMap(a => [a.email.toLowerCase(), ...(a.aliases ?? []).map(s => s.toLowerCase())]));
    let source = args.sourceEmailId ? await ctx.db.get(args.sourceEmailId) : null;
    if (args.sourceEmailId && !source) throw new Error("The original email is no longer available");
    if (source && (source.threadId !== thread._id || source.isDraft || own.has(source.fromAddress.toLowerCase()))) throw new Error("Invalid source email");
    if (!source) {
      for await (const email of ctx.db.query("emails").withIndex("by_thread_receivedAt", q => q.eq("threadId", thread._id)).order("desc")) {
        if (!email.isDraft && !own.has(email.fromAddress.toLowerCase()) && email.sendStatus === "NONE") { source = email; break; }
      }
    }
    if (!source) throw new Error("No incoming client email found");
    const recent = await ctx.db.query("emails").withIndex("by_thread_receivedAt", q => q.eq("threadId", thread._id).lte("receivedAt", source!.receivedAt)).order("desc").take(21);
    const texts: string[] = [];
    const attachments = [];
    for (const email of recent.slice(0, 20).reverse()) {
      if (email.isDraft || !["NONE", "SENT"].includes(email.sendStatus)) continue;
      const search = await ctx.db.query("emailSearchText").withIndex("by_email", q => q.eq("emailId", email._id)).first();
      const body = search ? null : await ctx.db.query("emailBodies").withIndex("by_email", q => q.eq("emailId", email._id)).first();
      const text = search?.text ?? body?.bodyText ?? email.bodyText ?? (body?.bodyHtml ?? email.bodyHtml ?? "").replace(/<[^>]*>/g, " ");
      if (email._id === source._id && !text.trim()) throw new Error("Open the email to load its full text, then try again");
      texts.push(`${email._id === source._id ? "NEWEST CLIENT EMAIL — extract requests from this message" : "EARLIER CONTEXT"}\nFrom: ${email.fromAddress}\nDate: ${new Date(email.receivedAt).toISOString()}\nSubject: ${email.subject}\n${text}`);
      const files = await ctx.db.query("attachments").withIndex("by_email", q => q.eq("emailId", email._id)).take(31);
      for (const file of files) attachments.push({ id: file._id, filename: file.filename, mimeType: file.mimeType, size: file.size });
    }
    if (attachments.length > 30) throw new Error("This conversation has more than 30 attachments. Create its tickets in the ERP so all files can be reviewed.");
    const text = texts.join("\n\n---\n\n");
    if (text.length > 150000) throw new Error("This conversation is too long to analyze in Orbi. Use the ERP to review all its details.");
    const sync = await ctx.db.query("clientDirectorySync").withIndex("by_workspaceId", q => q.eq("workspaceId", workspace._id)).unique();
    const client = sync ? await matchClient(ctx, workspace._id, sync.version, source.fromAddress) : null;
    return { userId, actorEmail: user.email!, threadId: thread._id, sourceEmailId: source._id, sourceKey: source.internetMessageId || `${account.email}:${source.providerMessageId}`,
      sourceUrl: `https://orbi-mail.vercel.app/?threadId=${thread._id}`, sender: source.fromAddress, senderName: source.fromName ?? "", clientId: client?.erpId ?? null,
      subject: source.subject, text, attachments, contextTruncated: recent.length > 20 };
  },
});
export const prepare = action({ args: { threadId: v.id("threads") }, handler: async (ctx, args): Promise<PreparedWorkflow> => {
  const actor = await ctx.runQuery(internal.clients.actor, {});
  const directory = await erp<Directory>("directory", actor.actorEmail);
  await install(ctx, actor.workspaceId, actor.actorEmail, directory);
  const context = await ctx.runQuery(internal.clientWorkflow.context, args);
  const history = await erp<{ tickets: CreatedTicket[] }>("history", actor.actorEmail, { sourceKey: context.sourceKey });
  return { directory, context, tickets: history.tickets };
} });
async function sourcePayload(ctx: ActionCtx, threadId: Id<"threads">, sourceEmailId: Id<"emails">) {
  const context = await ctx.runQuery(internal.clientWorkflow.context, { threadId, sourceEmailId });
  const attachments = [];
  for (const file of context.attachments) {
    if (file.size > 20 * 1024 * 1024) throw new Error(`${file.filename} is larger than 20 MB. Please handle it in the ERP.`);
    const download = await downloadAttachmentForUser(ctx, file.id, context.userId);
    attachments.push({ ...file, url: download.url });
  }
  return { ...context, attachments };
}
export const extract = action({
  args: { threadId: v.id("threads"), sourceEmailId: v.id("emails"), clientId: v.string() },
  handler: async (ctx, args): Promise<{ items?: TicketProposal[]; summary?: string; warnings?: string[]; tickets?: CreatedTicket[]; alreadyCreated?: boolean }> => {
    const context = await sourcePayload(ctx, args.threadId, args.sourceEmailId);
    return erp("extract", context.actorEmail, { ...context, clientId: args.clientId });
  },
});
export const createTickets = action({
  args: { threadId: v.id("threads"), sourceEmailId: v.id("emails"), clientId: v.string(), items: v.array(v.object({ title: v.string(), description: v.string(), assigneeId: v.string(), dueDate: v.string(), priority: v.union(v.literal("low"), v.literal("normal"), v.literal("high"), v.literal("urgent")), attachmentIds: v.array(v.string()) })) },
  handler: async (ctx, args): Promise<{ tickets: CreatedTicket[] }> => {
    const context = await sourcePayload(ctx, args.threadId, args.sourceEmailId);
    return erp("create", context.actorEmail, { ...context, clientId: args.clientId, items: args.items });
  },
});
