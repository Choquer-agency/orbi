// ─────────────────────────────────────────────────────────────────────────────
// workspaces.ts — Team Hub workspace endpoints.
//
// EVERYTHING here is feature-gated server-side via lib/workspace.ts:
// `myWorkspace` returns null for non-entitled accounts (so the UI can probe
// without an error), every other endpoint throws "Access denied".
//
// Cost notes (subscribed queries):
//   - myWorkspace / listViewable read the caller's user doc, the workspace
//     doc, and the workspace's user rows (tiny — one row per teammate).
//     They re-run only when a user/workspace doc changes, which is rare
//     (role edits, manager reassignment) — never on mailbox writes.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import { requireUser } from "./lib/auth";
import {
  TEAM_HUB_FEATURE,
  getWorkspaceForUser,
  workspaceHasFeature,
  requireTeamHub,
  listViewableMembers,
  canViewUserMailbox,
} from "./lib/workspace";
import type { Doc, Id } from "./_generated/dataModel";

function publicMember(u: Doc<"users">) {
  return {
    id: u._id,
    name: u.displayName ?? u.name ?? null,
    email: u.email ?? null,
    avatarUrl: u.avatarUrl ?? u.image ?? null,
    role: u.role ?? "AGENT",
    managerUserId: u.managerUserId ?? null,
  };
}

// The single probe the frontend uses to decide whether to show ANY team UI.
// Null for accounts without the entitlement — cheap and leak-free.
export const myWorkspace = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const { user, workspace } = await getWorkspaceForUser(ctx, userId);
    if (!user || !workspaceHasFeature(workspace, TEAM_HUB_FEATURE)) return null;

    const members = (await ctx.db
      .query("users")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace!._id))
      .collect()) as Doc<"users">[];
    const viewable = await listViewableMembers(ctx, userId);
    const viewableIds = new Set(viewable.map((m) => String(m._id)));

    return {
      id: workspace!._id,
      name: workspace!.name,
      features: workspace!.features,
      ownerUserId: workspace!.ownerUserId,
      viewerId: userId,
      viewerIsOwner: workspace!.ownerUserId === userId,
      // Full roster (for the org tree display) with a per-member flag for
      // whether the viewer may open that mailbox.
      members: members
        .map((m) => ({
          ...publicMember(m),
          canView: viewableIds.has(String(m._id)),
          isSelf: m._id === userId,
        }))
        .sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "")),
    };
  },
});

// Explicit check used by the member-inbox view before rendering; also
// returns the target's display info + accounts for the view header.
export const memberMailboxInfo = query({
  args: { memberUserId: v.id("users") },
  handler: async (ctx, { memberUserId }) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    if (!(await canViewUserMailbox(ctx, userId, memberUserId))) {
      throw new Error("Access denied");
    }
    const member = await ctx.db.get(memberUserId);
    if (!member) throw new Error("Access denied");
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", memberUserId))
      .collect();
    return {
      member: publicMember(member as Doc<"users">),
      accounts: accounts.map((a) => ({
        id: a._id,
        email: a.email,
        provider: a.provider,
        displayName: a.displayName ?? null,
        color: a.color ?? null,
        isActive: a.isActive,
        commitmentTrackingEnabled: a.commitmentTrackingEnabled === true,
      })),
    };
  },
});

// Accounts the viewer may configure commitment tracking for: their own plus
// (via the org tree) every viewable member's. Small: one indexed accounts
// read per visible member; re-runs only on account/user doc changes.
export const trackingAccounts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    await requireTeamHub(ctx, userId);
    const viewable = await listViewableMembers(ctx, userId);
    const self = (await ctx.db.get(userId)) as Doc<"users"> | null;
    const members = self ? [self, ...viewable] : viewable;
    const result = await Promise.all(
      members.map(async (m) => {
        const accounts = await ctx.db
          .query("mailAccounts")
          .withIndex("by_user", (q) => q.eq("userId", m._id))
          .collect();
        return {
          member: { ...publicMember(m), isSelf: m._id === userId },
          accounts: accounts
            .filter((a) => a.isActive)
            .map((a) => ({
              id: a._id,
              email: a.email,
              provider: a.provider,
              commitmentTrackingEnabled: a.commitmentTrackingEnabled === true,
            })),
        };
      }),
    );
    return result;
  },
});

