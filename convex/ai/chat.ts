"use node";

// ─────────────────────────────────────────────────────────────────────────────
// chat.ts — port of services/ai/chat-assistant.ts.
//
// Exposes:
//   - `chat` action (non-streaming) — exact port of ChatAssistant.chat()
//   - internal helpers (queries/mutations) used by both this action and the
//     `streamChat` httpAction in convex/ai/http.ts:
//       - buildContext        (internal query)
//       - executeTool         (internal action — runs DB-backed tool handlers)
//       - saveAssistantMessage (internal mutation)
//
// Tool schemas + names are preserved exactly from chat-assistant.ts. Same
// system prompt, same loop limit (3), same DATA vs OUTPUT tool split.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { requireUser } from "../lib/auth";
import type { Id } from "../_generated/dataModel";

const MODEL = "claude-sonnet-4-6";
// 3 rounds is required because the system prompt instructs the model to
// chain `search_emails -> get_thread_detail -> answer`. Two rounds drops the
// final answer for that flow (the round-2 tool result never gets returned).
const MAX_TOOL_ROUNDS = 3;
const CHAT_MAX_TOKENS = 1536;
const TOOL_RESULT_MAX_CHARS = 6000;
const TOOL_RESULT_MAX_ITEMS = 8;
// Shared budget across streaming + non-streaming chat. Both call sites must
// log under the same feature key so a user can't double-spend by switching
// transports.
const CHAT_FEATURE_KEY = "chat";
const DAILY_CHAT_COST_LIMIT_USD = 5;

// ── Tool name sets ──────────────────────────────────────────────────────────

export const DATA_TOOL_NAMES = new Set([
  "search_emails",
  "get_thread_detail",
  "lookup_contact",
  "get_priority_inbox",
  "get_tasks_and_deadlines",
]);

export const OUTPUT_TOOL_NAMES = new Set([
  "generate_draft",
  "summarize_thread",
  "extract_action_items",
]);

// ── Base system prompt ──────────────────────────────────────────────────────

export const BASE_SYSTEM_PROMPT = `You are Orbi, an AI email intelligence assistant for a professional agency team.
You have deep access to the user's email, contacts, tasks, and classifications.

Capabilities:
- Search emails with rich filters (sender, recipient, date range, attachments, category, urgency)
- Read full thread contents to extract specific information (tracking numbers, prices, dates, etc.)
- Look up contacts by name, email, or company
- Prioritize unread emails by urgency and importance for triage
- Query open tasks, deadlines, and promises across all threads
- Draft, summarize, and extract action items from threads

Strategy:
- ALWAYS check the current thread context first if one is provided. The user is likely asking about the thread they are viewing. Answer directly from the context if possible.
- Only use search tools when the answer is NOT in the current thread context, or when the user explicitly asks about other emails.
- When asked to find specific data (tracking numbers, order numbers, prices, dates, amounts, codes), you MUST use get_thread_detail after search_emails to read the full thread content. Search result snippets are truncated and may not contain the specific data. Always read the full thread before answering.
- When asked about a person or client, look them up first to get their exact email, then search. Contact lookup and email search support fuzzy matching, so use them even if the user's spelling may be slightly off.
- When asked to triage or prioritize, use get_priority_inbox rather than searching.
- You can chain multiple tools: search → get_thread_detail → answer. This is the expected pattern for finding specific information. Don't stop at search results — read the thread.
- When the user asks "what should I respond to", use get_priority_inbox.
- When the user asks about deadlines or promises, use get_tasks_and_deadlines.
- When you need a recipient's email address and the user hasn't provided it (and it's not in the compose context), ALWAYS use lookup_contact to find matches rather than asking the user to type the email. If the user mentions a name like "Dorothy", look them up immediately. Only ask the user to type or clarify if lookup_contact returns zero results or too many ambiguous matches.
- When you find the answer, give it directly and concisely. Don't just describe what you found — extract and present the specific information the user asked for (e.g., the actual tracking number, not "the email contains tracking info").
- When searching for normal/user-actionable emails, exclude notification, marketing, and spam by default. Only include those categories if the user explicitly asks for notifications, calendar invites, marketing/newsletters, spam, or a specific excluded category.
- When searching, use targeted queries and low limits. If the user asks a specific question (e.g., "tracking number for X order"), search with limit 3-5, not 10. Only the relevant emails should appear in results.
- After finding the answer, mention only the specific emails that contained the answer. Do not show all search results — only the ones that matter.

Rules:
- Be concise and helpful. Match the user's energy — if they're brief, be brief.
- When drafting emails, follow the user's writing style preferences provided below. The Greeting and Sign-off values are MANDATORY — if the preferences say Greeting "Hey", every draft you produce must open with "Hey [Name]," never "Hi" or "Hello". Same for sign-off. Treat these as hard constraints, not suggestions.
- Internal team comments are PRIVATE — never quote, reference, or reveal them in client-facing email drafts.
- When you don't have enough context, ask clarifying questions rather than guessing.
- When drafting, return only the email body (no subject in body, no signature — those are added separately).
- Output drafts as plain HTML using ONLY tags that work reliably across Gmail / Outlook / Apple Mail and that survive the user's compose editor: <p>, <strong>, <em>, <a href="...">, <ul>, <ol>, <li>, and <table>/<thead>/<tbody>/<tr>/<th>/<td>. Do NOT use Markdown (no pipes, no asterisks, no backticks) — Markdown will not render in either the preview or the sent email. Do NOT use <br> between paragraphs; each paragraph must be its own <p>...</p> block.
- For tabular data (commission breakdowns, line items, comparisons), USE a real <table>. Required structure: <table style="border-collapse:collapse;margin:8px 0"> with <thead><tr><th style="border:1px solid #d0d4dc;padding:6px 10px;background:#f4f5f7;text-align:left">Header</th>...</tr></thead> and <tbody><tr><td style="border:1px solid #d0d4dc;padding:6px 10px">Cell</td>...</tr></tbody>. Always include inline styles on every <th> and <td> so the table renders the same in the compose preview and the recipient's email client (email clients strip <style> blocks; only inline styles survive).
- The HTML you return is rendered verbatim in BOTH the chat preview AND the user's compose editor. Whatever you produce is what the recipient sees. Do not produce decorative HTML the editor or recipient client can't render.
- If the user asks about the thread, refer to emails by sender name and date for clarity.
- This is an agency with multiple team members and shared threads. Be aware of team context.`;

