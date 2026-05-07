import { getAuthUserId } from "@convex-dev/auth/server";
import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";

/**
 * Equivalent of the Fastify `authenticate` preHandler.
 * Call at the top of every protected query/mutation/action.
 *
 * Throws "Unauthorized" if not signed in.
 * Returns the Convex Auth user id (= Id<"users">).
 */
export async function requireUser(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthorized");
  return userId;
}