// Owner assigns/clears a member's manager. Guards: same workspace, no
// self-management, no cycles (walking the proposed chain must not loop back).
export const setManager = mutation({
  args: {
    memberUserId: v.id("users"),
    managerUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, { memberUserId, managerUserId }) => {
    const userId = await requireUser(ctx);
    const { workspace } = await requireTeamHub(ctx, userId);
    if (workspace.ownerUserId !== userId) {
      throw new Error("Only the workspace owner can change the org structure");
    }
    const member = (await ctx.db.get(memberUserId)) as Doc<"users"> | null;
    if (!member || member.workspaceId !== workspace._id) {
      throw new Error("Member not found");
    }
    if (managerUserId) {
      if (managerUserId === memberUserId) {
        throw new Error("A member can't manage themselves");
      }
      const manager = (await ctx.db.get(managerUserId)) as Doc<"users"> | null;
      if (!manager || manager.workspaceId !== workspace._id) {
        throw new Error("Manager not found");
      }
      // Cycle check: walk up from the proposed manager; hitting the member
      // means the assignment would create a loop.
      let cursor: Id<"users"> | undefined = managerUserId;
      for (let depth = 0; cursor && depth < 10; depth++) {
        if (cursor === memberUserId) {
          throw new Error("That assignment would create a reporting loop");
        }
        const next = (await ctx.db.get(cursor)) as Doc<"users"> | null;
        cursor = next?.managerUserId;
      }
    }
    await ctx.db.patch(memberUserId, { managerUserId: managerUserId ?? undefined });
    return { ok: true };
  },
});

// Per-account opt-in for the commitments AI detector. The account's owner or
// the workspace owner may toggle it. Never on by default.
export const setCommitmentTracking = mutation({
  args: { accountId: v.id("mailAccounts"), enabled: v.boolean() },
  handler: async (ctx, { accountId, enabled }) => {
    const userId = await requireUser(ctx);
    const { workspace } = await requireTeamHub(ctx, userId);
    const account = await ctx.db.get(accountId);
    if (!account) throw new Error("Account not found");
    const ownerOk = account.userId === userId;
    const workspaceOwnerOk =
      workspace.ownerUserId === userId &&
      (await canViewUserMailbox(ctx, userId, account.userId));
    if (!ownerOk && !workspaceOwnerOk) throw new Error("Access denied");
    await ctx.db.patch(accountId, { commitmentTrackingEnabled: enabled });
    return { ok: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// One-time bootstrap (run from the CLI, never callable from clients):
//   npx convex run --prod workspaces:_setupWorkspace \
//     '{"name":"Choquer","ownerEmail":"bryce@choquer.agency",
//       "memberEmails":["johnny@...","..."],"features":["team_hub"]}'
// Idempotent: reuses an existing workspace with the same name.
// ─────────────────────────────────────────────────────────────────────────────
export const _setupWorkspace = internalMutation({
  args: {
    name: v.string(),
    ownerEmail: v.string(),
    memberEmails: v.array(v.string()),
    features: v.array(v.string()),
  },
  handler: async (ctx, { name, ownerEmail, memberEmails, features }) => {
    const users = (await ctx.db.query("users").collect()) as Doc<"users">[];
    const byEmail = (email: string) =>
      users.find((u) => u.email?.toLowerCase() === email.toLowerCase().trim());

    const owner = byEmail(ownerEmail);
    if (!owner) return { ok: false, reason: `owner ${ownerEmail} not found` };

    const existing = (await ctx.db.query("workspaces").collect()).find(
      (w) => w.name === name,
    );
    let workspaceId: Id<"workspaces">;
    if (existing) {
      workspaceId = existing._id;
      await ctx.db.patch(workspaceId, { ownerUserId: owner._id, features });
    } else {
      workspaceId = await ctx.db.insert("workspaces", {
        name,
        ownerUserId: owner._id,
        features,
      });
    }

    const assigned: string[] = [];
    const missing: string[] = [];
    for (const email of [ownerEmail, ...memberEmails]) {
      const u = byEmail(email);
      if (!u) {
        missing.push(email);
        continue;
      }
      if (u.workspaceId !== workspaceId) {
        await ctx.db.patch(u._id, { workspaceId });
      }
      assigned.push(email);
    }
    return { ok: true, workspaceId, assigned, missing };
  },
});