// ── Tool definitions ────────────────────────────────────────────────────────

export const TOOLS: Anthropic.Tool[] = [
  // Output tools
  {
    name: "generate_draft",
    description:
      "Generate an email draft based on the user's instructions. Use this when the user asks you to write, draft, reply, compose, or respond to an email.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description:
            "Recipient email address(es). Infer from thread context if not specified.",
        },
        subject: {
          type: "string",
          description: "Email subject. Only set for new emails, not replies.",
        },
        thread_id: {
          type: "string",
          description:
            "Existing thread ID if this draft is a reply to a specific thread. Use the threadId returned by search/get_thread_detail when applicable.",
        },
        body: {
          type: "string",
          description:
            "The email body in HTML format. Follow the user's style preferences.",
        },
        greeting_used: {
          type: "string",
          description:
            'The greeting you used (e.g., "Hey Rachel", "Hi Tom"). Tracked for learning.',
        },
        signoff_used: {
          type: "string",
          description:
            'The sign-off you used (e.g., "Best", "Thanks"). Tracked for learning.',
        },
      },
      required: ["body"],
    },
  },
  {
    name: "summarize_thread",
    description:
      "Summarize the current email thread. Use when the user asks for a summary, overview, or recap.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "A concise 2-3 sentence summary of the thread.",
        },
        key_points: {
          type: "array",
          items: { type: "string" },
          description: "Key points or decisions from the thread.",
        },
        action_items: {
          type: "array",
          items: { type: "string" },
          description: "Any action items or next steps mentioned.",
        },
      },
      required: ["summary", "key_points"],
    },
  },
  {
    name: "extract_action_items",
    description:
      "Extract action items, todos, and deadlines from the thread. Use when the user asks about action items, todos, tasks, or deadlines.",
    input_schema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              assignee: {
                type: "string",
                description: "Who is responsible",
              },
              deadline: {
                type: "string",
                description: "Due date if mentioned",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
                description: "Current status based on thread context",
              },
            },
            required: ["description", "status"],
          },
          description: "List of action items extracted from the thread.",
        },
      },
      required: ["items"],
    },
  },

  // Data tools
  {
    name: "search_emails",
    description:
      'Search across ALL emails in the user\'s accounts. Use when the user asks to find something — e.g., "tracking number from DHL", "emails from Rachel about invoices", "did I mention a price to anyone". Supports rich filtering by sender, recipient, date, attachments, category, and urgency.',
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search keywords or phrases. Can be empty if using filters alone.",
        },
        from: { type: "string", description: "Filter by sender email or name. Fuzzy name matching is supported." },
        to: { type: "string", description: "Filter by recipient email or name. Fuzzy name matching is supported." },
        cc_only: {
          type: "boolean",
          description: "When true, only return emails where one of the user's addresses was CC'd. Use for requests like 'emails I am cc'd in'.",
        },
        date_from: {
          type: "string",
          description: 'Start date (ISO format, e.g. "2026-01-01").',
        },
        date_to: {
          type: "string",
          description: 'End date (ISO format, e.g. "2026-03-25").',
        },
        has_attachments: {
          type: "boolean",
          description: "Filter to only emails with attachments.",
        },
        sent_only: {
          type: "boolean",
          description: "Only return emails sent by the user (not received).",
        },
        unread_only: { type: "boolean", description: "Only return unread emails." },
        include_noise: {
          type: "boolean",
          description: "Set true only when the user explicitly asks for notifications, calendar invites, marketing/newsletters, spam, or other low-signal automated emails. Default false excludes those.",
        },
        category: {
          type: "string",
          description:
            "Filter by AI classification category: revision_request, billing, new_inquiry, project_update, meeting_scheduling, feedback, support_request, internal, notification, marketing, spam, other.",
        },
        urgency: {
          type: "string",
          description: "Filter by urgency level: low, normal, high, urgent.",
        },
        limit: {
          type: "number",
          description: "Max results to return. Default 10, max 25.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_thread_detail",
    description:
      "Read the full content of a specific email thread by its ID. Use after search_emails to read the details of a found thread — e.g., to extract a tracking number, specific price, or other detail from the conversation.",
    input_schema: {
      type: "object" as const,
      properties: {
        thread_id: { type: "string", description: "The thread ID to read." },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "lookup_contact",
    description:
      "Look up contacts by name, email, or company. Returns person-grouped results — each person may have multiple email addresses. Use to resolve ambiguous names to email addresses before searching, or when the user asks about a specific person/client.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Name, email address, or company to search for.",
        },
        limit: { type: "number", description: "Max results. Default 5." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_priority_inbox",
    description:
      'Get prioritized unread emails that need attention, sorted by urgency and importance. Use when the user asks "what should I respond to?", "what needs my attention?", "plan my day", or wants to triage their inbox.',
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max emails to return. Default 10, max 20.",
        },
        include_categories: {
          type: "array",
          items: { type: "string" },
          description:
            'Only include these categories (e.g., ["billing", "revision_request"]).',
        },
        exclude_categories: {
          type: "array",
          items: { type: "string" },
          description:
            'Exclude these categories (e.g., ["newsletter", "internal"]).',
        },
      },
      required: [],
    },
  },
  {
    name: "get_tasks_and_deadlines",
    description:
      "Query open tasks, promises, and deadlines across all threads. Use when the user asks about what they owe someone, upcoming deadlines, pending action items, or \"what's on my plate\".",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["OPEN", "DONE", "all"],
          description: 'Filter by status. Default "OPEN".',
        },
        task_type: {
          type: "string",
          enum: ["PROMISE", "DEADLINE", "CHANGE_REQUEST", "ACTION_ITEM", "all"],
          description: 'Filter by task type. Default "all".',
        },
        due_before: {
          type: "string",
          description:
            'Find tasks due before this date (ISO format). Useful for "this week" queries.',
        },
        contact_email: {
          type: "string",
          description: "Filter by associated contact email.",
        },
        limit: { type: "number", description: "Max results. Default 15." },
      },
      required: [],
    },
  },
];

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

