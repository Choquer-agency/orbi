// Shared thread-access guard: true when the user owns the thread's mail
// account, holds an explicit threadAccess grant (handoff / @mention), OR —
// Team Hub only — sits above the mailbox owner in the workspace org tree
// (workspace owner sees all members; a manager sees their subtree). The
// hierarchy branch is feature-gated inside canViewUserMailbox: accounts
// without the team_hub entitlement never pass it.
// Every function that reads or writes thread-scoped data (comments,
// handoffs, …) must call this — "the thread exists" is not authorization.
import type { Doc, Id } from "../_generated/dataModel";
import { canViewUserMailbox } from "./workspace";

export async function canAccessThread(
  ctx: { db: any },
  userId: Id<"users">,
  thread: Doc<"threads">,
): Promise<boolean> {
  const account = await ctx.db.get(thread.accountId);
  if (!account) return false;
  const owner = (account as Doc<"mailAccounts">).userId;
  if (owner === userId) return true;
  const access = await ctx.db
    .query("threadAccess")
    .withIndex("by_thread_user", (q: any) =>
      q.eq("threadId", thread._id).eq("userId", userId),
    )
    .unique();
  if (access) return true;
  // Team Hub bridge: manager/owner looking into a report's mailbox.
  return await canViewUserMailbox(ctx, userId, owner);
}
