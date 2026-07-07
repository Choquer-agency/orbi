// Shared thread-access guard: true when the user owns the thread's mail
// account OR holds an explicit threadAccess grant (handoff / @mention).
// Every function that reads or writes thread-scoped data (comments,
// handoffs, …) must call this — "the thread exists" is not authorization.
import type { Doc, Id } from "../_generated/dataModel";

export async function canAccessThread(
  ctx: { db: any },
  userId: Id<"users">,
  thread: Doc<"threads">,
): Promise<boolean> {
  const account = await ctx.db.get(thread.accountId);
  if (account && (account as Doc<"mailAccounts">).userId === userId) {
    return true;
  }
  const access = await ctx.db
    .query("threadAccess")
    .withIndex("by_thread_user", (q: any) =>
      q.eq("threadId", thread._id).eq("userId", userId),
    )
    .unique();
  return !!access;
}
