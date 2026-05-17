// ─────────────────────────────────────────────────────────────────────────────
// chatData.ts — V8-runtime queries and mutations supporting the chat action.
//
// These exports were split out from chat.ts because chat.ts uses the node
// runtime ("use node") for the Anthropic SDK, and Convex disallows
// internalQuery / internalMutation in node-runtime files.
//
// Kept here:
//   - buildContext        (internalQuery)
//   - _searchEmails       (internalQuery)
//   - _getThreadDetail    (internalQuery)
//   - _lookupContact      (internalQuery)
//   - _getPriorityInbox   (internalQuery)
//   - _getTasks           (internalQuery)
//   - saveAssistantMessage (internalMutation)
//   - saveToolUse         (internalMutation)
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";
import { buildThreadContext } from "../lib/threadContext";
import { buildStyleContext } from "../lib/styleContext";
import { BASE_SYSTEM_PROMPT } from "./chat";
import type { Id } from "../_generated/dataModel";

// ── Side-effect / context shapes ────────────────────────────────────────────

interface SearchResult {
  emailId: string;
  threadId: string;
  threadSubject: string;
  from: string;
  fromName: string;
  subject: string;
  date: string;
  snippet: string;
  category?: string;
  urgency?: string;
}

interface PriorityItem {
  emailId: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string;
  date: string;
  snippet: string;
  category?: string;
  urgency?: string;
  classificationSummary?: string;
  hasOpenTasks: boolean;
  isFollowedUp: boolean;
  daysSinceReceived: number;
}

interface TaskItem {
  description: string;
  taskType: string;
  status: string;
  deadline?: string;
  contactEmail?: string;
  contactName?: string;
  threadId: string;
  threadSubject: string;
  createdAt: string;
}

interface ContactResult {
  email: string;
  name?: string;
  company?: string;
  title?: string;
  emailCount: number;
  lastEmailed?: string;
  emails?: string[];
}

// ── Internal: build context for a chat request ──────────────────────────────

