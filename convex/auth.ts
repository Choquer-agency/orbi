import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { internalMutation } from "./_generated/server";

// Email addresses are case-INSENSITIVE in practice, but the Password provider
// stores whatever was typed at sign-up as the account id and then looks it up
// verbatim. Bryce's account was created as "bryce@Choquer.agency", so typing
// the (correct) all-lowercase address failed with InvalidAccountId and read as
// a wrong password (2026-09-11). Normalising here makes sign-up and sign-in
// agree no matter how the address is capitalised.
const PasswordWithNormalizedEmail = Password({
  profile(params) {
    const email = String(params.email ?? "")
      .toLowerCase()
      .trim();
    const out: Record<string, string> & { email: string } = { email };
    const name = params.name;
    if (typeof name === "string" && name.length > 0) out.name = name;
    return out;
  },
});

// Email + password login. Mailbox OAuth (connecting Gmail/Microsoft accounts
// to read mail) is a separate flow in convex/oauth/* — that's NOT login,
// it's per-account token storage.
//
// Sign-up is INVITE-ONLY: the createOrUpdateUser callback below rejects new
// registrations unless a PENDING teamInvites row exists for the email (the
// very first user bootstraps as ADMIN so a fresh deployment isn't locked
// out). Accepting an invite applies its role and consumes it.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [PasswordWithNormalizedEmail],
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

// ─────────────────────────────────────────────────────────────────────────────
// One-off repair (2026-09-11): lowercase any account id / user email that was
// stored with mixed case, so existing accounts can sign in with the address
// people actually type. Safe to re-run — it only touches rows that differ.
//   npx convex run auth:normalizeAccountEmails '{}'
// ─────────────────────────────────────────────────────────────────────────────
export const normalizeAccountEmails = internalMutation({
  args: {},
  handler: async (ctx) => {
    const changed: string[] = [];

    const accounts = await ctx.db.query("authAccounts").collect();
    for (const a of accounts) {
      const id = a.providerAccountId;
      if (typeof id !== "string") continue;
      const lower = id.toLowerCase().trim();
      if (lower === id) continue;
      await ctx.db.patch(a._id, { providerAccountId: lower });
      changed.push(`authAccounts: ${id} -> ${lower}`);
    }

    const users = await ctx.db.query("users").collect();
    for (const u of users) {
      const email = u.email;
      if (typeof email !== "string") continue;
      const lower = email.toLowerCase().trim();
      if (lower === email) continue;
      await ctx.db.patch(u._id, { email: lower });
      changed.push(`users: ${email} -> ${lower}`);
    }

    return { changed, count: changed.length };
  },
});