interface ToolExecutionResult {
  toolUseId: string;
  content: string;
  sideEffects?: {
    searchResults?: SearchResult[];
    priorityInbox?: PriorityItem[];
    tasks?: TaskItem[];
    contactResults?: ContactResult[];
    threadReferences?: { id: string; subject: string }[];
  };
}

// ── Tool dispatcher (called from action loop) ───────────────────────────────

async function executeTool(
  ctx: { runQuery: ActionRunQuery; runAction: ActionRunAction },
  toolUse: { id: string; name: string; input: Record<string, unknown> },
  userId: Id<"users">,
): Promise<ToolExecutionResult> {
  const { id, name, input } = toolUse;

  switch (name) {
    case "search_emails": {
      let results = (await ctx.runQuery(
        internal.ai.chatData._searchEmails,
        { userId, input },
      )) as SearchResult[];

      // Provider fallback: local search only sees bodies for emails the user
      // has opened (lazy-body sync). If the model's query has a text payload
      // and local matches are sparse, hit Gmail/Graph full-text indexes and
      // import any new hits, then re-run the local query.
      const queryText = (input.query as string | undefined)?.trim();
      if (queryText && results.length < 5) {
        try {
          await ctx.runAction(api.searchProvider.searchViaProvider, {
            query: queryText,
            maxResults: 10,
          });
          results = (await ctx.runQuery(
            internal.ai.chatData._searchEmails,
            { userId, input },
          )) as SearchResult[];
        } catch (err) {
          console.warn("[chat] provider search fallback failed:", err);
        }
      }
      const refs = results.slice(0, 5).map((r) => ({
        id: r.threadId,
        subject: r.threadSubject,
      }));
      const seen = new Set<string>();
      const uniqueRefs = refs.filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
      return {
        toolUseId: id,
        content: compactToolJson(
          results.map((r) => ({
            threadId: r.threadId,
            emailId: r.emailId,
            subject: r.subject,
            from: r.from,
            date: r.date,
            snippet: r.snippet,
            category: r.category,
            urgency: r.urgency,
          })),
        ),
        sideEffects: { searchResults: results, threadReferences: uniqueRefs },
      };
    }
    case "get_thread_detail": {
      const result = await ctx.runQuery(internal.ai.chatData._getThreadDetail, {
        threadId: input.thread_id as string,
      });
      return { toolUseId: id, content: compactToolJson(result) };
    }
    case "lookup_contact": {
      const result = (await ctx.runQuery(
        internal.ai.chatData._lookupContact,
        { userId, input },
      )) as { contacts: ContactResult[] };
      return {
        toolUseId: id,
        content: compactToolJson(result.contacts),
        sideEffects: { contactResults: result.contacts },
      };
    }
    case "get_priority_inbox": {
      const result = (await ctx.runQuery(
        internal.ai.chatData._getPriorityInbox,
        { userId, input },
      )) as { emails: PriorityItem[] };
      return {
        toolUseId: id,
        content: compactToolJson(result.emails),
        sideEffects: { priorityInbox: result.emails },
      };
    }
    case "get_tasks_and_deadlines": {
      const result = (await ctx.runQuery(
        internal.ai.chatData._getTasks,
        { userId, input },
      )) as { tasks: TaskItem[] };
      return {
        toolUseId: id,
        content: compactToolJson(result.tasks),
        sideEffects: { tasks: result.tasks },
      };
    }
    default:
      return {
        toolUseId: id,
        content: JSON.stringify({ error: `Unknown tool: ${name}` }),
      };
  }
}