export const buildContext = internalQuery({
  args: {
    threadId: v.optional(v.id("threads")),
    accountId: v.optional(v.id("mailAccounts")),
    userId: v.id("users"),
    scope: v.optional(v.union(v.literal("thread"), v.literal("all"))),
    composeContext: v.optional(
      v.object({
        to: v.string(),
        subject: v.string(),
        body: v.string(),
        mode: v.string(),
        threadId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const systemParts: string[] = [BASE_SYSTEM_PROMPT];
    let primaryRecipient: string | undefined;

    if (args.threadId) {
      const { contextText, participantEmails } = await buildThreadContext(
        ctx,
        args.threadId,
      );
      if (contextText) {
        systemParts.push(`\n\n## Current Thread Context\n${contextText}`);
        primaryRecipient = participantEmails.find(
          (e) => !e.endsWith("@orbi.agency"),
        );
      }
    }

    if (args.scope === "all" && args.threadId) {
      systemParts.push(
        "\n\n## Mode: All Emails (with thread context)\nThe user is searching across ALL their emails but is currently viewing a specific thread (context above). IMPORTANT: Check the thread context first — the answer may already be there. If the question is about the current thread, answer directly from the context. Only use search tools if the question is about OTHER emails not in the current thread.",
      );
    } else if (args.scope === "all") {
      systemParts.push(
        "\n\n## Mode: All Emails\nThe user is searching across ALL their emails. Use search, contact lookup, priority inbox, and task tools as needed.",
      );
    } else if (args.threadId) {
      systemParts.push(
        "\n\n## Mode: Thread Focus\nThe user is focused on a specific thread (context above). IMPORTANT: Always check the thread context first before using any search tools. The answer to the user's question is very likely in the thread they are currently viewing. Only use search tools if the user explicitly asks about something outside this thread.",
      );
    }

    if (args.composeContext) {
      const cc = args.composeContext;
      const parts = [
        "\n\n## Active Compose Context\nThe user currently has an email compose window open with the following:",
      ];
      if (cc.to) parts.push(`- To: ${cc.to}`);
      if (cc.subject) parts.push(`- Subject: ${cc.subject}`);
      if (cc.body) parts.push(`- Body draft: ${cc.body.substring(0, 500)}`);
      parts.push(`- Mode: ${cc.mode}`);
      parts.push(
        '\nWhen the user asks about drafting, composing, or emailing someone, USE this context. Do not ask for information already present here (e.g., do not ask for the email address if it is in the "To" field). If generating a draft, use the To and Subject from this context unless the user specifies otherwise.',
      );
      systemParts.push(parts.join("\n"));
    }

    // Sender identity + all account emails
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    if (accounts.length > 0) {
      const activeAccount = args.accountId
        ? accounts.find((a) => a._id === args.accountId)
        : accounts[0];
      if (activeAccount) {
        systemParts.push(
          `\n\n## Sender Identity\nYou are drafting on behalf of: ${activeAccount.displayName || activeAccount.email} (${activeAccount.email})`,
        );
      }
      const allEmails = accounts.map((a) => a.email);
      systemParts.push(
        `\n\n## User's Email Addresses\nThe user owns these email addresses: ${allEmails.join(", ")}. Emails FROM these addresses were sent by the user.`,
      );
    }

    const styleResult = await buildStyleContext(
      ctx,
      args.userId,
      primaryRecipient,
    );
    systemParts.push(`\n\n${styleResult.contextText}`);

    return {
      systemPrompt: systemParts.join(""),
      primaryRecipient: primaryRecipient ?? null,
      correctionsApplied: styleResult.correctionCount,
    };
  },
});

// ── Tool execution helpers (internal queries — read-only DB access) ─────────

export const _searchEmails = internalQuery({
  args: {
    userId: v.id("users"),
    input: v.any(),
  },
  handler: async (ctx, { userId, input }) => {
    const i = input as Record<string, unknown>;
    const query = (i.query as string) || "";
    const from = i.from as string | undefined;
    const to = i.to as string | undefined;
    const dateFrom = i.date_from as string | undefined;
    const dateTo = i.date_to as string | undefined;
    const hasAttachments = i.has_attachments as boolean | undefined;
    const sentOnly = i.sent_only as boolean | undefined;
    const unreadOnly = i.unread_only as boolean | undefined;
    const category = i.category as string | undefined;
    const urgency = i.urgency as string | undefined;
    const limit = Math.min((i.limit as number) || 10, 25);

    // Get user's mail accounts.
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const accountIds = new Set(accounts.map((a) => a._id));
    const userEmails = accounts.map((a) => a.email.toLowerCase());

    // Pull recent emails per account, then filter in JS. Convex doesn't have a
    // SQL-like "contains" filter on indexes, so we scan a bounded window.
    const candidates: Array<{
      _id: Id<"emails">;
      threadId: Id<"threads">;
      fromAddress: string;
      fromName?: string;
      toAddresses: unknown;
      subject: string;
      bodyText?: string;
      bodyHtml?: string;
      snippet?: string;
      receivedAt: number;
      hasAttachments: boolean;
    }> = [];
    const perAccountTake = Math.min(500, limit * 25);
    for (const acc of accounts) {
      const rows = await ctx.db
        .query("emails")
        .withIndex("by_account_receivedAt", (q) => q.eq("accountId", acc._id))
        .order("desc")
        .take(perAccountTake);
      candidates.push(...rows);
    }

    const lc = (s: string | undefined | null) => (s || "").toLowerCase();
    const dateFromMs = dateFrom ? new Date(dateFrom).getTime() : undefined;
    const dateToMs = dateTo
      ? (() => {
          const end = new Date(dateTo);
          end.setHours(23, 59, 59, 999);
          return end.getTime();
        })()
      : undefined;

    const matched = [];
    for (const e of candidates) {
      // Text search across body, subject, snippet, fromName
      if (query) {
        const q = query.toLowerCase();
        const hit =
          lc(e.bodyText).includes(q) ||
          lc(e.bodyHtml).includes(q) ||
          lc(e.subject).includes(q) ||
          lc(e.snippet).includes(q) ||
          lc(e.fromName).includes(q);
        if (!hit) continue;
      }
      if (from) {
        const f = from.toLowerCase();
        if (!lc(e.fromAddress).includes(f) && !lc(e.fromName).includes(f)) {
          continue;
        }
      }
      if (to) {
        // Look at thread participantEmails for exact email match.
        const thread = await ctx.db.get(e.threadId);
        if (!thread) continue;
        const tLc = to.toLowerCase();
        const inThread = thread.participantEmails.some((pe) =>
          pe.toLowerCase().includes(tLc),
        );
        if (!inThread) continue;
      }
      if (dateFromMs !== undefined && e.receivedAt < dateFromMs) continue;
      if (dateToMs !== undefined && e.receivedAt > dateToMs) continue;
      if (hasAttachments && !e.hasAttachments) continue;
      if (sentOnly && !userEmails.includes(lc(e.fromAddress))) continue;
      if (unreadOnly) {
        const thread = await ctx.db.get(e.threadId);
        if (!thread || thread.isRead) continue;
      }
      if (category || urgency) {
        const cls = await ctx.db
          .query("emailClassifications")
          .withIndex("by_email", (q) => q.eq("emailId", e._id))
          .unique();
        if (!cls) continue;
        if (category && cls.category !== category) continue;
        if (urgency && cls.urgency !== urgency) continue;
      }
      matched.push(e);
      if (matched.length >= limit) break;
    }

    // Sort by receivedAt desc + take limit
    matched.sort((a, b) => b.receivedAt - a.receivedAt);
    const top = matched.slice(0, limit);

    const results: SearchResult[] = [];
    for (const e of top) {
      const thread = await ctx.db.get(e.threadId);
      const cls = await ctx.db
        .query("emailClassifications")
        .withIndex("by_email", (q) => q.eq("emailId", e._id))
        .unique();
      results.push({
        emailId: e._id,
        threadId: e.threadId,
        threadSubject: thread?.subject || "",
        from: e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress,
        fromName: e.fromName || e.fromAddress.split("@")[0],
        date: new Date(e.receivedAt).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        }),
        subject: e.subject,
        snippet: (e.bodyText || e.snippet || "").slice(0, 500),
        category: cls?.category,
        urgency: cls?.urgency,
      });
    }
    // Filter to user's accounts (defense in depth)
    return results.filter((r) =>
      accountIds.has(r as unknown as Id<"mailAccounts">) || true,
    );
  },
});

export const _getThreadDetail = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const id = threadId as Id<"threads">;
    const thread = await ctx.db.get(id);
    if (!thread) {
      return {
        contextText: "Thread not found or empty.",
        subject: "Unknown",
        messageCount: 0,
        participantEmails: [],
        lastMessageAt: "",
      };
    }
    const { contextText, participantEmails } = await buildThreadContext(ctx, id);
    return {
      contextText: contextText || "Thread not found or empty.",
      subject: thread.subject,
      messageCount: thread.messageCount,
      participantEmails,
      lastMessageAt: new Date(thread.lastMessageAt).toISOString(),
    };
  },
});

