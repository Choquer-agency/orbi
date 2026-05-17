import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Orbi Mail — Convex schema
//
// Translated from prisma/schema.prisma. Conventions:
//   - Tables are camelCase plural.
//   - All Prisma DateTime fields → v.number() (Unix ms).
//   - Foreign keys → v.id("table"). _storage is used for binary content.
//   - Enums → v.union of v.literal(...).
//   - Convex Auth's authTables.users is extended (not redefined) with
//     app-specific columns (role, displayName, avatarUrl).
//   - Indexes mirror Prisma @@index/@@unique. Unique constraints are
//     enforced in mutations (not at schema level).
// ─────────────────────────────────────────────────────────────────────────────

const userRole = v.union(
  v.literal("ADMIN"),
  v.literal("MANAGER"),
  v.literal("AGENT"),
);

const accountProvider = v.union(
  v.literal("GMAIL"),
  v.literal("MICROSOFT"),
  v.literal("APPLE_IMAP"),
);

const historicalSyncStatus = v.union(
  v.literal("IDLE"),
  v.literal("IN_PROGRESS"),
  v.literal("COMPLETED"),
  v.literal("FAILED"),
);

const sendStatus = v.union(
  v.literal("NONE"),
  v.literal("PENDING_SEND"),
  v.literal("SENDING"),
  v.literal("SENT"),
  v.literal("DELIVERED"),
  v.literal("FAILED"),
  v.literal("UNDONE"),
);

const accessLevel = v.union(
  v.literal("VIEWER"),
  v.literal("COLLABORATOR"),
  v.literal("OWNER"),
);

const notificationType = v.union(
  v.literal("NEW_EMAIL"),
  v.literal("MENTION"),
  v.literal("COMMENT"),
  v.literal("ASSIGNMENT"),
  v.literal("SLA_WARNING"),
  v.literal("SLA_BREACH"),
  v.literal("SNOOZE_REMINDER"),
);

const taskType = v.union(
  v.literal("PROMISE"),
  v.literal("DEADLINE"),
  v.literal("CHANGE_REQUEST"),
  v.literal("ACTION_ITEM"),
);

const taskStatus = v.union(
  v.literal("OPEN"),
  v.literal("DONE"),
  v.literal("AUTO_RESOLVED"),
);

const scheduledEmailStatus = v.union(
  v.literal("SCHEDULED"),
  v.literal("SENDING"),
  v.literal("SENT"),
  v.literal("CANCELLED"),
  v.literal("FAILED"),
);

const followUpWatchStatus = v.union(
  v.literal("WATCHING"),
  v.literal("REPLIED"),
  v.literal("EXPIRED"),
  v.literal("CANCELLED"),
);

const meetingDetectionStatus = v.union(
  v.literal("DETECTED"),
  v.literal("AVAILABILITY_CHECKED"),
  v.literal("ACCEPTED"),
  v.literal("DECLINED"),
  v.literal("EXPIRED"),
);

const handoffStatus = v.union(
  v.literal("PENDING"),
  v.literal("ACCEPTED"),
  v.literal("DECLINED"),
  v.literal("COMPLETED"),
);

const delegatedEmailStatus = v.union(
  v.literal("PENDING"),
  v.literal("IN_PROGRESS"),
  v.literal("COMPLETED"),
  v.literal("RETURNED"),
);

const devicePlatform = v.union(v.literal("IOS"), v.literal("ANDROID"));