type ActionRunQuery = (...args: unknown[]) => Promise<unknown>;
type ActionRunAction = (...args: unknown[]) => Promise<unknown>;

// ── Output tool processing ──────────────────────────────────────────────────

// Compact tool output for the model. If the payload is an array, slice items
// and append a `_truncated` marker (keeps the JSON valid). For non-array
// payloads we fall back to a length check + best-effort string trim.
function compactToolJson(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length <= TOOL_RESULT_MAX_ITEMS) {
      const json = JSON.stringify(value);
      if (json.length <= TOOL_RESULT_MAX_CHARS) return json;
      // Long even with few items — keep first N items and signal truncation.
      const trimmed = value.slice(0, Math.max(1, Math.floor(TOOL_RESULT_MAX_ITEMS / 2)));
      return JSON.stringify({
        items: trimmed,
        _truncated: true,
        _reason: "payload_too_large",
        _omitted: value.length - trimmed.length,
      });
    }
    const trimmed = value.slice(0, TOOL_RESULT_MAX_ITEMS);
    return JSON.stringify({
      items: trimmed,
      _truncated: true,
      _reason: "too_many_items",
      _omitted: value.length - trimmed.length,
    });
  }
  const json = JSON.stringify(value);
  if (json.length <= TOOL_RESULT_MAX_CHARS) return json;
  return JSON.stringify({
    _truncated: true,
    _reason: "payload_too_large",
    preview: json.slice(0, TOOL_RESULT_MAX_CHARS - 200),
  });
}

