import { scheduleClientRefresh } from "./clientQueue";
// ─────────────────────────────────────────────────────────────────────────────
// inboxStamp.ts — the "sticker" (2026-07-10 read-cost fix).
//
// A thread's inbox membership used to be derived at READ time by checking six
// fields — which forced the inbox query to fetch a wide window of threads and
// filter in code, re-reading hundreds of rows on every mailbox write. These
// helpers compute the verdict once at WRITE time instead:
//
//   inboxAt        = lastReceivedAt while the thread belongs in the inbox,
//                    undefined otherwise. Indexed (by_account_inbox), so the
//                    inbox page reads EXACTLY the rows it shows.
//   unreadInboxAt  = same, but only while unread. Indexed for the badge.
//
// EVERY mutation that touches isTrashed / isArchived / snoozedUntil / isSpam /
// labels / lastReceivedAt / isRead must go through patchThread() (or stamp
// inserts with stampedThreadInsert) — a missed site means a thread silently
// stuck in or out of the inbox until its next write.
// ─────────────────────────────────────────────────────────────────────────────

import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

type ThreadStampSource = Pick<
  Doc<"threads">,
  | "isTrashed"
  | "isArchived"
  | "snoozedUntil"
  | "isSpam"
  | "labels"
  | "lastReceivedAt"
  | "isRead"
>;

export function computeInboxStamp(t: ThreadStampSource): {
  inboxAt: number | undefined;
  unreadInboxAt: number | undefined;
} {
  const inInbox =
    !t.isTrashed &&
    !t.isArchived &&
    !t.snoozedUntil &&
    !t.isSpam &&
    !(t.labels ?? []).includes("SPAM") &&
    t.lastReceivedAt !== undefined;
  return {
    inboxAt: inInbox ? t.lastReceivedAt : undefined,
    unreadInboxAt: inInbox && t.isRead === false ? t.lastReceivedAt : undefined,
  };
}

/** Apply a thread patch, then re-stamp the inbox verdict from the result. */
export async function patchThread(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  patch: Partial<Doc<"threads">>,
): Promise<void> {
  await ctx.db.patch(threadId, patch);
  const t = await ctx.db.get(threadId);
  if (!t) return;
  if (patch.isTrashed !== undefined || patch.isSpam !== undefined || patch.labels !== undefined) {
    await scheduleClientRefresh(ctx, threadId);
  }
  const stamp = computeInboxStamp(t);
  if (
    (t.inboxAt ?? undefined) !== stamp.inboxAt ||
    (t.unreadInboxAt ?? undefined) !== stamp.unreadInboxAt
  ) {
    await ctx.db.patch(threadId, stamp);
  }
}

/** Stamp a to-be-inserted thread document. */
export function stampedThreadInsert<T extends ThreadStampSource>(
  data: T,
): T & { inboxAt?: number; unreadInboxAt?: number } {
  return { ...data, ...computeInboxStamp(data) };
}
