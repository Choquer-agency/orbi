import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

// Email + password login matches the existing Orbi UX (admin@orbi.agency / orbi2024).
// Mailbox OAuth (connecting Gmail/Microsoft accounts to read mail) is a separate flow
// in convex/oauth/* — that's NOT login, it's per-account token storage.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
});