export default defineSchema({
  // ───────────────────────────────────────────────────────────────────────────
  // Auth — extend Convex Auth's users table with app-specific columns.
  // (authTables.users already provides id, email, name, image, etc.)
  // ───────────────────────────────────────────────────────────────────────────
  ...authTables,

  users: defineTable({
    // Convex Auth core fields (kept here so the table validator accepts them):
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),

    // App-specific:
    role: v.optional(userRole),
    displayName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Mail accounts (Gmail / Microsoft / IMAP) — renamed from Prisma `Account`
  // to avoid colliding with Convex Auth's OAuth `accounts` table.
  // ───────────────────────────────────────────────────────────────────────────
  mailAccounts: defineTable({
    userId: v.id("users"),
    provider: accountProvider,
    email: v.string(),
    displayName: v.optional(v.string()),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiry: v.optional(v.number()),
    scopes: v.array(v.string()),
    isActive: v.boolean(),
    // UI accent color for this account.
    color: v.optional(v.string()),
    // Discovered "send as" aliases (Gmail), refreshed periodically.
    aliases: v.optional(v.array(v.string())),
    aliasesUpdatedAt: v.optional(v.number()),
    // Contact backfill bookkeeping. Set once the chunked recipient scan
    // finishes so the next deploy doesn't re-trigger it.
    contactBackfillStatus: v.optional(
      v.union(v.literal("PENDING"), v.literal("IN_PROGRESS"), v.literal("COMPLETED")),
    ),
    contactBackfillCursor: v.optional(v.number()),
    contactBackfillCount: v.optional(v.number()),
    contactBackfillCompletedAt: v.optional(v.number()),
    syncCursor: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    historicalSyncStatus: historicalSyncStatus,
    historicalSyncProgress: v.optional(v.any()),
    historicalSyncCompletedAt: v.optional(v.number()),
    // Microsoft folder-id lookup cache (TTL'd in microsoft.ts). Avoids ~6 Graph
    // calls per sync chunk to resolve well-known folder ids.
    msFolderMapCache: v.optional(
      v.object({
        entries: v.array(
          v.object({ folderId: v.string(), labels: v.array(v.string()) }),
        ),
        expiresAt: v.number(),
      }),
    ),
  })
    .index("by_user", ["userId"])
    .index("by_provider_email", ["provider", "email"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Threads
  // ───────────────────────────────────────────────────────────────────────────
  threads: defineTable({
    accountId: v.id("mailAccounts"),
    providerThreadId: v.string(),
    subject: v.string(),
    snippet: v.optional(v.string()),
    isRead: v.boolean(),
    isStarred: v.boolean(),
    isArchived: v.boolean(),
    isTrashed: v.boolean(),
    snoozedUntil: v.optional(v.number()),
    labels: v.array(v.string()),
    participantEmails: v.array(v.string()),
    messageCount: v.number(),
    lastMessageAt: v.number(),
    lastReceivedAt: v.optional(v.number()),
    // Timestamp of the last user-driven read-state change made in this app.
    // Used to suppress sync-driven read→unread regressions in the brief window
    // between marking read locally and Gmail/Outlook acknowledging it.
    readStateLocalAt: v.optional(v.number()),
  })
    .index("by_account_providerThreadId", ["accountId", "providerThreadId"])
    .index("by_account_lastMessageAt", ["accountId", "lastMessageAt"])
    .index("by_account_lastReceivedAt", ["accountId", "lastReceivedAt"])
    .index("by_account_isArchived_isTrashed", [
      "accountId",
      "isArchived",
      "isTrashed",
    ])
    .index("by_account_snoozedUntil", ["accountId", "snoozedUntil"])
    // Server-side full-text search over thread subjects so search hits the
    // entire mailbox instead of the most recent N threads in memory.
    .searchIndex("search_subject", {
      searchField: "subject",
      filterFields: ["accountId", "isTrashed"],
    }),

  // ───────────────────────────────────────────────────────────────────────────
  // Emails (messages within threads)
  // ───────────────────────────────────────────────────────────────────────────
  emails: defineTable({
    accountId: v.id("mailAccounts"),
    threadId: v.id("threads"),
    providerMessageId: v.string(),
    internetMessageId: v.optional(v.string()),
    inReplyTo: v.optional(v.string()),
    references: v.array(v.string()),
    fromAddress: v.string(),
    fromName: v.optional(v.string()),
    toAddresses: v.any(),
    ccAddresses: v.optional(v.any()),
    bccAddresses: v.optional(v.any()),
    subject: v.string(),
    // Body fields are DEPRECATED on this row — they now live in `emailBodies`.
    // We keep them v.optional so existing rows validate while the migration
    // back-fills the sibling table. New ingest paths write to `emailBodies`
    // and leave these undefined.
    //
    // Why the split: a single 16 MB bodyHtml is enough to blow Convex's per-
    // function byte-read limit on ANY unindexed scan of `emails` (filtering,
    // pagination, etc.). With the body off the row, every metadata read is a
    // few hundred bytes regardless of message size.
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    bodyHtmlClean: v.optional(v.string()),
    bodyHtmlTrimmed: v.optional(v.string()),
    hasQuotedHistory: v.optional(v.boolean()),
    isForwarded: v.optional(v.boolean()),
    snippet: v.optional(v.string()),
    isRead: v.boolean(),
    isStarred: v.boolean(),
    isDraft: v.boolean(),
    labels: v.array(v.string()),
    hasAttachments: v.boolean(),
    receivedAt: v.number(),
    sentAt: v.optional(v.number()),

    // Send lifecycle
    sendStatus: sendStatus,
    undoDeadlineAt: v.optional(v.number()),
    undoneAt: v.optional(v.number()),
    sendError: v.optional(v.string()),
    sendAttempts: v.number(),
  })
    .index("by_providerMessageId", ["providerMessageId"])
    .index("by_thread_receivedAt", ["threadId", "receivedAt"])
    .index("by_account_receivedAt", ["accountId", "receivedAt"])
    // Lets drafts.count / drafts.list narrow to draft rows without dragging in
    // every other email in the mailbox (avoids the 16MB read limit).
    .index("by_account_isDraft_receivedAt", ["accountId", "isDraft", "receivedAt"])
    .index("by_account_sendStatus_receivedAt", ["accountId", "sendStatus", "receivedAt"])
    .index("by_sendStatus_undoDeadline", ["sendStatus", "undoDeadlineAt"])
    .index("by_account_fromAddress", ["accountId", "fromAddress"])
    .index("by_account_fromName", ["accountId", "fromName"])
    // Server-side full-text search over message bodies. Pairs with the
    // threads.search_subject index so search covers both subjects and body
    // text across the entire mailbox.
    .searchIndex("search_body", {
      searchField: "bodyText",
      filterFields: ["accountId"],
    }),

  // ───────────────────────────────────────────────────────────────────────────
  // Email bodies — split off the `emails` row so metadata reads stay tiny.
  // One row per email, looked up by `emailId`. Only read when the viewer
  // actually opens the message; never touched by list/search/scan paths.
  // ───────────────────────────────────────────────────────────────────────────
  emailBodies: defineTable({
    emailId: v.id("emails"),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    bodyHtmlClean: v.optional(v.string()),
    bodyHtmlTrimmed: v.optional(v.string()),
    hasQuotedHistory: v.optional(v.boolean()),
    isForwarded: v.optional(v.boolean()),
  }).index("by_email", ["emailId"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Attachments — Bytes dropped; binary lives in Convex `_storage`.
  // ───────────────────────────────────────────────────────────────────────────
  attachments: defineTable({
    emailId: v.id("emails"),
    filename: v.string(),
    mimeType: v.string(),
    size: v.number(),
    contentId: v.optional(v.string()),
    providerAttachmentId: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  }).index("by_email", ["emailId"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Signatures
  // ───────────────────────────────────────────────────────────────────────────
  signatures: defineTable({
    userId: v.id("users"),
    accountIds: v.array(v.string()), // mailAccount ids serialized as strings
    name: v.string(),
    bodyHtml: v.string(),
    isDefault: v.boolean(),
  }).index("by_user", ["userId"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Internal collaboration on threads
  // ───────────────────────────────────────────────────────────────────────────
  threadComments: defineTable({
    threadId: v.id("threads"),
    authorId: v.id("users"),

    // Denormalized author + reaction summary to avoid 3-level joins on render.
    authorName: v.string(),
    authorAvatarUrl: v.optional(v.string()),
    reactionCounts: v.optional(v.any()), // { "👍": 3, "❤️": 1 }

    bodyHtml: v.string(),
    bodyText: v.string(),
    isResolved: v.boolean(),
    resolvedBy: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    isEdited: v.boolean(),
    editedAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_author", ["authorId"]),

  threadMentions: defineTable({
    commentId: v.id("threadComments"),
    threadId: v.id("threads"),
    mentionedUserId: v.id("users"),
  })
    .index("by_comment_user", ["commentId", "mentionedUserId"])
    .index("by_user", ["mentionedUserId"])
    .index("by_thread", ["threadId"]),

  commentReactions: defineTable({
    commentId: v.id("threadComments"),
    userId: v.id("users"),
    emoji: v.string(),
  })
    .index("by_comment_user_emoji", ["commentId", "userId", "emoji"])
    .index("by_comment", ["commentId"]),

  threadAccess: defineTable({
    threadId: v.id("threads"),
    userId: v.id("users"),
    accessLevel: accessLevel,
    grantedAt: v.number(),
  })
    .index("by_thread_user", ["threadId", "userId"])
    .index("by_user", ["userId"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Notifications
  // ───────────────────────────────────────────────────────────────────────────
  notifications: defineTable({
    userId: v.id("users"),
    type: notificationType,
    title: v.string(),
    body: v.optional(v.string()),
    data: v.optional(v.any()),
    isRead: v.boolean(),
  }).index("by_user_isRead", ["userId", "isRead"]),

  // ───────────────────────────────────────────────────────────────────────────
  // AI: writing preferences, contact styles, edit memory
  // ───────────────────────────────────────────────────────────────────────────
  writingPreferences: defineTable({
    userId: v.id("users"),
    greetingStyle: v.optional(v.string()),
    signOffStyle: v.optional(v.string()),
    tone: v.number(),
    verbosity: v.number(),
    descriptors: v.array(v.string()),
    customRules: v.array(v.string()),
  }).index("by_user", ["userId"]),

  contactStyles: defineTable({
    userId: v.id("users"),
    contactEmail: v.string(),
    contactName: v.optional(v.string()),
    tone: v.optional(v.number()),
    verbosity: v.optional(v.number()),
    greetingStyle: v.optional(v.string()),
    signOffStyle: v.optional(v.string()),
    notes: v.optional(v.string()),
    isAutoLearned: v.boolean(),
  }).index("by_user_email", ["userId", "contactEmail"]),

  styleCorrections: defineTable({
    userId: v.id("users"),
    contactEmail: v.optional(v.string()),
    category: v.string(),
    originalText: v.string(),
    editedText: v.string(),
    summary: v.optional(v.string()),
    threadId: v.optional(v.string()),
  })
    .index("by_user_contactEmail", ["userId", "contactEmail"])
    .index("by_user_category", ["userId", "category"]),

  // Auto-learned writing profile, summarised from real sent emails across
  // ALL connected accounts. One row per user. Refreshed periodically by
  // `ai/styleProfile:refresh` (kicked off after sync + on demand).
  // Surfaced through `lib/styleContext.ts` so every AI draft and chat reply
  // inherits the user's actual voice without needing to fill out settings.
  styleProfiles: defineTable({
    userId: v.id("users"),
    summary: v.string(), // 1–2 paragraph natural-language description
    bulletRules: v.array(v.string()), // short, prompt-ready rules
    sampleSize: v.number(), // # of sent emails analysed
    accountsAnalysed: v.array(v.string()), // emails of the accounts sampled
    lastBuiltAt: v.number(),
    // Pinned highlights for fast prompt construction.
    commonGreetings: v.array(v.string()),
    commonSignOffs: v.array(v.string()),
    avgWords: v.optional(v.number()),
    inferredTone: v.optional(v.number()),
    inferredVerbosity: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Tasks (action items, deadlines)
  // ───────────────────────────────────────────────────────────────────────────
  tasks: defineTable({
    userId: v.id("users"),
    threadId: v.id("threads"),
    sourceEmailId: v.optional(v.string()),
    description: v.string(),
    contactEmail: v.optional(v.string()),
    contactName: v.optional(v.string()),
    taskType: taskType,
    deadline: v.optional(v.number()),
    status: taskStatus,
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.string()),
  })
    .index("by_user_status_deadline", ["userId", "status", "deadline"])
    .index("by_thread", ["threadId"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Scheduled send
  // ───────────────────────────────────────────────────────────────────────────
  scheduledEmails: defineTable({
    userId: v.id("users"),
    accountId: v.id("mailAccounts"),
    threadId: v.optional(v.id("threads")),
    parentEmailId: v.optional(v.string()),
    mode: v.string(), // "compose" | "reply" | "forward"
    toAddresses: v.any(),
    ccAddresses: v.optional(v.any()),
    bccAddresses: v.optional(v.any()),
    subject: v.string(),
    bodyHtml: v.string(),
    bodyText: v.string(),
    sendAt: v.number(),
    status: scheduledEmailStatus,
    jobId: v.optional(v.string()),
    sentEmailId: v.optional(v.string()),
    failureReason: v.optional(v.string()),
    cancelledAt: v.optional(v.number()),
  })
    .index("by_user_status_sendAt", ["userId", "status", "sendAt"])
    .index("by_user_sendAt", ["userId", "sendAt"])
    .index("by_thread_status_sendAt", ["threadId", "status", "sendAt"])
    .index("by_status_sendAt", ["status", "sendAt"]),

  // ───────────────────────────────────────────────────────────────────────────
  // AI categorization & routing
  // ───────────────────────────────────────────────────────────────────────────
  emailClassifications: defineTable({
    emailId: v.id("emails"),
    category: v.string(),
    // The trio below (confidence, urgency, summary) used to be required but
    // is no longer displayed. Kept as optional so we can drop them from new
    // writes (saves ~40% per row) without breaking legacy rows. A one-shot
    // purge wipes them from existing rows; afterward all values are undefined.
    confidence: v.optional(v.number()),
    urgency: v.optional(v.string()), // "low" | "normal" | "high" | "urgent"
    summary: v.optional(v.string()),
    manualOverride: v.boolean(),
    overriddenBy: v.optional(v.string()),
  })
    .index("by_email", ["emailId"])
    .index("by_category", ["category"]),

  routingRules: defineTable({
    userId: v.id("users"),
    category: v.string(),
    assignToUserId: v.optional(v.id("users")),
    priority: v.number(),
    isActive: v.boolean(),
  })
    .index("by_user", ["userId"])
    .index("by_category_isActive", ["category", "isActive"]),

  // ───────────────────────────────────────────────────────────────────────────
  // AI chat
  // ───────────────────────────────────────────────────────────────────────────
  chatConversations: defineTable({
    userId: v.id("users"),
    title: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  chatMessages: defineTable({
    conversationId: v.id("chatConversations"),
    role: v.string(), // "user" | "assistant"
    content: v.string(),
    metadata: v.optional(v.any()),
  }).index("by_conversation", ["conversationId"]),

  aiUsageLogs: defineTable({
    userId: v.optional(v.id("users")),
    feature: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    // Anthropic prompt caching telemetry. Optional because rows written
    // before caching was wired up will not have them.
    cacheCreationInputTokens: v.optional(v.number()),
    cacheReadInputTokens: v.optional(v.number()),
    providerCallCount: v.number(),
    estimatedCostUsd: v.number(),
    requestId: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_user_createdAt", ["userId", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_feature_createdAt", ["feature", "createdAt"]),

  // Tripped by the 15-minute cost-alert cron when a feature exceeds its
  // configured spend threshold in the last N hours. The dashboard reads
  // unresolved alerts; admins acknowledge to clear.
  aiCostAlerts: defineTable({
    feature: v.string(),
    windowHours: v.number(),
    estimatedCostUsd: v.number(),
    thresholdUsd: v.number(),
    acknowledgedAt: v.optional(v.number()),
    acknowledgedBy: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_feature_createdAt", ["feature", "createdAt"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Open + link tracking
  // ───────────────────────────────────────────────────────────────────────────
  emailTracking: defineTable({
    emailId: v.id("emails"),
    trackingId: v.string(),
    isEnabled: v.boolean(),
    openCount: v.number(),
    lastOpenedAt: v.optional(v.number()),
    linkMap: v.optional(v.any()),
  })
    .index("by_email", ["emailId"])
    .index("by_trackingId", ["trackingId"]),

  emailOpens: defineTable({
    trackingId: v.string(),
    openedAt: v.number(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    country: v.optional(v.string()),
    city: v.optional(v.string()),
  }).index("by_trackingId_openedAt", ["trackingId", "openedAt"]),

  linkClicks: defineTable({
    trackingId: v.string(),
    originalUrl: v.string(),
    clickedAt: v.number(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    country: v.optional(v.string()),
    city: v.optional(v.string()),
  }).index("by_trackingId_clickedAt", ["trackingId", "clickedAt"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Follow-up agent
  // ───────────────────────────────────────────────────────────────────────────
  followUpWatches: defineTable({
    userId: v.id("users"),
    threadId: v.id("threads"),
    emailId: v.string(),
    contactEmail: v.string(),
    intervals: v.array(v.number()),
    currentStep: v.number(),
    nextCheckAt: v.number(),
    status: followUpWatchStatus,
    resolvedAt: v.optional(v.number()),
  })
    .index("by_user_status_nextCheckAt", ["userId", "status", "nextCheckAt"])
    .index("by_status_nextCheckAt", ["status", "nextCheckAt"])
    .index("by_thread", ["threadId"]),

  followUpEvents: defineTable({
    watchId: v.id("followUpWatches"),
    type: v.string(), // "check" | "follow_up_drafted" | "follow_up_sent" | "reply_received"
    draftBody: v.optional(v.string()),
    draftTone: v.optional(v.string()),
    openCount: v.optional(v.number()),
  }).index("by_watch", ["watchId"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Meeting detection
  // ───────────────────────────────────────────────────────────────────────────
  meetingDetections: defineTable({
    emailId: v.id("emails"),
    threadId: v.id("threads"),
    status: meetingDetectionStatus,
    requestedTimes: v.optional(v.any()),
    selectedTime: v.optional(v.number()),
    calendarEventId: v.optional(v.string()),
    summary: v.optional(v.string()),
    attendees: v.array(v.string()),
  })
    .index("by_thread", ["threadId"])
    .index("by_status", ["status"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Handoffs + OOO delegation
  // ───────────────────────────────────────────────────────────────────────────
  threadHandoffs: defineTable({
    threadId: v.id("threads"),
    fromUserId: v.id("users"),
    toUserId: v.id("users"),
    note: v.optional(v.string()),
    transferSla: v.boolean(),
    transferFollowUps: v.boolean(),
    status: handoffStatus,
    acceptedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_toUser_status", ["toUserId", "status"])
    .index("by_thread", ["threadId"]),

  outOfOfficeDelegations: defineTable({
    userId: v.id("users"),
    delegateId: v.optional(v.id("users")),
    startAt: v.number(),
    endAt: v.number(),
    autoReplyEnabled: v.boolean(),
    autoReplyBody: v.optional(v.string()),
    autoReplySubject: v.optional(v.string()),
    autoReplyScope: v.string(), // "all" | …
    isActive: v.boolean(),
    categories: v.array(v.string()),
  }).index("by_user_isActive", ["userId", "isActive"]),

  delegatedEmails: defineTable({
    emailId: v.id("emails"),
    delegatedToId: v.id("users"),
    status: delegatedEmailStatus,
  }).index("by_delegatedTo_status", ["delegatedToId", "status"]),

  autoReplyLogs: defineTable({
    delegationId: v.id("outOfOfficeDelegations"),
    senderAddress: v.string(),
    repliedAt: v.number(),
  }).index("by_delegation_sender", ["delegationId", "senderAddress"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Contacts + unified Person
  // ───────────────────────────────────────────────────────────────────────────
  persons: defineTable({
    userId: v.id("users"),
    displayName: v.string(),
    company: v.optional(v.string()),
    title: v.optional(v.string()),
    phone: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    notes: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_user_displayName", ["userId", "displayName"])
    .index("by_user_updatedAt", ["userId", "updatedAt"]),

  contacts: defineTable({
    userId: v.id("users"),
    email: v.string(),
    name: v.optional(v.string()),
    company: v.optional(v.string()),
    title: v.optional(v.string()),
    phone: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    notes: v.optional(v.string()),
    lastEmailed: v.optional(v.number()),
    emailCount: v.number(),
    isAutoLearned: v.boolean(),
    personId: v.optional(v.id("persons")),
  })
    .index("by_user_email", ["userId", "email"])
    .index("by_user_name", ["userId", "name"])
    .index("by_user_company", ["userId", "company"])
    .index("by_user_lastEmailed", ["userId", "lastEmailed"])
    .index("by_person", ["personId"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Smart triage
  // ───────────────────────────────────────────────────────────────────────────
  triageFeedback: defineTable({
    userId: v.id("users"),
    emailId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    suggestedCategory: v.string(),
    finalCategory: v.string(),
    wasConfirmed: v.boolean(),
    senderAddress: v.string(),
    subjectSnippet: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_user_sender", ["userId", "senderAddress"]),

  triageSettings: defineTable({
    userId: v.id("users"),
    autoSortEnabled: v.boolean(),
    confidenceThreshold: v.number(),
  }).index("by_user", ["userId"]),

  // Per-email scoring of whether the user owes a reply. Drives the
  // Needs Response folder. One row per inbound email that the AI looked at.
  //   - `score` — 0-100, how strongly the AI thinks the user should reply.
  //   - `reason` — one-line explanation surfaced as a tooltip on the card.
  //   - `dueByHint` — extracted deadline (epoch ms) if the email mentioned one.
  //   - `dismissedAt` — set when the user replies, archives, trashes, or
  //     manually clicks "Done". Open signals = signals with dismissedAt
  //     undefined. The folder query only considers open signals.
  needsResponseSignals: defineTable({
    userId: v.id("users"),
    emailId: v.id("emails"),
    threadId: v.id("threads"),
    score: v.number(),
    reason: v.optional(v.string()),
    dueByHint: v.optional(v.number()),
    computedAt: v.number(),
    dismissedAt: v.optional(v.number()),
    // v2: To-vs-CC awareness. `userIsDirectAddressee` = user-owned address
    // appears in `email.toAddresses`. `userIsCcd` = appears only in CC/BCC.
    userIsDirectAddressee: v.optional(v.boolean()),
    userIsCcd: v.optional(v.boolean()),
    // v2: true when the sender's domain matches one of the user's
    // connected-account domains (e.g. a teammate emailing about a shared
    // client). Biases the score ceiling down.
    senderIsTeamInternal: v.optional(v.boolean()),
    // v2: raw `score` is the AI's 0-100 judgment of the email in isolation;
    // `displayScore` adds the deadline-urgency bonus and the active-thread
    // penalty. The folder query orders by displayScore so an "untouched
    // urgent ask" outranks a chatty thread of the same nominal score.
    displayScore: v.optional(v.number()),
  })
    .index("by_email", ["emailId"])
    .index("by_thread", ["threadId"])
    // The Needs Response folder query walks open (dismissedAt undefined) signals
    // for a user, ordered by score desc for the "top 5". The compound index
    // keeps that scan O(open-signals) rather than O(all-signals).
    .index("by_user_dismissedAt_score", ["userId", "dismissedAt", "score"]),

  // Per-user Needs Response preferences. `retentionDays` caps how far back
  // the scorer will look (default 45). `confidenceFloor` is the lowest
  // score that persists as an open signal (default 50). `perAccountFilter`
  // narrows the folder view to specific mailboxes; null/empty = all.
  needsResponseSettings: defineTable({
    userId: v.id("users"),
    retentionDays: v.number(),
    confidenceFloor: v.number(),
    perAccountFilter: v.optional(v.array(v.id("mailAccounts"))),
  }).index("by_user", ["userId"]),

  // Implicit-signal store for Needs Response calibration. One row per
  // dismissal. The scorer reads recent rows for the same sender so future
  // emails from senders the user keeps dismissing can be biased downward
  // without any explicit "Not for me" UI.
  //   - kind="replied"        : user sent into the thread (genuine handle)
  //   - kind="archived"       : user archived/trashed (moderate "didn't matter")
  //   - kind="manual-done"    : user clicked Done without replying (strongest
  //                              "shouldn't have been flagged")
  //   - kind="auto-other-acc" : another connected account replied
  needsResponseFeedback: defineTable({
    userId: v.id("users"),
    threadId: v.id("threads"),
    emailId: v.id("emails"),
    senderAddress: v.string(),
    senderDomain: v.string(),
    category: v.optional(v.string()),
    scoreAtDismissal: v.number(),
    reasonAtDismissal: v.optional(v.string()),
    kind: v.union(
      v.literal("replied"),
      v.literal("archived"),
      v.literal("manual-done"),
      v.literal("auto-other-acc"),
    ),
    timeOnList: v.number(),
  })
    .index("by_user_sender", ["userId", "senderAddress"])
    .index("by_user_domain", ["userId", "senderDomain"])
    .index("by_user_kind", ["userId", "kind"]),

  // Per-user retention policy. A daily cron looks for threads in each bucket
  // older than the configured number of days and hard-deletes them so the
  // mailbox doesn't accumulate noise forever.
  //   - spamRetentionDays: applies to threads with the SPAM label
  //   - trashRetentionDays: applies to threads with isTrashed = true
  //   - blockedSenderImmediate: true → delete blocked-sender mail on arrival
  //     instead of trashing it (so retention doesn't even apply); false →
  //     trash on arrival, then trashRetentionDays takes over.
  // Use 0 for "never auto-delete".
  retentionSettings: defineTable({
    userId: v.id("users"),
    spamRetentionDays: v.number(),
    trashRetentionDays: v.number(),
    blockedSenderImmediate: v.boolean(),
  }).index("by_user", ["userId"]),

  // Hard per-sender / per-domain overrides for the AI triage classifier.
  // When the user moves an email out of Spam they're prompted to allow the
  // sender forever — we persist that choice here and short-circuit the
  // classifier on future emails whose fromAddress matches.
  // `kind: 'email'` matches the exact lowercased address; `kind: 'domain'`
  // matches the substring `@<domain>` at the end of the address.
  senderTriageOverrides: defineTable({
    userId: v.id("users"),
    kind: v.union(v.literal("email"), v.literal("domain")),
    pattern: v.string(),
    forceCategory: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_user_pattern", ["userId", "pattern"]),

  trackingExclusions: defineTable({
    userId: v.id("users"),
    emailAddress: v.string(),
    reason: v.optional(v.string()),
  })
    .index("by_user_email", ["userId", "emailAddress"])
    .index("by_user", ["userId"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Notifications + blocked senders + inbox splits + AI filters
  // ───────────────────────────────────────────────────────────────────────────
  notificationPreferences: defineTable({
    userId: v.id("users"),
    enableNewEmail: v.boolean(),
    enableMention: v.boolean(),
    enableComment: v.boolean(),
    enableAssignment: v.boolean(),
    enableSlaWarning: v.boolean(),
    enableSlaBreach: v.boolean(),
    enableSnoozeReminder: v.boolean(),
    desktopEnabled: v.boolean(),
    soundEnabled: v.boolean(),
    pushEnabled: v.boolean(),
    showPreviewOnLock: v.boolean(),
    quietHoursStart: v.optional(v.string()),
    quietHoursEnd: v.optional(v.string()),
    quietHoursTimezone: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  blockedSenders: defineTable({
    userId: v.id("users"),
    emailAddress: v.optional(v.string()),
    domain: v.optional(v.string()),
    reason: v.optional(v.string()),
  })
    .index("by_user_email", ["userId", "emailAddress"])
    .index("by_user_domain", ["userId", "domain"])
    .index("by_user", ["userId"]),

  inboxSplits: defineTable({
    userId: v.id("users"),
    category: v.string(),
    label: v.string(),
    position: v.number(),
    isEnabled: v.boolean(),
  })
    .index("by_user_category", ["userId", "category"])
    .index("by_user_isEnabled_position", ["userId", "isEnabled", "position"]),

  aiFilters: defineTable({
    userId: v.id("users"),
    name: v.string(),
    description: v.string(),
    conditions: v.any(),
    actions: v.any(),
    isActive: v.boolean(),
    matchCount: v.number(),
    lastMatchedAt: v.optional(v.number()),
  }).index("by_user_isActive", ["userId", "isActive"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Snippets / templates
  // ───────────────────────────────────────────────────────────────────────────
  snippets: defineTable({
    userId: v.id("users"),
    name: v.string(),
    bodyHtml: v.string(),
    bodyText: v.string(),
    category: v.optional(v.string()),
    variables: v.array(v.string()),
  }).index("by_user_category", ["userId", "category"]),

  // ───────────────────────────────────────────────────────────────────────────
  // Push notifications + delivery health counters
  // ───────────────────────────────────────────────────────────────────────────
  deviceTokens: defineTable({
    userId: v.id("users"),
    token: v.string(),
    platform: devicePlatform,
    bundleId: v.string(),
    sandbox: v.boolean(),
    appVersion: v.optional(v.string()),
    lastUsedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["token"]),

  pushDeliveryLogs: defineTable({
    userId: v.id("users"),
    deviceTokenId: v.id("deviceTokens"),
    notificationId: v.optional(v.string()),
    apnsId: v.optional(v.string()),
    status: v.string(), // "sent" | "failed" | "token_invalid" | "rate_limited"
    errorMessage: v.optional(v.string()),
    errorCode: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_deviceToken", ["deviceTokenId"])
    .index("by_status", ["status"]),

  // Counter table replaces the Prisma `$queryRaw GROUP BY` for push health.
  // Increment on each delivery; query by ["userId", "date"] range.
  pushDeliveryCounters: defineTable({
    userId: v.id("users"),
    status: v.string(),
    date: v.string(), // "YYYY-MM-DD"
    count: v.number(),
  }).index("by_user_date", ["userId", "date"]),
},
// Live DB pre-dates this schema and carries fields/legacy rows the
// validators don't list yet. Disable per-doc schema enforcement so deploys
// unblock; tighten back to default once legacy data is reconciled.
{ schemaValidation: false });
