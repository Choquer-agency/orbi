import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

// Email + password login. Mailbox OAuth (connecting Gmail/Microsoft accounts
// to read mail) is a separate flow in convex/oauth/* — that's NOT login,
// it's per-account token storage.
//
// Sign-up is INVITE-ONLY: the createOrUpdateUser callback below rejects new
// registrations unless a PENDING teamInvites row exists for the email (the
// very first user bootstraps as ADMIN so a fresh deployment isn't locked
// out). Accepting an invite applies its role and consumes it.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
  callbacks: {
    async createOrUpdateUser(ctx, args) {
      // Existing account signing in — nothing to change.
      if (args.existingUserId) return args.existingUserId;

      const email = (args.profile.email as string | undefined)
        ?.toLowerCase()
        .trim();
      if (!email) throw new Error("An email address is required to sign up.");

      const anyExistingUser = await ctx.db.query("users").first();

      let role: "ADMIN" | "MANAGER" | "AGENT" = "ADMIN";
      let workspaceId: unknown;
      if (anyExistingUser) {
        // ctx here is typed against AnyDataModel (no schema indexes visible),
        // and the invites table is tiny — a filtered collect is fine.
        const invites = (await ctx.db.query("teamInvites").collect()) as Array<{
          _id: any;
          email: string;
          status: string;
          role: "ADMIN" | "MANAGER" | "AGENT";
          invitedByUserId: any;
        }>;
        const pending = invites.find(
          (i) => i.email === email && i.status === "PENDING",
        );
        if (!pending) {
          throw new Error(
            `Sign-ups are invite-only. Ask a team admin to invite ${email}.`,
          );
        }
        role = pending.role;
        await ctx.db.patch(pending._id, {
          status: "ACCEPTED",
          acceptedAt: Date.now(),
        });
        // New members join the inviter's workspace so team features (which
        // are workspace-scoped) cover them without a manual step.
        const inviter = (await ctx.db.get(pending.invitedByUserId)) as {
          workspaceId?: unknown;
        } | null;
        workspaceId = inviter?.workspaceId;
      }

      return await ctx.db.insert("users", {
        email,
        name: (args.profile.name as string | undefined) ?? undefined,
        role,
        ...(workspaceId ? { workspaceId } : {}),
      });
    },
  },
});