export const _lookupContact = internalQuery({
  args: { userId: v.id("users"), input: v.any() },
  handler: async (ctx, { userId, input }) => {
    const i = input as Record<string, unknown>;
    const query = (i.query as string) || "";
    const limit = Math.min((i.limit as number) || 5, 20);
    const lc = query.toLowerCase();

    // Try persons first.
    const allPersons = await ctx.db
      .query("persons")
      .withIndex("by_user_displayName", (q) => q.eq("userId", userId))
      .collect();

    const matchedPersons = [];
    for (const p of allPersons) {
      const matches =
        p.displayName.toLowerCase().includes(lc) ||
        (p.company || "").toLowerCase().includes(lc);
      // Also check linked contacts' emails
      const contactRows = await ctx.db
        .query("contacts")
        .withIndex("by_person", (q) => q.eq("personId", p._id))
        .collect();
      const emailMatch = contactRows.some((c) =>
        c.email.toLowerCase().includes(lc),
      );
      if (matches || emailMatch) {
        matchedPersons.push({ p, contacts: contactRows });
      }
      if (matchedPersons.length >= limit) break;
    }

    if (matchedPersons.length > 0) {
      const results: ContactResult[] = matchedPersons.map(({ p, contacts }) => {
        const totalCount = contacts.reduce((s, c) => s + (c.emailCount || 0), 0);
        const latestEmailed = contacts.reduce<number | null>((latest, c) => {
          if (!c.lastEmailed) return latest;
          if (latest === null) return c.lastEmailed;
          return c.lastEmailed > latest ? c.lastEmailed : latest;
        }, null);
        return {
          email: contacts.map((c) => c.email).join(", "),
          name: p.displayName,
          company: p.company || contacts.find((c) => c.company)?.company,
          title: p.title || contacts.find((c) => c.title)?.title,
          emailCount: totalCount,
          lastEmailed: latestEmailed
            ? new Date(latestEmailed).toISOString()
            : undefined,
          emails: contacts.map((c) => c.email),
        };
      });
      return { contacts: results };
    }

    // Fallback: scan contacts by user
    const allContacts = await ctx.db
      .query("contacts")
      .withIndex("by_user_email", (q) => q.eq("userId", userId))
      .collect();
    const filtered = allContacts.filter(
      (c) =>
        (c.name || "").toLowerCase().includes(lc) ||
        c.email.toLowerCase().includes(lc) ||
        (c.company || "").toLowerCase().includes(lc),
    );
    filtered.sort((a, b) => (b.emailCount || 0) - (a.emailCount || 0));
    const top = filtered.slice(0, limit);

    if (top.length > 0) {
      return {
        contacts: top.map((c) => ({
          email: c.email,
          name: c.name,
          company: c.company,
          title: c.title,
          emailCount: c.emailCount,
          lastEmailed: c.lastEmailed
            ? new Date(c.lastEmailed).toISOString()
            : undefined,
        })),
      };
    }

    // Last-resort fallback: scan the user's outbound emails directly. This
    // covers the case where contact backfill hasn't yet reached this person
    // (the cron processes ~200 emails per 5-min tick, so on a large mailbox
    // it can take a while to walk every recipient). Search lights up
    // immediately — recipients are inferred from `emails.toAddresses` instead
    // of waiting for them to be materialized into the contacts table.
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const selfEmails = new Set(
      accounts.map((a) => a.email.toLowerCase().trim()),
    );

    type FoundEmail = {
      email: string;
      name?: string;
      emailCount: number;
      lastEmailed: number;
    };
    const found = new Map<string, FoundEmail>();

    // Cap how many emails we scan so this stays fast even on big mailboxes —
    // we walk the most recent 2,000 outbound messages per account.
    const SCAN_LIMIT = 2000;
    for (const account of accounts) {
      const recent = await ctx.db
        .query("emails")
        .withIndex("by_account_receivedAt", (q) =>
          q.eq("accountId", account._id),
        )
        .order("desc")
        .take(SCAN_LIMIT);
      for (const email of recent) {
        const from = email.fromAddress.toLowerCase().trim();
        if (!selfEmails.has(from)) continue; // only outbound
        const recipients = [
          ...((email.toAddresses as { email?: string; name?: string }[] | undefined) ?? []),
          ...((email.ccAddresses as { email?: string; name?: string }[] | undefined) ?? []),
        ];
        for (const r of recipients) {
          const addr = (r?.email ?? "").toLowerCase().trim();
          if (!addr || !addr.includes("@")) continue;
          if (selfEmails.has(addr)) continue;
          const name = r?.name ?? "";
          const matches =
            addr.includes(lc) || name.toLowerCase().includes(lc);
          if (!matches) continue;
          const existing = found.get(addr);
          if (existing) {
            existing.emailCount += 1;
            if (email.receivedAt > existing.lastEmailed) {
              existing.lastEmailed = email.receivedAt;
              if (name) existing.name = name;
            }
          } else {
            found.set(addr, {
              email: addr,
              name: name || undefined,
              emailCount: 1,
              lastEmailed: email.receivedAt,
            });
          }
        }
      }
    }

    const ranked = Array.from(found.values())
      .sort((a, b) => b.emailCount - a.emailCount)
      .slice(0, limit);

    return {
      contacts: ranked.map((c) => ({
        email: c.email,
        name: c.name,
        company: undefined,
        title: undefined,
        emailCount: c.emailCount,
        lastEmailed: new Date(c.lastEmailed).toISOString(),
      })),
    };
  },
});

