import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { buildThreadContext } from './thread-context.js';
import { buildStyleContext } from './style-context.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_ROUNDS = 3;

// ── Data tools (results go back to Claude for further reasoning) ──
const DATA_TOOL_NAMES = new Set([
  'search_emails',
  'get_thread_detail',
  'lookup_contact',
  'get_priority_inbox',
  'get_tasks_and_deadlines',
]);

// ── Output tools (produce final user-facing content) ──
const OUTPUT_TOOL_NAMES = new Set([
  'generate_draft',
  'summarize_thread',
  'extract_action_items',
]);

const BASE_SYSTEM_PROMPT = `You are Orbi, an AI email intelligence assistant for a professional agency team.
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
- When asked about a person or client, look them up first to get their exact email, then search.
- When asked to triage or prioritize, use get_priority_inbox rather than searching.
- You can chain multiple tools: search → get_thread_detail → answer. This is the expected pattern for finding specific information. Don't stop at search results — read the thread.
- When the user asks "what should I respond to", use get_priority_inbox.
- When the user asks about deadlines or promises, use get_tasks_and_deadlines.
- When you need a recipient's email address and the user hasn't provided it (and it's not in the compose context), ALWAYS use lookup_contact to find matches rather than asking the user to type the email. If the user mentions a name like "Dorothy", look them up immediately. Only ask the user to type or clarify if lookup_contact returns zero results or too many ambiguous matches.
- When you find the answer, give it directly and concisely. Don't just describe what you found — extract and present the specific information the user asked for (e.g., the actual tracking number, not "the email contains tracking info").
- When searching, use targeted queries and low limits. If the user asks a specific question (e.g., "tracking number for X order"), search with limit 3-5, not 10. Only the relevant emails should appear in results.
- After finding the answer, mention only the specific emails that contained the answer. Do not show all search results — only the ones that matter.

Rules:
- Be concise and helpful. Match the user's energy — if they're brief, be brief.
- When drafting emails, follow the user's writing style preferences provided below.
- Internal team comments are PRIVATE — never quote, reference, or reveal them in client-facing email drafts.
- When you don't have enough context, ask clarifying questions rather than guessing.
- When drafting, return only the email body (no subject in body, no signature — those are added separately).
- Use HTML formatting for drafts. Each paragraph must be its own <p>...</p> block — do NOT use <br> between paragraphs. Use <ul>/<ol> for lists.
- If the user asks about the thread, refer to emails by sender name and date for clarity.
- This is an agency with multiple team members and shared threads. Be aware of team context.`;

// ── Tool definitions ──