async function recordAiUsage(
  ctx: { runMutation: (...args: unknown[]) => Promise<unknown> },
  args: {
    userId: Id<"users">;
    feature: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    providerCallCount?: number;
    requestId?: string;
    metadata?: unknown;
  },
) {
  try {
    await ctx.runMutation(internal.ai.usageData._record, {
      userId: args.userId,
      feature: args.feature,
      model: MODEL,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cacheCreationInputTokens: args.cacheCreationInputTokens,
      cacheReadInputTokens: args.cacheReadInputTokens,
      providerCallCount: args.providerCallCount ?? 1,
      requestId: args.requestId,
      metadata: args.metadata,
    });
  } catch {
    // Usage logging should never break the user flow.
  }
}


function processOutputTool(
  name: string,
  input: Record<string, unknown>,
  primaryRecipient: string | null | undefined,
  threadId: string | null,
): {
  reply: string;
  draft?: {
    to?: string;
    subject?: string;
    body: string;
    threadId?: string;
    greetingUsed?: string;
    signoffUsed?: string;
  };
} {
  if (name === "generate_draft") {
    // Models sometimes return placeholders like "current" instead of a real
    // thread id; only trust values that look like a Convex Id, otherwise fall
    // back to the contextual thread.
    const rawThreadId = input.thread_id;
    const aiThreadId =
      typeof rawThreadId === "string" && /^[a-z0-9]{20,}$/i.test(rawThreadId)
        ? rawThreadId
        : null;
    return {
      reply: "Here's a draft for you:",
      draft: {
        to: (input.to as string) || primaryRecipient || undefined,
        subject: input.subject as string | undefined,
        body: input.body as string,
        threadId: aiThreadId || threadId || undefined,
        greetingUsed: input.greeting_used as string | undefined,
        signoffUsed: input.signoff_used as string | undefined,
      },
    };
  }
  if (name === "summarize_thread") {
    const summary = input.summary as string;
    const keyPoints = input.key_points as string[];
    const actionItems = (input.action_items as string[]) || [];
    let text = `**Summary**\n${summary}\n\n**Key Points**\n${keyPoints.map((p) => `• ${p}`).join("\n")}`;
    if (actionItems.length > 0) {
      text += `\n\n**Action Items**\n${actionItems.map((a) => `• ${a}`).join("\n")}`;
    }
    return { reply: text };
  }
  if (name === "extract_action_items") {
    const items = input.items as Array<{
      description: string;
      assignee?: string;
      deadline?: string;
      status: string;
    }>;
    const statusLabel: Record<string, string> = {
      done: "[done]",
      in_progress: "[in progress]",
      pending: "[pending]",
    };
    const text = `**Action Items**\n${items
      .map((item) => {
        let line = `${statusLabel[item.status] || "[?]"} ${item.description}`;
        if (item.assignee) line += ` — ${item.assignee}`;
        if (item.deadline) line += ` (due: ${item.deadline})`;
        return line;
      })
      .join("\n")}`;
    return { reply: text };
  }
  return { reply: "" };
}

// ── Public action: non-streaming chat ───────────────────────────────────────

