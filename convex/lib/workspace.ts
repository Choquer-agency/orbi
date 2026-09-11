// ─────────────────────────────────────────────────────────────────────────────
// workspace.ts — the Team Hub entitlement gate + mailbox-visibility rules.
//
// Every team endpoint calls one of these BEFORE touching data. The UI hiding
// a button is never the gate: an account whose workspace lacks the
// "team_hub" feature (or that has no workspace at all) gets a hard throw /
// false from here, so the endpoints simply don't exist for them.
//
// Visibility rule (the org tree):
//   - You always see your own mailbox.
//   - The workspace OWNER sees every member's mailbox.
//   - A user sees the mailboxes of everyone in their managerUserId subtree
//     (their direct reports, their reports' reports, …).
//   - Peers / other branches never see each other.
//
// Cost: all point reads. The chain walk is capped at MAX_CHAIN_DEPTH user
// docs; typical checks are 3-5 ctx.db.get calls total.
// ─────────────────────────────────────────────────────────────────────────────

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const TEAM_HUB_FEATURE = "team_hub";
const MAX_CHAIN_DEPTH = 10;

type DbCtx = Pick<QueryCtx, "db">;

export function workspaceHasFeature(
  workspace: Doc<"workspaces"> | null | undefined,
  feature: string,
): boolean {
  return !!workspace && (workspace.features ?? []).includes(feature);
}

/** Load the caller's user doc + workspace. Either may be null. */
export async function getWorkspaceForUser(
  ctx: DbCtx,
  userId: Id<"users">,
): Promise<{ user: Doc<"users"> | null; workspace: Doc<"workspaces"> | null }> {
  const user = (await ctx.db.get(userId)) as Doc<"users"> | null;
  const workspace = user?.workspaceId
    ? ((await ctx.db.get(user.workspaceId)) as Doc<"workspaces"> | null)
    : null;
  return { user, workspace };
}

/**
 * Hard gate for every Team Hub endpoint. Throws unless the caller belongs to
 * a workspace that holds the team_hub entitlement.
 */
export async function requireTeamHub(
  ctx: DbCtx,
  userId: Id<"users">,
): Promise<{ user: Doc<"users">; workspace: Doc<"workspaces"> }> {
  const { user, workspace } = await getWorkspaceForUser(ctx, userId);
  if (!user || !workspaceHasFeature(workspace, TEAM_HUB_FEATURE)) {
    throw new Error("Access denied");
  }
  return { user, workspace: workspace! };
}

/**
 * True when `viewer` may look inside `target`'s mailbox: same entitled
 * workspace AND (viewer is the workspace owner OR an ancestor on the
 * target's manager chain). Self is always true.
 */
export async function canViewUserMailbox(
  ctx: DbCtx,
  viewerId: Id<"users">,
  targetUserId: Id<"users">,
): Promise<boolean> {
  if (viewerId === targetUserId) return true;
  const { user: viewer, workspace } = await getWorkspaceForUser(ctx, viewerId);
  if (!viewer || !workspaceHasFeature(workspace, TEAM_HUB_FEATURE)) return false;
  const target = (await ctx.db.get(targetUserId)) as Doc<"users"> | null;
  if (!target || target.workspaceId !== viewer.workspaceId) return false;
  if (workspace!.ownerUserId === viewerId) return true;
  // Owner mail is never inherited through reporting links, including a
  // malformed or legacy link that puts an employee above the owner.
  if (workspace!.ownerUserId === targetUserId) return false;
  // Walk the target's manager chain upward looking for the viewer.
  let cursor: Id<"users"> | undefined = target.managerUserId;
  const visited = new Set<Id<"users">>([targetUserId]);
  for (let depth = 0; cursor && depth < MAX_CHAIN_DEPTH; depth++) {
    if (visited.has(cursor)) return false;
    visited.add(cursor);
    const next = await ctx.db.get(cursor);
    if (!next || next.workspaceId !== viewer.workspaceId) return false;
    if (cursor === viewerId) return true;
    if (cursor === workspace!.ownerUserId) return false;
    cursor = next.managerUserId;
  }
  return false;
}

/**
 * Every workspace member whose mailbox the viewer may open (self excluded).
 * Reads the workspace's user rows once (tiny table, indexed by_workspace)
 * and resolves the subtree in memory — no per-member chain walks.
 */
export async function listViewableMembers(
  ctx: DbCtx,
  viewerId: Id<"users">,
): Promise<Doc<"users">[]> {
  const { user: viewer, workspace } = await getWorkspaceForUser(ctx, viewerId);
  if (!viewer || !workspaceHasFeature(workspace, TEAM_HUB_FEATURE)) return [];
  const members = (await ctx.db
    .query("users")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", viewer.workspaceId))
    .collect()) as Doc<"users">[];
  if (workspace!.ownerUserId === viewerId) {
    return members.filter((m) => m._id !== viewerId);
  }
  // BFS down from the viewer through managerUserId links.
  const byManager = new Map<string, Doc<"users">[]>();
  for (const m of members) {
    if (!m.managerUserId || m._id === workspace!.ownerUserId) continue;
    const key = String(m.managerUserId);
    const list = byManager.get(key) ?? [];
    list.push(m);
    byManager.set(key, list);
  }
  const result: Doc<"users">[] = [];
  const visited = new Set<Id<"users">>([viewerId]);
  const queue = [{ id: viewerId, depth: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= MAX_CHAIN_DEPTH) continue;
    for (const child of byManager.get(String(cur.id)) ?? []) {
      if (visited.has(child._id)) continue;
      visited.add(child._id);
      result.push(child);
      queue.push({ id: child._id, depth: cur.depth + 1 });
    }
  }
  return result;
}
