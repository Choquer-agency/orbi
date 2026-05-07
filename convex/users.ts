import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Users — ported from packages/backend/src/routes/auth/index.ts (`me`)
// and packages/backend/src/routes/users/index.ts (search + updateProfile).
//
// NOTE: login/register were intentionally NOT ported. Convex Auth's Password
// provider (configured in convex/auth.ts) handles sign-in/sign-up. The seed
// file in prisma/seed.ts created users with bcrypt password hashes via Prisma;
// those are NOT migrated here. New users sign up fresh through Convex Auth.
// Phase 6 testing will cover this.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/auth/me  →  me()
 * Returns the currently signed-in user's profile.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");

    return {
      id: user._id,
      email: user.email ?? null,
      name: user.name ?? null,
      role: user.role ?? "AGENT",
      avatarUrl: user.avatarUrl ?? null,
      displayName: user.displayName ?? null,
    };
  },
});

/**
 * GET /api/users?search=…  →  list({ search })
 * Used by the @-mention picker, assignment selector, etc. Returns a public-
 * shape list of all users (or filtered by name/email substring).
 */
export const list = query({
  args: {
    search: v.optional(v.string()),
  },
  handler: async (ctx, { search }) => {
    await requireUser(ctx);
    const all = await ctx.db.query("users").collect();

    const filtered = search
      ? all.filter((u) => {
          const needle = search.toLowerCase();
          return (
            (u.name ?? "").toLowerCase().includes(needle) ||
            (u.email ?? "").toLowerCase().includes(needle)
          );
        })
      : all;

    return filtered
      .map((u) => ({
        id: u._id,
        name: u.name ?? null,
        email: u.email ?? null,
        avatarUrl: u.avatarUrl ?? null,
        role: u.role ?? "AGENT",
      }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  },
});

/**
 * PATCH /api/users/me  →  updateProfile({ name, avatarUrl })
 * Update the current user's display name and/or avatar (data: URL only).
 */
export const updateProfile = mutation({
  args: {
    name: v.optional(v.string()),
    avatarUrl: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { name, avatarUrl }) => {
    const userId = await requireUser(ctx);

    const updates: Partial<{ name: string; avatarUrl: string | undefined }> = {};

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Name cannot be empty");
      updates.name = trimmed;
    }

    if (avatarUrl !== undefined) {
      if (avatarUrl === null || avatarUrl === "") {
        updates.avatarUrl = undefined;
      } else {
        if (!avatarUrl.startsWith("data:image/")) {
          throw new Error("Avatar must be a data:image URL");
        }
        if (avatarUrl.length > 512_000) {
          throw new Error("Avatar too large (max ~500KB)");
        }
        updates.avatarUrl = avatarUrl;
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new Error("No valid fields to update");
    }

    await ctx.db.patch(userId, updates);
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found after update");

    return {
      id: user._id,
      name: user.name ?? null,
      email: user.email ?? null,
      role: user.role ?? "AGENT",
      avatarUrl: user.avatarUrl ?? null,
    };
  },
});