export const chat = action({
  args: {
    message: v.string(),
    messages: v.optional(
      v.array(
        v.object({
          role: v.union(v.literal("user"), v.literal("assistant")),
          content: v.string(),
        }),
      ),
    ),
    threadId: v.optional(v.id("threads")),
    accountId: v.optional(v.id("mailAccounts")),
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
    const userId = await requireUser(ctx);

    if (!args.message.trim()) {
      throw new Error("Message is required");
    }

    const ctxResult: {
      systemPrompt: string;
      primaryRecipient: string | null;
      correctionsApplied: number;
    } = await ctx.runQuery(internal.ai.chatData.buildContext, {
      threadId: args.threadId,
      accountId: args.accountId,
      userId,
      scope: args.scope,
      composeContext: args.composeContext,
    });

    const dailyUsage = (await ctx.runQuery(internal.ai.usageData._dailyUsage, {
      userId,
      feature: CHAT_FEATURE_KEY,
    })) as { estimatedCostUsd: number };
    if (dailyUsage.estimatedCostUsd >= DAILY_CHAT_COST_LIMIT_USD) {
      return {
        reply: "You've hit today's AI chat budget. Try again tomorrow or raise the daily limit in the backend settings.",
      };
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const userMessages = [
      ...(args.messages || []),
      { role: "user" as const, content: args.message.trim() },
    ];
    let messages: Anthropic.MessageParam[] = userMessages
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    let reply = "";
    let draft:
      | {
          to?: string;
          subject?: string;
          body: string;
          threadId?: string;
          greetingUsed?: string;
          signoffUsed?: string;
        }
      | undefined;
    let searchResults: SearchResult[] | undefined;
    let priorityInbox: PriorityItem[] | undefined;
    let tasks: TaskItem[] | undefined;
    let contactResults: ContactResult[] | undefined;
    let threadReferences: { id: string; subject: string }[] | undefined;

    // Cache the system prompt and the TOOLS schema (~9 KB). Two breakpoints:
    //   BP1 caches the system prompt across same-thread/same-scope follow-ups
    //   BP2 caches the system prompt + TOOLS together
    // Within a single chat session BP2 hits on every subsequent round and
    // every follow-up question, cutting input-token cost ~90% and shaving
    // most of the per-call request egress to Anthropic.
    const cachedSystem: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: ctxResult.systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ];
    const cachedTools: Anthropic.Tool[] = TOOLS.map((tool, idx) =>
      idx === TOOLS.length - 1
        ? { ...tool, cache_control: { type: "ephemeral" } }
        : tool,
    );

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: CHAT_MAX_TOKENS,
        system: cachedSystem,
        messages,
        tools: cachedTools,
        // Tag every Anthropic call with our internal user id so the Anthropic
        // Console line items can be traced back to a row in `aiUsageLogs`.
        metadata: { user_id: String(userId) },
      });
      await recordAiUsage(
        ctx as unknown as { runMutation: (...args: unknown[]) => Promise<unknown> },
        {
          userId,
          feature: CHAT_FEATURE_KEY,
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? undefined,
          cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? undefined,
          providerCallCount: 1,
          requestId: response.id,
          metadata: {
            round,
            transport: "sync",
            stopReason: response.stop_reason,
            truncated: response.stop_reason === "max_tokens",
          },
        },
      );

      const textBlocks: string[] = [];
      const toolUses: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];

      for (const block of response.content) {
        if (block.type === "text") {
          textBlocks.push(block.text);
        } else if (block.type === "tool_use") {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      const outputToolUses = toolUses.filter((t) => OUTPUT_TOOL_NAMES.has(t.name));
      if (outputToolUses.length > 0) {
        const result = processOutputTool(
          outputToolUses[0].name,
          outputToolUses[0].input,
          ctxResult.primaryRecipient,
          args.threadId ?? null,
        );
        reply = result.reply;
        draft = result.draft;
        break;
      }

      if (toolUses.length === 0) {
        reply = textBlocks.join("");
        break;
      }

      const dataToolUses = toolUses.filter((t) => DATA_TOOL_NAMES.has(t.name));
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of dataToolUses) {
        const result: ToolExecutionResult = await executeTool(
          ctx as unknown as { runQuery: ActionRunQuery; runAction: ActionRunAction },
          tu,
          userId,
        );
        if (result.sideEffects?.searchResults)
          searchResults = result.sideEffects.searchResults;
        if (result.sideEffects?.priorityInbox)
          priorityInbox = result.sideEffects.priorityInbox;
        if (result.sideEffects?.tasks) tasks = result.sideEffects.tasks;
        if (result.sideEffects?.contactResults)
          contactResults = result.sideEffects.contactResults;
        if (result.sideEffects?.threadReferences)
          threadReferences = result.sideEffects.threadReferences;
        toolResults.push({
          type: "tool_result",
          tool_use_id: result.toolUseId,
          content: result.content,
        });
      }

      messages = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults },
      ];

      if (round === MAX_TOOL_ROUNDS - 1) {
        reply =
          textBlocks.join("") ||
          "I found some results but couldn't fully process them.";
      }
    }

    return {
      reply: reply || "I'm not sure how to help with that. Could you rephrase?",
      draft,
      searchResults,
      priorityInbox,
      tasks,
      contactResults,
      threadReferences,
    };
  },
});

// ── Internal action: tool runner used by streaming http action ──────────────
// Keeps tool execution centralized so the http action can call out via
// ctx.runAction without duplicating dispatch logic.

export const runTool = internalAction({
  args: {
    userId: v.id("users"),
    toolUseId: v.string(),
    toolName: v.string(),
    toolInput: v.any(),
  },
  handler: async (ctx, { userId, toolUseId, toolName, toolInput }) => {
    return await executeTool(
      ctx as unknown as { runQuery: ActionRunQuery; runAction: ActionRunAction },
      {
        id: toolUseId,
        name: toolName,
        input: toolInput as Record<string, unknown>,
      },
      userId,
    );
  },
});

// (saveAssistantMessage and saveToolUse moved to convex/ai/chatData.ts —
//  internalMutations cannot live in a node-runtime file.)