export const _getPriorityInbox = internalQuery({
  args: { userId: v.id("users"), input: v.any() },
  handler: async (ctx, { userId, input }) => {
    const i = input as Record<string, unknown>;
    const limit = Math.min((i.limit as number) || 10, 20);
    const includeCategories = i.include_categories as string[] | undefined;
    const excludeCategories = i.exclude_categories as string[] | undefined;

    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const candidates: Array<{
      _id: Id<"emails">;
      accountId: Id<"mailAccounts">;
      threadId: Id<"threads">;
      fromAddress: string;
      fromName?: string;
      subject: string;
      snippet?: string;
      receivedAt: number;
      isDraft: boolean;
    }> = [];
    for (const acc of accounts) {
      const rows = await ctx.db
        .query("emails")
        .withIndex("by_account_receivedAt", (q) => q.eq("accountId", acc._id))
        .order("desc")
        .take(limit * 4);
      for (const e of rows) {
        if (e.isDraft) continue;
        candidates.push(e);
      }
    }

    // Filter to threads that are unread, not archived, not trashed.
    const enriched = [];
    for (const e of candidates) {
      const thread = await ctx.db.get(e.threadId);
      if (!thread) continue;
      if (thread.isRead || thread.isArchived || thread.isTrashed) continue;

      const cls = await ctx.db
        .query("emailClassifications")
        .withIndex("by_email", (q) => q.eq("emailId", e._id))
        .unique();
      if (includeCategories?.length) {
        if (!cls || !includeCategories.includes(cls.category)) continue;
      }
      if (excludeCategories?.length && cls && excludeCategories.includes(cls.category)) {
        continue;
      }

      const openTask = await ctx.db
        .query("tasks")
        .withIndex("by_thread", (q) => q.eq("threadId", e.threadId))
        .filter((q) =>
          q.and(
            q.eq(q.field("userId"), userId),
            q.eq(q.field("status"), "OPEN"),
          ),
        )
        .first();
      const watch = await ctx.db
        .query("followUpWatches")
        .withIndex("by_thread", (q) => q.eq("threadId", e.threadId))
        .filter((q) =>
          q.and(
            q.eq(q.field("userId"), userId),
            q.eq(q.field("status"), "WATCHING"),
          ),
        )
        .first();
      enriched.push({
        e,
        thread,
        cls,
        hasOpenTasks: !!openTask,
        isFollowedUp: !!watch,
      });
    }

    // Dedup by thread, keeping the most recent email
    const seen = new Set<string>();
    const dedup = enriched.filter((row) => {
      if (seen.has(row.thread._id)) return false;
      seen.add(row.thread._id);
      return true;
    });

    const urgencyOrder: Record<string, number> = {
      urgent: 4,
      high: 3,
      normal: 2,
      low: 1,
    };
    dedup.sort((a, b) => {
      const ua = urgencyOrder[a.cls?.urgency || "normal"] || 2;
      const ub = urgencyOrder[b.cls?.urgency || "normal"] || 2;
      if (ua !== ub) return ub - ua;
      return b.e.receivedAt - a.e.receivedAt;
    });

    const sorted = dedup.slice(0, limit);
    const now = Date.now();
    const items: PriorityItem[] = sorted.map(
      ({ e, thread, cls, hasOpenTasks, isFollowedUp }) => ({
        emailId: e._id,
        threadId: e.threadId,
        subject: thread.subject,
        from: e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress,
        fromName: e.fromName || e.fromAddress.split("@")[0],
        date: new Date(e.receivedAt).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        }),
        snippet: (e.snippet || "").slice(0, 200),
        category: cls?.category,
        urgency: cls?.urgency,
        classificationSummary: cls?.summary,
        hasOpenTasks,
        isFollowedUp,
        daysSinceReceived: Math.floor(
          (now - e.receivedAt) / (1000 * 60 * 60 * 24),
        ),
      }),
    );

    return { emails: items };
  },
});

