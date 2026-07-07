// ─────────────────────────────────────────────────────────────────────────────
// team.ts — team membership: members list, roles, and invite-only sign-up.
//
// Sign-up enforcement lives in convex/auth.ts (createOrUpdateUser callback):
// registering requires a PENDING teamInvites row for the email. Admins create
// those here; the invitee also receives a real email (sent from the admin's
// own mailbox through the normal send pipeline) telling them to join.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import { insertSystemOutboundEmail } from "./emails";
import type { Doc, Id } from "./_generated/dataModel";

const inviteRole = v.union(
  v.literal("ADMIN"),
  v.literal("MANAGER"),
  v.literal("AGENT"),
);

async function requireAdmin(ctx: {
  db: any;
  auth: any;
}): Promise<Id<"users">> {
  const userId = await requireUser(ctx as any);
  const user = await (ctx as any).db.get(userId);
  if (!user || user.role !== "ADMIN") {
    throw new Error("Admin access required");
  }
  return userId;
}

// Everyone on the team can see who's on the team (needed for @mentions and
// handoffs anyway). Role editing is admin-only (setRole below).
export const listMembers = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const me = await ctx.db.get(userId);
    const all = await ctx.db.query("users").collect();
    return {
      viewerIsAdmin: me?.role === "ADMIN",
      viewerId: userId,
      members: all
        .map((u) => ({
          id: u._id,
          name: u.displayName ?? u.name ?? null,
          email: u.email ?? null,
          avatarUrl: u.avatarUrl ?? u.image ?? null,
          role: u.role ?? "AGENT",
        }))
        .sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "")),
    };
  },
});

export const listInvites = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const pending = await ctx.db
      .query("teamInvites")
      .withIndex("by_status", (q) => q.eq("status", "PENDING"))
      .collect();
    return pending
      .map((i) => ({
        id: i._id,
        email: i.email,
        role: i.role,
        createdAt: i._creationTime,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const invite = mutation({
  args: { email: v.string(), role: inviteRole },
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx);
    const email = args.email.toLowerCase().trim();
    if (!email.includes("@")) throw new Error("Enter a valid email address");

    const existingUser = (await ctx.db.query("users").collect()).find(
      (u) => u.email?.toLowerCase() === email,
    );
    if (existingUser) throw new Error(`${email} is already a team member`);

    const invites = await ctx.db
      .query("teamInvites")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    const pending = invites.find((i) => i.status === "PENDING");
    if (pending) {
      // Re-inviting updates the role and re-sends the email.
      await ctx.db.patch(pending._id, { role: args.role });
    } else {
      await ctx.db.insert("teamInvites", {
        email,
        role: args.role,
        invitedByUserId: adminId,
        status: "PENDING",
      });
    }

    // Send the invite as a real email from the admin's own mailbox.
    await ctx.scheduler.runAfter(0, internal.team._sendInviteEmail, {
      inviterUserId: adminId,
      inviteeEmail: email,
    });
    return { ok: true };
  },
});

export const revokeInvite = mutation({
  args: { id: v.id("teamInvites") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.status !== "PENDING") throw new Error("Invite not found");
    await ctx.db.patch(id, { status: "REVOKED" });
    return { ok: true };
  },
});

export const setRole = mutation({
  args: { userId: v.id("users"), role: inviteRole },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const target = await ctx.db.get(args.userId);
    if (!target) throw new Error("User not found");
    if (target.role === "ADMIN" && args.role !== "ADMIN") {
      // Never demote the last admin — that would orphan team management.
      const all = await ctx.db.query("users").collect();
      const adminCount = all.filter((u) => u.role === "ADMIN").length;
      if (adminCount <= 1) {
        throw new Error("Cannot demote the only admin");
      }
    }
    await ctx.db.patch(args.userId, { role: args.role });
    return { ok: true };
  },
});

// Compose + dispatch the invite email through the normal send pipeline,
// from the inviting admin's first active mail account.
export const _sendInviteEmail = internalMutation({
  args: {
    inviterUserId: v.id("users"),
    inviteeEmail: v.string(),
  },
  handler: async (ctx, { inviterUserId, inviteeEmail }) => {
    const inviter = await ctx.db.get(inviterUserId);
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", inviterUserId))
      .collect();
    const sender = accounts.find((a) => a.isActive);
    if (!sender) {
      console.error(
        "[team] invite email not sent — inviter has no active mail account",
      );
      return;
    }
    const inviterName =
      inviter?.displayName ?? inviter?.name ?? sender.email;
    const appUrl = process.env.SITE_URL ?? "https://orbi-mail.vercel.app";
    const subject = `${inviterName} invited you to Orbi Mail`;
    const bodyText = [
      `${inviterName} has invited you to join their team on Orbi Mail.`,
      ``,
      `To get started:`,
      `1. Open ${appUrl}`,
      `2. Click "Sign up" and register with this email address (${inviteeEmail})`,
      `3. Connect your mailbox and you're in`,
      ``,
      `This invite is tied to ${inviteeEmail} — signing up with a different address won't work.`,
    ].join("\n");
    const bodyHtml = `
      <div style="font-family: -apple-system, Segoe UI, sans-serif; font-size: 14px; color: #1a1a1a; line-height: 1.6;">
        <p><strong>${inviterName}</strong> has invited you to join their team on <strong>Orbi Mail</strong>.</p>
        <p>To get started:</p>
        <ol>
          <li>Open <a href="${appUrl}">${appUrl}</a></li>
          <li>Click <strong>Sign up</strong> and register with this email address (${inviteeEmail})</li>
          <li>Connect your mailbox and you're in</li>
        </ol>
        <p style="color:#666; font-size:12px;">This invite is tied to ${inviteeEmail} — signing up with a different address won't work.</p>
      </div>`;

    await insertSystemOutboundEmail(ctx, {
      accountId: sender._id,
      to: [{ email: inviteeEmail }],
      subject,
      bodyHtml,
      bodyText,
    });
  },
});

// One-time bootstrap: promote an existing user to ADMIN, but ONLY when no
// admin exists yet (pre-team-feature deployments have users with no role).
// Run: npx convex run --prod team:_bootstrapAdmin '{"email":"you@x.com"}'
export const _bootstrapAdmin = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const all = await ctx.db.query("users").collect();
    if (all.some((u) => u.role === "ADMIN")) {
      return { ok: false, reason: "an admin already exists" };
    }
    const target = all.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase().trim(),
    );
    if (!target) return { ok: false, reason: "user not found" };
    await ctx.db.patch(target._id, { role: "ADMIN" });
    return { ok: true };
  },
});
