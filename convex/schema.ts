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
    syncCursor: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    historicalSyncStatus: historicalSyncStatus,
    historicalSyncProgress: v.optional(v.any()),
    historicalSyncCompletedAt: v.optional(v.number()),
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
  })
    .index("by_account_providerThreadId", ["accountId", "providerThreadId"])
    .index("by_account_lastMessageAt", ["accountId", "lastMessageAt"])
    .index("by_account_lastReceivedAt", ["accountId", "lastReceivedAt"])
    .index("by_account_isArchived_isTrashed", [
      "accountId",
      "isArchived",
      "isTrashed",
    ])
    .index("by_account_snoozedUntil", ["accountId", "snoozedUntil"]),

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
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
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
    .index("by_sendStatus_undoDeadline", ["sendStatus", "undoDeadlineAt"])
    .index("by_account_fromAddress", ["accountId", "fromAddress"])
    .index("by_account_fromName", ["accountId", "fromName"]),

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
    .index("by_status_sendAt", ["status", "sendAt"]),

  // ───────────────────────────────────────────────────────────────────────────
  // AI categorization & routing
  // ───────────────────────────────────────────────────────────────────────────
  emailClassifications: defineTable({
    emailId: v.id("emails"),
    category: v.string(),
    confidence: v.number(),
    urgency: v.string(), // "low" | "normal" | "high" | "urgent"
    summary: v.optional(v.string()),
    manualOverride: v.boolean(),
    overriddenBy: v.optional(v.string()),
  })
    .index("by_email", ["emailId"])
    .index("by_category", ["category"])
    .index("by_urgency", ["urgency"]),

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
});