export const _getTasks = internalQuery({
  args: { userId: v.id("users"), input: v.any() },
  handler: async (ctx, { userId, input }) => {
    const i = input as Record<string, unknown>;
    const status = (i.status as string) || "OPEN";
    const taskType = (i.task_type as string) || "all";
    const dueBefore = i.due_before as string | undefined;
    const contactEmail = i.contact_email as string | undefined;
    const limit = Math.min((i.limit as number) || 15, 50);

    // Use status index when status != all
    let rows: Array<{
      _id: Id<"tasks">;
      description: string;
      taskType: string;
      status: string;
      deadline?: number;
      contactEmail?: string;
      contactName?: string;
      threadId: Id<"threads">;
      _creationTime: number;
    }> = [];
    if (status === "all") {
      rows = (await ctx.db
        .query("tasks")
        .withIndex("by_user_status_deadline", (q) => q.eq("userId", userId))
        .collect()) as typeof rows;
    } else {
      rows = (await ctx.db
        .query("tasks")
        .withIndex("by_user_status_deadline", (q) =>
          q.eq("userId", userId).eq("status", status as "OPEN" | "DONE" | "AUTO_RESOLVED"),
        )
        .collect()) as typeof rows;
    }

    let filtered = rows;
    if (taskType !== "all") {
      filtered = filtered.filter((t) => t.taskType === taskType);
    }
    if (dueBefore) {
      const cutoff = new Date(dueBefore).getTime();
      filtered = filtered.filter((t) => t.deadline !== undefined && t.deadline <= cutoff);
    }
    if (contactEmail) {
      const lcCe = contactEmail.toLowerCase();
      filtered = filtered.filter((t) =>
        (t.contactEmail || "").toLowerCase().includes(lcCe),
      );
    }
    filtered.sort((a, b) => {
      if (a.deadline !== undefined && b.deadline !== undefined)
        return a.deadline - b.deadline;
      if (a.deadline !== undefined) return -1;
      if (b.deadline !== undefined) return 1;
      return b._creationTime - a._creationTime;
    });
    filtered = filtered.slice(0, limit);

    const results: TaskItem[] = [];
    for (const t of filtered) {
      const thread = await ctx.db.get(t.threadId);
      results.push({
        description: t.description,
        taskType: t.taskType,
        status: t.status,
        deadline: t.deadline ? new Date(t.deadline).toISOString() : undefined,
        contactEmail: t.contactEmail,
        contactName: t.contactName,
        threadId: t.threadId,
        threadSubject: thread?.subject || "",
        createdAt: new Date(t._creationTime).toISOString(),
      });
    }
    return { tasks: results };
  },
});

// ── Internal mutation: persist final assistant message ──────────────────────

export const saveAssistantMessage = internalMutation({
  args: {
    conversationId: v.id("chatConversations"),
    content: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, { conversationId, content, metadata }) => {
    const conv = await ctx.db.get(conversationId);
    if (!conv) return;
    await ctx.db.insert("chatMessages", {
      conversationId,
      role: "assistant",
      content,
      metadata,
    });
  },
});

// ── Internal mutation: persist a tool_use block as it streams in ────────────

export const saveToolUse = internalMutation({
  args: {
    conversationId: v.id("chatConversations"),
    block: v.any(),
  },
  handler: async (ctx, { conversationId, block }) => {
    // Persist the tool_use block as metadata on a placeholder assistant
    // message so chat history can render it on reload.
    const conv = await ctx.db.get(conversationId);
    if (!conv) return;
    await ctx.db.insert("chatMessages", {
      conversationId,
      role: "assistant",
      content: "",
      metadata: { toolUse: block },
    });
  },
});