const TOOLS: Anthropic.Tool[] = [
  // Output tools
  {
    name: 'generate_draft',
    description:
      "Generate an email draft based on the user's instructions. Use this when the user asks you to write, draft, reply, compose, or respond to an email.",
    input_schema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description:
            'Recipient email address(es). Infer from thread context if not specified.',
        },
        subject: {
          type: 'string',
          description: 'Email subject. Only set for new emails, not replies.',
        },
        body: {
          type: 'string',
          description:
            "The email body in HTML format. Follow the user's style preferences.",
        },
        greeting_used: {
          type: 'string',
          description:
            'The greeting you used (e.g., "Hey Rachel", "Hi Tom"). Tracked for learning.',
        },
        signoff_used: {
          type: 'string',
          description:
            'The sign-off you used (e.g., "Best", "Thanks"). Tracked for learning.',
        },
      },
      required: ['body'],
    },
  },
  {
    name: 'summarize_thread',
    description:
      'Summarize the current email thread. Use when the user asks for a summary, overview, or recap.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description: 'A concise 2-3 sentence summary of the thread.',
        },
        key_points: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key points or decisions from the thread.',
        },
        action_items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Any action items or next steps mentioned.',
        },
      },
      required: ['summary', 'key_points'],
    },
  },
  {
    name: 'extract_action_items',
    description:
      'Extract action items, todos, and deadlines from the thread. Use when the user asks about action items, todos, tasks, or deadlines.',
    input_schema: {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              assignee: {
                type: 'string',
                description: 'Who is responsible',
              },
              deadline: {
                type: 'string',
                description: 'Due date if mentioned',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'done'],
                description: 'Current status based on thread context',
              },
            },
            required: ['description', 'status'],
          },
          description: 'List of action items extracted from the thread.',
        },
      },
      required: ['items'],
    },
  },

  // Data tools
  {
    name: 'search_emails',
    description:
      'Search across ALL emails in the user\'s accounts. Use when the user asks to find something — e.g., "tracking number from DHL", "emails from Rachel about invoices", "did I mention a price to anyone". Supports rich filtering by sender, recipient, date, attachments, category, and urgency.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Search keywords or phrases. Can be empty if using filters alone.',
        },
        from: {
          type: 'string',
          description: 'Filter by sender email or name.',
        },
        to: {
          type: 'string',
          description: 'Filter by recipient email or name.',
        },
        date_from: {
          type: 'string',
          description: 'Start date (ISO format, e.g. "2026-01-01").',
        },
        date_to: {
          type: 'string',
          description: 'End date (ISO format, e.g. "2026-03-25").',
        },
        has_attachments: {
          type: 'boolean',
          description: 'Filter to only emails with attachments.',
        },
        sent_only: {
          type: 'boolean',
          description:
            'Only return emails sent by the user (not received).',
        },
        unread_only: {
          type: 'boolean',
          description: 'Only return unread emails.',
        },
        category: {
          type: 'string',
          description:
            'Filter by AI classification category: revision_request, billing, new_inquiry, project_update, meeting_scheduling, feedback, support_request, internal, newsletter, other.',
        },
        urgency: {
          type: 'string',
          description:
            'Filter by urgency level: low, normal, high, urgent.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return. Default 10, max 25.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_thread_detail',
    description:
      'Read the full content of a specific email thread by its ID. Use after search_emails to read the details of a found thread — e.g., to extract a tracking number, specific price, or other detail from the conversation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        thread_id: {
          type: 'string',
          description: 'The thread ID to read.',
        },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'lookup_contact',
    description:
      'Look up contacts by name, email, or company. Returns person-grouped results — each person may have multiple email addresses. Use to resolve ambiguous names to email addresses before searching, or when the user asks about a specific person/client.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Name, email address, or company to search for.',
        },
        limit: {
          type: 'number',
          description: 'Max results. Default 5.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_priority_inbox',
    description:
      'Get prioritized unread emails that need attention, sorted by urgency and importance. Use when the user asks "what should I respond to?", "what needs my attention?", "plan my day", or wants to triage their inbox.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max emails to return. Default 10, max 20.',
        },
        include_categories: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only include these categories (e.g., ["billing", "revision_request"]).',
        },
        exclude_categories: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Exclude these categories (e.g., ["newsletter", "internal"]).',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_tasks_and_deadlines',
    description:
      'Query open tasks, promises, and deadlines across all threads. Use when the user asks about what they owe someone, upcoming deadlines, pending action items, or "what\'s on my plate".',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['OPEN', 'DONE', 'all'],
          description: 'Filter by status. Default "OPEN".',
        },
        task_type: {
          type: 'string',
          enum: ['PROMISE', 'DEADLINE', 'CHANGE_REQUEST', 'ACTION_ITEM', 'all'],
          description: 'Filter by task type. Default "all".',
        },
        due_before: {
          type: 'string',
          description:
            'Find tasks due before this date (ISO format). Useful for "this week" queries.',
        },
        contact_email: {
          type: 'string',
          description: 'Filter by associated contact email.',
        },
        limit: {
          type: 'number',
          description: 'Max results. Default 15.',
        },
      },
      required: [],
    },
  },
];

// ── Interfaces ──

interface ChatParams {
  messages: { role: 'user' | 'assistant'; content: string }[];
  threadId: string | null;
  accountId: string | null;
  userId: string;
  scope?: 'thread' | 'all';
  composeContext?: {
    to: string;
    subject: string;
    body: string;
    mode: string;
    threadId?: string;
  };
}

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

interface ChatResponse {
  reply: string;
  threadReferences?: { id: string; subject: string }[];
  searchResults?: SearchResult[];
  priorityInbox?: PriorityItem[];
  tasks?: TaskItem[];
  contactResults?: ContactResult[];
  draft?: {
    to?: string;
    subject?: string;
    body: string;
    threadId?: string;
    greetingUsed?: string;
    signoffUsed?: string;
  };
}

// ── ChatAssistant ──

export class ChatAssistant {
  private client: Anthropic;

