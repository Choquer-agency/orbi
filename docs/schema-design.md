# Convex Schema Design — Orbi Mail

## 1. Summary

- **39 tables** total: 1 extended (`users`), 1 new counter table (`pushDeliveryCounters`), 37 translated from Prisma.
- **~70 indexes** defined (all Prisma `@@index` / `@@unique` mirrored, plus single-field FK indexes that Prisma got from relation syntax).
- **DateTime → Unix ms** everywhere. **Bytes → `_storage`**. **Enums → `v.union(v.literal(...))`**.
- **Key denormalizations**: `threadComments.authorName/authorAvatarUrl/reactionCounts` to avoid 3-level joins.
- **Convex Auth `users` table extended in place** with `role`, `displayName`, `avatarUrl` (per https://labs.convex.dev/auth/setup/schema). Convex Auth's other tables (`authAccounts`, `authSessions`, …) are pulled in via `...authTables`.

## 2. Renames from Prisma

| Prisma model            | Convex table                |
| ----------------------- | --------------------------- |
| `User`                  | `users` (extended)          |
| `Account`               | `mailAccounts` (avoids collision with Convex Auth's `accounts`) |
| `Thread`                | `threads`                   |
| `Email`                 | `emails`                    |
| `Attachment`            | `attachments`               |
| `ThreadComment`         | `threadComments`            |
| `ThreadMention`         | `threadMentions`            |
| `CommentReaction`       | `commentReactions`          |
| `ThreadAccess`          | `threadAccess`              |
| `Notification`          | `notifications`             |
| `WritingPreferences`    | `writingPreferences`        |
| `ContactStyle`          | `contactStyles`             |
| `StyleCorrection`       | `styleCorrections`          |
| `Task`                  | `tasks`                     |
| `ScheduledEmail`        | `scheduledEmails`           |
| `EmailClassification`   | `emailClassifications`      |
| `RoutingRule`           | `routingRules`              |
| `ChatConversation`      | `chatConversations`         |
| `ChatMessage`           | `chatMessages`              |
| `EmailTracking`         | `emailTracking`             |
| `EmailOpen`             | `emailOpens`                |
| `LinkClick`             | `linkClicks`                |
| `FollowUpWatch`         | `followUpWatches`           |
| `FollowUpEvent`         | `followUpEvents`            |
| `MeetingDetection`      | `meetingDetections`         |
| `ThreadHandoff`         | `threadHandoffs`            |
| `OutOfOfficeDelegation` | `outOfOfficeDelegations`    |
| `DelegatedEmail`        | `delegatedEmails`           |
| `AutoReplyLog`          | `autoReplyLogs`             |
| `Person`                | `persons`                   |
| `Contact`               | `contacts`                  |
| `TriageFeedback`        | `triageFeedback`            |
| `TriageSettings`        | `triageSettings`            |
| `TrackingExclusion`     | `trackingExclusions`        |
| `NotificationPreferences` | `notificationPreferences` |
| `BlockedSender`         | `blockedSenders`            |
| `InboxSplit`            | `inboxSplits`               |
| `AiFilter`              | `aiFilters`                 |
| `Snippet`               | `snippets`                  |
| `DeviceToken`           | `deviceTokens`              |
| `PushDeliveryLog`       | `pushDeliveryLogs`          |
| —                       | `pushDeliveryCounters` (NEW) |

## 3. Denormalizations + reasons

- **`threadComments.authorName` / `authorAvatarUrl`** — comment list = thread → comments → author. Storing author name+avatar at insert time means rendering a comment list = single index scan.
- **`threadComments.reactionCounts` (`{emoji: count}`)** — avoids loading the full `commentReactions` table per render. Mutated on add/remove. Full per-user reactions still live in `commentReactions` for the picker UI.
- **`pushDeliveryCounters`** — replaces a Prisma `$queryRaw GROUP BY status, day`. Convex has no SQL GROUP BY; we maintain `(userId, status, date)` counters incrementally. The full `pushDeliveryLogs` table is preserved for debugging.

## 4. Dropped / transformed fields

- `Attachment.content: Bytes` → **dropped**. Replaced by `storageId: v.optional(v.id("_storage"))`. Frontend uses `generateUploadUrl`, server stores the resulting id.
- All `DateTime` → **`v.number()`** (Unix ms). All `@default(now())` and `@updatedAt` semantics move into mutations (Convex's `_creationTime` is automatic for inserts; explicit `updatedAt` is set in mutations).
- All Prisma `Json` → **`v.any()`** (we never query into JSON shapes; flexibility wins).
- All `String[]` → **`v.array(v.string())`**.
- All Prisma `@@unique([...])` → **regular `.index(...)` + uniqueness check in mutation** (Convex doesn't enforce unique at schema level).
- `Person.updatedAt desc` index → relies on **`_creationTime`** ordering on `by_user` (acceptable substitute; if it matters, mutations can write an explicit `updatedAt` field and we add an index).

## 5. Trickiest indexes (most performance-critical)

1. **`threads.by_account_lastMessageAt`** — drives the inbox list. Reverse-iterate for newest-first.
2. **`threads.by_account_isArchived_isTrashed`** — folder views (Inbox vs Archive vs Trash).
3. **`emails.by_thread_receivedAt`** — opening a thread.
4. **`emails.by_sendStatus_undoDeadline`** — undo-send worker scan ("find PENDING_SEND with undoDeadlineAt ≤ now").
5. **`emails.by_account_fromAddress` / `by_account_fromName`** — sender autocomplete + search filters.
6. **`mailAccounts.by_provider_email`** — OAuth callback dedup; uniqueness enforced in mutation.
7. **`scheduledEmails.by_status_sendAt`** — cron picks up due scheduled sends across all users.
8. **`followUpWatches.by_user_status_nextCheckAt`** — hourly follow-up scheduler scan.
9. **`tasks.by_user_status_deadline`** — the "Tasks due" pane.
10. **`pushDeliveryCounters.by_user_date`** — daily push health dashboard.

## 6. Open questions for user review

1. **`signatures.accountIds` typing.** Prisma had `String[]` referencing `mailAccount.id`. I kept `v.array(v.string())` for flexibility but we lose `v.id("mailAccounts")` validation. OK?
2. **`Person.updatedAt desc` index.** Replaced with `_creationTime`-ordered `by_user`. If the contacts list must sort by "recently edited" (not "recently created"), we need an explicit `updatedAt` field + index.
3. **`emailTracking.trackingId` uniqueness.** The pixel endpoint queries by `trackingId` (not `_id`). Indexed; uniqueness must be enforced in the mutation (UUID collision risk = effectively zero).
4. **`emails.providerMessageId` uniqueness.** Indexed via `by_providerMessageId`. Sync worker must check before insert.
5. **`outOfOfficeDelegations.autoReplyScope`** is a free string today. Promote to enum literal union now, or leave as string?
6. **Counter granularity.** `pushDeliveryCounters` is `(userId, status, date)`. If we want global (workspace-wide) health, add a row with `userId = null` or a separate table. Confirm scope.
7. **`chatMessages.role`** is a free string. Tighten to `v.union(v.literal("user"), v.literal("assistant"))`?