  constructor(private prisma: PrismaClient) {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  // ── Context building ──

  private async buildContext(params: ChatParams) {
    const systemParts: string[] = [BASE_SYSTEM_PROMPT];
    let primaryRecipient: string | undefined;

    // Thread context (when viewing a specific thread)
    if (params.threadId) {
      const { contextText, participantEmails } = await buildThreadContext(
        this.prisma,
        params.threadId,
      );
      if (contextText) {
        systemParts.push(`\n\n## Current Thread Context\n${contextText}`);
        primaryRecipient = participantEmails.find(
          (e) => !e.endsWith('@orbi.agency'),
        );
      }
    }

    // Scope hint (soft guidance, not tool gating)
    if (params.scope === 'all' && params.threadId) {
      systemParts.push(
        '\n\n## Mode: All Emails (with thread context)\nThe user is searching across ALL their emails but is currently viewing a specific thread (context above). IMPORTANT: Check the thread context first — the answer may already be there. If the question is about the current thread, answer directly from the context. Only use search tools if the question is about OTHER emails not in the current thread.',
      );
    } else if (params.scope === 'all') {
      systemParts.push(
        '\n\n## Mode: All Emails\nThe user is searching across ALL their emails. Use search, contact lookup, priority inbox, and task tools as needed.',
      );
    } else if (params.threadId) {
      systemParts.push(
        '\n\n## Mode: Thread Focus\nThe user is focused on a specific thread (context above). IMPORTANT: Always check the thread context first before using any search tools. The answer to the user\'s question is very likely in the thread they are currently viewing. Only use search tools if the user explicitly asks about something outside this thread.',
      );
    }

    // Compose context (when user has an email compose panel open)
    if (params.composeContext) {
      const cc = params.composeContext;
      const parts = ['\n\n## Active Compose Context\nThe user currently has an email compose window open with the following:'];
      if (cc.to) parts.push(`- To: ${cc.to}`);
      if (cc.subject) parts.push(`- Subject: ${cc.subject}`);
      if (cc.body) parts.push(`- Body draft: ${cc.body.substring(0, 500)}`);
      parts.push(`- Mode: ${cc.mode}`);
      parts.push('\nWhen the user asks about drafting, composing, or emailing someone, USE this context. Do not ask for information already present here (e.g., do not ask for the email address if it is in the "To" field). If generating a draft, use the To and Subject from this context unless the user specifies otherwise.');
      systemParts.push(parts.join('\n'));
    }

    // Sender identity + all account emails (so AI knows what user sent)
    const accounts = await this.prisma.account.findMany({
      where: { userId: params.userId },
      select: { id: true, email: true, displayName: true },
    });
    if (accounts.length > 0) {
      const activeAccount = params.accountId
        ? accounts.find((a) => a.id === params.accountId)
        : accounts[0];
      if (activeAccount) {
        systemParts.push(
          `\n\n## Sender Identity\nYou are drafting on behalf of: ${activeAccount.displayName || activeAccount.email} (${activeAccount.email})`,
        );
      }
      const allEmails = accounts.map((a) => a.email);
      systemParts.push(
        `\n\n## User's Email Addresses\nThe user owns these email addresses: ${allEmails.join(', ')}. Emails FROM these addresses were sent by the user.`,
      );
    }

    // Style context
    const styleResult = await buildStyleContext(
      this.prisma,
      params.userId,
      primaryRecipient,
    );
    systemParts.push(`\n\n${styleResult.contextText}`);

    const system = systemParts.join('');
    const recentMessages = params.messages.slice(-20).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    return { system, recentMessages, primaryRecipient, accounts, correctionsApplied: styleResult.correctionCount };
  }

  // ── Data tool handlers ──

  private async handleSearchEmails(
    input: Record<string, unknown>,
    userId: string,
  ): Promise<{ results: SearchResult[] }> {
    const query = (input.query as string) || '';
    const from = input.from as string | undefined;
    const to = input.to as string | undefined;
    const dateFrom = input.date_from as string | undefined;
    const dateTo = input.date_to as string | undefined;
    const hasAttachments = input.has_attachments as boolean | undefined;
    const sentOnly = input.sent_only as boolean | undefined;
    const unreadOnly = input.unread_only as boolean | undefined;
    const category = input.category as string | undefined;
    const urgency = input.urgency as string | undefined;
    const limit = Math.min((input.limit as number) || 10, 25);

    // Build where clause
    const where: Record<string, unknown> = {
      account: { userId },
    };

    // Text search — search bodyText, bodyHtml, subject, snippet, and fromName
    if (query) {
      where.OR = [
        { bodyText: { contains: query, mode: 'insensitive' } },
        { bodyHtml: { contains: query, mode: 'insensitive' } },
        { subject: { contains: query, mode: 'insensitive' } },
        { snippet: { contains: query, mode: 'insensitive' } },
        { fromName: { contains: query, mode: 'insensitive' } },
      ];
    }

    // From filter
    if (from) {
      // Search both fromAddress and fromName
      const fromConditions = [
        { fromAddress: { contains: from, mode: 'insensitive' } },
        { fromName: { contains: from, mode: 'insensitive' } },
      ];
      if (where.OR) {
        // Combine with text search using AND
        where.AND = [{ OR: where.OR }, { OR: fromConditions }];
        delete where.OR;
      } else {
        where.OR = fromConditions;
      }
    }

    // To filter — search thread participantEmails
    if (to) {
      where.thread = {
        ...((where.thread as Record<string, unknown>) || {}),
        participantEmails: { has: to },
      };
      // If "to" is a name rather than email, we also need to search toAddresses JSON
      // For now, also try a raw string search on the stringified toAddresses
      // The participantEmails approach works for exact email matches
    }

    // Date range
    const receivedAt: Record<string, unknown> = {};
    if (dateFrom) receivedAt.gte = new Date(dateFrom);
    if (dateTo) {
      const endDate = new Date(dateTo);
      endDate.setHours(23, 59, 59, 999);
      receivedAt.lte = endDate;
    }
    if (Object.keys(receivedAt).length > 0) where.receivedAt = receivedAt;

    // Attachments
    if (hasAttachments) where.hasAttachments = true;

    // Sent only — match fromAddress against user's account emails
    if (sentOnly) {
      const accounts = await this.prisma.account.findMany({
        where: { userId },
        select: { email: true },
      });
      const userEmails = accounts.map((a) => a.email);
      where.fromAddress = { in: userEmails };
    }

    // Unread only
    if (unreadOnly) {
      where.thread = {
        ...((where.thread as Record<string, unknown>) || {}),
        isRead: false,
      };
    }

    // Classification filters
    if (category || urgency) {
      const classificationFilter: Record<string, unknown> = {};
      if (category) classificationFilter.category = category;
      if (urgency) classificationFilter.urgency = urgency;
      where.classification = classificationFilter;
    }

    const emails = await this.prisma.email.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        fromAddress: true,
        fromName: true,
        toAddresses: true,
        subject: true,
        snippet: true,
        bodyText: true,
        receivedAt: true,
        threadId: true,
        hasAttachments: true,
        thread: { select: { subject: true } },
        classification: {
          select: { category: true, urgency: true },
        },
      },
    });

    const results: SearchResult[] = emails.map((e) => ({
      emailId: e.id,
      threadId: e.threadId,
      threadSubject: e.thread.subject,
      from: e.fromName
        ? `${e.fromName} <${e.fromAddress}>`
        : e.fromAddress,
      fromName: e.fromName || e.fromAddress.split('@')[0],
      subject: e.subject,
      date: e.receivedAt.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }),
      snippet: (e.bodyText || e.snippet || '').slice(0, 500),
      category: e.classification?.category,
      urgency: e.classification?.urgency,
    }));

    return { results };
  }

  private async handleGetThreadDetail(
    input: Record<string, unknown>,
  ): Promise<{
    contextText: string;
    subject: string;
    messageCount: number;
    participantEmails: string[];
    lastMessageAt: string;
  }> {
    const threadId = input.thread_id as string;
    const { contextText, thread, participantEmails } =
      await buildThreadContext(this.prisma, threadId);

    return {
      contextText: contextText || 'Thread not found or empty.',
      subject: thread?.subject || 'Unknown',
      messageCount: thread?.messageCount || 0,
      participantEmails,
      lastMessageAt: thread?.lastMessageAt?.toISOString() || '',
    };
  }

  private async handleLookupContact(
    input: Record<string, unknown>,
    userId: string,
  ): Promise<{ contacts: ContactResult[] }> {
    const query = input.query as string;
    const limit = Math.min((input.limit as number) || 5, 20);

    // Search at the Person level first for grouped results
    const persons = await this.prisma.person.findMany({
      where: {
        userId,
        OR: [
          { displayName: { contains: query, mode: 'insensitive' } },
          { company: { contains: query, mode: 'insensitive' } },
          { contacts: { some: { email: { contains: query, mode: 'insensitive' } } } },
        ],
      },
      take: limit,
      include: {
        contacts: {
          select: {
            email: true,
            name: true,
            company: true,
            title: true,
            emailCount: true,
            lastEmailed: true,
          },
          orderBy: { emailCount: 'desc' },
        },
      },
    });

    if (persons.length > 0) {
      // Return person-grouped results
      const results: ContactResult[] = [];
      for (const p of persons) {
        const totalCount = p.contacts.reduce((s, c) => s + c.emailCount, 0);
        const latestEmailed = p.contacts.reduce((latest: Date | null, c) => {
          if (!c.lastEmailed) return latest;
          if (!latest) return c.lastEmailed;
          return c.lastEmailed > latest ? c.lastEmailed : latest;
        }, null);

        results.push({
          email: p.contacts.map((c) => c.email).join(', '),
          name: p.displayName || undefined,
          company: p.company || p.contacts.find((c) => c.company)?.company || undefined,
          title: p.title || p.contacts.find((c) => c.title)?.title || undefined,
          emailCount: totalCount,
          lastEmailed: latestEmailed?.toISOString(),
          emails: p.contacts.map((c) => c.email),
        });
      }
      return { contacts: results };
    }

    // Fallback: search contacts directly (for orphan contacts without a person)
    const contacts = await this.prisma.contact.findMany({
      where: {
        userId,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
          { company: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { emailCount: 'desc' },
      take: limit,
      select: {
        email: true,
        name: true,
        company: true,
        title: true,
        emailCount: true,
        lastEmailed: true,
      },
    });

    return {
      contacts: contacts.map((c) => ({
        email: c.email,
        name: c.name || undefined,
        company: c.company || undefined,
        title: c.title || undefined,
        emailCount: c.emailCount,
        lastEmailed: c.lastEmailed?.toISOString(),
      })),
    };
  }

  private async handleGetPriorityInbox(
    input: Record<string, unknown>,
    userId: string,
  ): Promise<{ emails: PriorityItem[] }> {
    const limit = Math.min((input.limit as number) || 10, 20);
    const includeCategories = input.include_categories as string[] | undefined;
    const excludeCategories = input.exclude_categories as string[] | undefined;

    // Build where clause for unread, non-archived, non-trashed emails
    const emailWhere: Record<string, unknown> = {
      account: { userId },
      thread: {
        isRead: false,
        isArchived: false,
        isTrashed: false,
      },
      isDraft: false,
    };

    // Category filters on classification
    if (includeCategories?.length || excludeCategories?.length) {
      const classificationFilter: Record<string, unknown> = {};
      if (includeCategories?.length) {
        classificationFilter.category = { in: includeCategories };
      }
      if (excludeCategories?.length) {
        classificationFilter.category = {
          ...((classificationFilter.category as Record<string, unknown>) || {}),
          notIn: excludeCategories,
        };
      }
      emailWhere.classification = classificationFilter;
    }

    const emails = await this.prisma.email.findMany({
      where: emailWhere,
      orderBy: { receivedAt: 'desc' },
      take: limit * 2, // Fetch extra for dedup by thread
      select: {
        id: true,
        fromAddress: true,
        fromName: true,
        subject: true,
        snippet: true,
        receivedAt: true,
        threadId: true,
        thread: {
          select: {
            subject: true,
            tasks: {
              where: { userId, status: 'OPEN' },
              select: { id: true },
              take: 1,
            },
            followUpWatches: {
              where: { userId, status: 'WATCHING' },
              select: { id: true },
              take: 1,
            },
          },
        },
        classification: {
          select: { category: true, urgency: true, summary: true },
        },
      },
    });

    // Dedup by thread (keep most recent email per thread)
    const seenThreads = new Set<string>();
    const dedupedEmails = emails.filter((e) => {
      if (seenThreads.has(e.threadId)) return false;
      seenThreads.add(e.threadId);
      return true;
    });

    // Sort by urgency then recency
    const urgencyOrder: Record<string, number> = {
      urgent: 4,
      high: 3,
      normal: 2,
      low: 1,
    };

    const sorted = dedupedEmails
      .map((e) => ({
        ...e,
        urgencyScore: urgencyOrder[e.classification?.urgency || 'normal'] || 2,
      }))
      .sort(
        (a, b) =>
          b.urgencyScore - a.urgencyScore ||
          b.receivedAt.getTime() - a.receivedAt.getTime(),
      )
      .slice(0, limit);

    const now = Date.now();
    const items: PriorityItem[] = sorted.map((e) => ({
      emailId: e.id,
      threadId: e.threadId,
      subject: e.thread.subject,
      from: e.fromName
        ? `${e.fromName} <${e.fromAddress}>`
        : e.fromAddress,
      fromName: e.fromName || e.fromAddress.split('@')[0],
      date: e.receivedAt.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }),
      snippet: (e.snippet || '').slice(0, 200),
      category: e.classification?.category,
      urgency: e.classification?.urgency,
      classificationSummary: e.classification?.summary || undefined,
      hasOpenTasks: (e.thread.tasks?.length || 0) > 0,
      isFollowedUp: (e.thread.followUpWatches?.length || 0) > 0,
      daysSinceReceived: Math.floor(
        (now - e.receivedAt.getTime()) / (1000 * 60 * 60 * 24),
      ),
    }));

    return { emails: items };
  }

  private async handleGetTasksAndDeadlines(
    input: Record<string, unknown>,
    userId: string,
  ): Promise<{ tasks: TaskItem[] }> {
    const status = (input.status as string) || 'OPEN';
    const taskType = (input.task_type as string) || 'all';
    const dueBefore = input.due_before as string | undefined;
    const contactEmail = input.contact_email as string | undefined;
    const limit = Math.min((input.limit as number) || 15, 50);

    const where: Record<string, unknown> = { userId };

    if (status !== 'all') {
      where.status = status;
    }
    if (taskType !== 'all') {
      where.taskType = taskType;
    }
    if (dueBefore) {
      where.deadline = { lte: new Date(dueBefore) };
    }
    if (contactEmail) {
      where.contactEmail = { contains: contactEmail, mode: 'insensitive' };
    }

    const tasks = await this.prisma.task.findMany({
      where,
      orderBy: [{ deadline: 'asc' }, { createdAt: 'desc' }],
      take: limit,
      include: {
        thread: { select: { subject: true } },
      },
    });

    return {
      tasks: tasks.map((t) => ({
        description: t.description,
        taskType: t.taskType,
        status: t.status,
        deadline: t.deadline?.toISOString(),
        contactEmail: t.contactEmail || undefined,
        contactName: t.contactName || undefined,
        threadId: t.threadId,
        threadSubject: t.thread.subject,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }

  // ── Tool execution dispatcher ──

  private async executeTool(
    toolUse: { id: string; name: string; input: Record<string, unknown> },
    params: ChatParams,
  ): Promise<{
    toolUseId: string;
    content: string;
    sideEffects?: {
      searchResults?: SearchResult[];
      priorityInbox?: PriorityItem[];
      tasks?: TaskItem[];
      contactResults?: ContactResult[];
      threadReferences?: { id: string; subject: string }[];
    };
  }> {
    const { id, name, input } = toolUse;

    switch (name) {
      case 'search_emails': {
        const result = await this.handleSearchEmails(input, params.userId);
        const threadRefs = result.results.slice(0, 5).map((r) => ({
          id: r.threadId,
          subject: r.threadSubject,
        }));
        // Deduplicate thread references
        const seen = new Set<string>();
        const uniqueRefs = threadRefs.filter((ref) => {
          if (seen.has(ref.id)) return false;
          seen.add(ref.id);
          return true;
        });
        return {
          toolUseId: id,
          content: JSON.stringify(result.results),
          sideEffects: {
            searchResults: result.results,
            threadReferences: uniqueRefs,
          },
        };
      }

      case 'get_thread_detail': {
        const result = await this.handleGetThreadDetail(input);
        return {
          toolUseId: id,
          content: JSON.stringify(result),
        };
      }

      case 'lookup_contact': {
        const result = await this.handleLookupContact(input, params.userId);
        return {
          toolUseId: id,
          content: JSON.stringify(result.contacts),
          sideEffects: { contactResults: result.contacts },
        };
      }

      case 'get_priority_inbox': {
        const result = await this.handleGetPriorityInbox(
          input,
          params.userId,
        );
        return {
          toolUseId: id,
          content: JSON.stringify(result.emails),
          sideEffects: { priorityInbox: result.emails },
        };
      }

      case 'get_tasks_and_deadlines': {
        const result = await this.handleGetTasksAndDeadlines(
          input,
          params.userId,
        );
        return {
          toolUseId: id,
          content: JSON.stringify(result.tasks),
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

  // ── Process output tool results into response ──

  private processOutputTool(
    name: string,
    input: Record<string, unknown>,
    primaryRecipient: string | undefined,
    threadId: string | null,
  ): { reply: string; draft?: ChatResponse['draft'] } {
    if (name === 'generate_draft') {
      return {
        reply: "Here's a draft for you:",
        draft: {
          to: (input.to as string) || primaryRecipient,
          subject: input.subject as string | undefined,
          body: input.body as string,
          threadId: threadId || undefined,
          greetingUsed: input.greeting_used as string | undefined,
          signoffUsed: input.signoff_used as string | undefined,
        },
      };
    }

    if (name === 'summarize_thread') {
      const summary = input.summary as string;
      const keyPoints = input.key_points as string[];
      const actionItems = (input.action_items as string[]) || [];
      let text = `**Summary**\n${summary}\n\n**Key Points**\n${keyPoints.map((p) => `• ${p}`).join('\n')}`;
      if (actionItems.length > 0) {
        text += `\n\n**Action Items**\n${actionItems.map((a) => `• ${a}`).join('\n')}`;
      }
      return { reply: text };
    }

    if (name === 'extract_action_items') {
      const items = input.items as Array<{
        description: string;
        assignee?: string;
        deadline?: string;
        status: string;
      }>;
      const statusLabel: Record<string, string> = {
        done: '[done]',
        in_progress: '[in progress]',
        pending: '[pending]',
      };
      const text = `**Action Items**\n${items
        .map((item) => {
          let line = `${statusLabel[item.status] || '[?]'} ${item.description}`;
          if (item.assignee) line += ` — ${item.assignee}`;
          if (item.deadline) line += ` (due: ${item.deadline})`;
          return line;
        })
        .join('\n')}`;
      return { reply: text };
    }

    return { reply: '' };
  }

  // ── Non-streaming chat ──

  async chat(params: ChatParams): Promise<ChatResponse> {
    const { system, recentMessages, primaryRecipient } =
      await this.buildContext(params);

    // Build message array for the loop
    let messages: Anthropic.MessageParam[] = recentMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let reply = '';
    let draft: ChatResponse['draft'] | undefined;
    let searchResults: SearchResult[] | undefined;
    let priorityInbox: PriorityItem[] | undefined;
    let tasks: TaskItem[] | undefined;
    let contactResults: ContactResult[] | undefined;
    let threadReferences: { id: string; subject: string }[] | undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system,
        messages,
        tools: TOOLS,
      });

      // Separate content blocks
      const textBlocks: string[] = [];
      const toolUses: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textBlocks.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      // Check for output tools — these end the loop
      const outputToolUses = toolUses.filter((t) =>
        OUTPUT_TOOL_NAMES.has(t.name),
      );
      if (outputToolUses.length > 0) {
        const result = this.processOutputTool(
          outputToolUses[0].name,
          outputToolUses[0].input,
          primaryRecipient,
          params.threadId,
        );
        reply = result.reply;
        draft = result.draft;
        break;
      }

      // No tool calls — pure text response
      if (toolUses.length === 0) {
        reply = textBlocks.join('');
        break;
      }

      // Data tool calls — execute and loop
      const dataToolUses = toolUses.filter((t) =>
        DATA_TOOL_NAMES.has(t.name),
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of dataToolUses) {
        const result = await this.executeTool(toolUse, params);

        // Accumulate side effects
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
          type: 'tool_result',
          tool_use_id: result.toolUseId,
          content: result.content,
        });
      }

      // Append assistant content + tool results for next round
      messages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];

      // If this was the last round, extract any text from the final response
      if (round === MAX_TOOL_ROUNDS - 1) {
        reply = textBlocks.join('') || "I found some results but couldn't fully process them.";
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
  }

  // ── Streaming chat ──

  async *chatStream(
    params: ChatParams,
  ): AsyncGenerator<{ type: string; data?: unknown }> {
    const { system, recentMessages, primaryRecipient, correctionsApplied } =
      await this.buildContext(params);

    let messages: Anthropic.MessageParam[] = recentMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Collect the full response for this round
      const stream = this.client.messages.stream({
        model: MODEL,
        max_tokens: 4096,
        system,
        messages,
        tools: TOOLS,
      });

      const isLastRound = round === MAX_TOOL_ROUNDS - 1;
      const toolUses: Array<{
        id: string;
        name: string;
        inputJson: string;
      }> = [];
      let currentToolName = '';
      let currentToolId = '';
      let toolInputJson = '';
      let hasTextOutput = false;
      let roundContentBlocks: Anthropic.ContentBlock[] = [];

      for await (const event of stream) {
        if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'tool_use'
        ) {
          currentToolName = event.content_block.name;
          currentToolId = event.content_block.id;
          toolInputJson = '';
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            // Only stream text on the final round or if there are no tool calls
            // We'll stream all text — if it's an intermediate round it'll be minimal
            yield { type: 'text_delta', data: { text: event.delta.text } };
            hasTextOutput = true;
          } else if (event.delta.type === 'input_json_delta') {
            toolInputJson += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop' && currentToolName) {
          toolUses.push({
            id: currentToolId,
            name: currentToolName,
            inputJson: toolInputJson,
          });
          currentToolName = '';
          currentToolId = '';
          toolInputJson = '';
        }
      }

      // Get the final message for building the next round
      const finalMessage = await stream.finalMessage();
      roundContentBlocks = finalMessage.content;

      // No tool calls — we're done
      if (toolUses.length === 0) {
        yield { type: 'done' };
        return;
      }

      // Process tool calls
      const outputTools = toolUses.filter((t) =>
        OUTPUT_TOOL_NAMES.has(t.name),
      );
      const dataTools = toolUses.filter((t) => DATA_TOOL_NAMES.has(t.name));

      // Handle output tools — these end the loop
      if (outputTools.length > 0) {
        for (const tool of outputTools) {
          try {
            const input = JSON.parse(tool.inputJson) as Record<
              string,
              unknown
            >;

            if (tool.name === 'generate_draft') {
              yield {
                type: 'tool_result',
                data: {
                  tool: 'generate_draft',
                  draft: {
                    to: (input.to as string) || primaryRecipient,
                    subject: input.subject,
                    body: input.body,
                    threadId: params.threadId || undefined,
                    greetingUsed: input.greeting_used,
                    signoffUsed: input.signoff_used,
                    correctionsApplied,
                  },
                },
              };
            } else if (tool.name === 'summarize_thread') {
              const result = this.processOutputTool(
                tool.name,
                input,
                primaryRecipient,
                params.threadId,
              );
              yield {
                type: 'tool_result',
                data: { tool: 'summarize_thread', text: result.reply },
              };
            } else if (tool.name === 'extract_action_items') {
              const result = this.processOutputTool(
                tool.name,
                input,
                primaryRecipient,
                params.threadId,
              );
              yield {
                type: 'tool_result',
                data: {
                  tool: 'extract_action_items',
                  text: result.reply,
                },
              };
            }
          } catch {
            // skip malformed tool input
          }
        }
        yield { type: 'done' };
        return;
      }

      // Handle data tools — execute and loop
      if (dataTools.length > 0) {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const tool of dataTools) {
          try {
            const input = JSON.parse(tool.inputJson) as Record<
              string,
              unknown
            >;
            const result = await this.executeTool(
              { id: tool.id, name: tool.name, input },
              params,
            );

            // Emit side effects to frontend
            if (result.sideEffects?.searchResults) {
              yield {
                type: 'search_results',
                data: { results: result.sideEffects.searchResults },
              };
            }
            if (result.sideEffects?.priorityInbox) {
              yield {
                type: 'priority_inbox',
                data: { emails: result.sideEffects.priorityInbox },
              };
            }
            if (result.sideEffects?.tasks) {
              yield {
                type: 'tasks',
                data: { tasks: result.sideEffects.tasks },
              };
            }
            if (result.sideEffects?.contactResults) {
              yield {
                type: 'contact_results',
                data: { contacts: result.sideEffects.contactResults },
              };
            }
            if (result.sideEffects?.threadReferences) {
              yield {
                type: 'thread_references',
                data: { references: result.sideEffects.threadReferences },
              };
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: result.toolUseId,
              content: result.content,
            });
          } catch {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tool.id,
              content: JSON.stringify({ error: 'Tool execution failed' }),
            });
          }
        }

        // Append to messages for next round
        messages = [
          ...messages,
          { role: 'assistant', content: roundContentBlocks },
          { role: 'user', content: toolResults },
        ];

        // If this is the last round allowed, stream the next response
        if (isLastRound) {
          // One final streaming call
          const finalStream = this.client.messages.stream({
            model: MODEL,
            max_tokens: 4096,
            system,
            messages,
            tools: TOOLS,
          });
          for await (const event of finalStream) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta'
            ) {
              yield { type: 'text_delta', data: { text: event.delta.text } };
            }
          }
          yield { type: 'done' };
          return;
        }
      }
    }

    yield { type: 'done' };
  }
}
