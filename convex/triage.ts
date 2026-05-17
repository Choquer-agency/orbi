// ─────────────────────────────────────────────────────────────────────────────
// triage.ts — port of routes/triage/index.ts.
//
// Settings, suggestions (which calls the classifier action), feedback CRUD,
// and stats. The "suggestion" path is an action because it calls the
// classifier; everything else is a query/mutation.
// ─────────────────────────────────────────────────────────────────────────────

import {
  query,
  mutation,
  action,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import { isTriageCategory } from "./ai/classifier";

// ── Settings ────────────────────────────────────────────────────────────────

export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const settings = await ctx.db
      .query("triageSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return (
      settings ?? {
        autoSortEnabled: false,
        confidenceThreshold: 0.85,
      }
    );
  },
});

export const updateSettings = mutation({
  args: {
    autoSortEnabled: v.optional(v.boolean()),
    confidenceThreshold: v.optional(v.number()),
  },
  handler: async (ctx, { autoSortEnabled, confidenceThreshold }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("triageSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const clamped =
      confidenceThreshold !== undefined
        ? Math.max(0.5, Math.min(0.95, confidenceThreshold))
        : undefined;

    if (existing) {
      const updates: Record<string, unknown> = {};
      if (autoSortEnabled !== undefined) updates.autoSortEnabled = autoSortEnabled;
      if (clamped !== undefined) updates.confidenceThreshold = clamped;
      await ctx.db.patch(existing._id, updates);
      return await ctx.db.get(existing._id);
    }
    const id = await ctx.db.insert("triageSettings", {
      userId,
      autoSortEnabled: autoSortEnabled ?? false,
      confidenceThreshold: clamped ?? 0.85,
    });
    return await ctx.db.get(id);
  },
});

// ── Suggestion (action — calls Anthropic via classifier) ────────────────────

export const getSuggestion = action({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);

    const prep: {
      latestEmailId: string | null;
      existingTriageLabel: string | null;
      overrideCategory: string | null;
      threshold: number;
    } = await ctx.runQuery(internal.triage._prepSuggestion, {
      userId,
      threadId,
    });

    if (!prep.latestEmailId) {
      throw new Error("No emails in thread");
    }

    if (prep.existingTriageLabel) {
      return {
        category: prep.existingTriageLabel,
        confidence: 1.0,
        isTriageCategory: true,
        alreadyFiled: true,
      };
    }

    // User-set sender / domain override beats the AI classifier.
    if (prep.overrideCategory) {
      return {
        category: prep.overrideCategory,
        confidence: 1.0,
        isTriageCategory: isTriageCategory(prep.overrideCategory),
        alreadyFiled: true,
      };
    }

    const result: {
      classification: {
        category: string;
        confidence?: number;
        summary?: string;
      } | null;
      isTriageCategory: boolean;
    } = await ctx.runAction(internal.ai.classifier.classifyEmailWithContext, {
      emailId: prep.latestEmailId as import("./_generated/dataModel").Id<"emails">,
      userId,
    });

    if (!result.classification) {
      throw new Error("Classification failed");
    }

    // Confidence is no longer stored on new rows; default to 1.0 so existing
    // callers that compare against the user's threshold keep working.
    const confidence = result.classification.confidence ?? 1.0;
    return {
      category: result.classification.category,
      confidence,
      summary: result.classification.summary,
      isTriageCategory: result.isTriageCategory,
      meetsThreshold: confidence >= prep.threshold,
      alreadyFiled: false,
    };
  },
});

// Internal helper for getSuggestion: returns the latest email + existing label
// + current threshold in one query so the action can stay lean.
export const _prepSuggestion = internalQuery({
  args: { userId: v.id("users"), threadId: v.id("threads") },
  handler: async (ctx, { userId, threadId }) => {
    const thread = await ctx.db.get(threadId);
    const emails = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", threadId))
      .order("desc")
      .take(1);
    const latest = emails[0];

    const existingTriage =
      thread?.labels.find((l) => l.startsWith("triage:"))?.replace("triage:", "") ||
      null;

    const settings = await ctx.db
      .query("triageSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    // Per-user sender / domain overrides win over the AI classifier. If the
    // latest email's from-address matches either an exact-email or domain
    // pattern, return the forced category and we skip Claude entirely below.
    let overrideCategory: string | null = null;
    if (latest?.fromAddress) {
      const addr = latest.fromAddress.toLowerCase().trim();
      const domain = addr.includes("@") ? `@${addr.split("@")[1]}` : "";
      const overrides = await ctx.db
        .query("senderTriageOverrides")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      for (const o of overrides) {
        if (o.kind === "email" && o.pattern === addr) {
          overrideCategory = o.forceCategory;
          break;
        }
        if (o.kind === "domain" && domain && o.pattern === domain) {
          overrideCategory = o.forceCategory;
          // Don't break — an exact-email override should still take precedence,
          // so keep looping in case we hit one.
        }
      }
    }

    return {
      latestEmailId: latest?._id ?? null,
      existingTriageLabel: existingTriage,
      overrideCategory,
      threshold: settings?.confidenceThreshold ?? 0.85,
    };
  },
});

// ── Feedback ────────────────────────────────────────────────────────────────

export const submitFeedback = mutation({
  args: {
    emailId: v.optional(v.id("emails")),
    threadId: v.optional(v.id("threads")),
    suggestedCategory: v.string(),
    finalCategory: v.string(),
    wasConfirmed: v.boolean(),
    senderAddress: v.optional(v.string()),
    // Optional: persist a permanent sender override so this category sticks
    // for future emails matching `allowPattern`. Set by the "always allow"
    // dialog when the user pulls an email out of Spam.
    allowPattern: v.optional(v.string()),
    allowKind: v.optional(v.union(v.literal("email"), v.literal("domain"))),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    let senderAddress = args.senderAddress ?? "";
    let subjectSnippet = "";
    if (args.emailId) {
      const email = await ctx.db.get(args.emailId);
      if (email) {
        senderAddress = email.fromAddress;
        subjectSnippet = (email.subject || "").slice(0, 100);
      }
    } else {
      subjectSnippet = "(manual rule)";
    }

    await ctx.db.insert("triageFeedback", {
      userId,
      emailId: args.emailId,
      threadId: args.threadId,
      suggestedCategory: args.suggestedCategory,
      finalCategory: args.finalCategory,
      wasConfirmed: args.wasConfirmed,
      senderAddress,
      subjectSnippet,
    });

    if (args.emailId && args.suggestedCategory !== args.finalCategory) {
      const cls = await ctx.db
        .query("emailClassifications")
        .withIndex("by_email", (q) => q.eq("emailId", args.emailId!))
        .unique();
      if (cls) {
        await ctx.db.patch(cls._id, {
          category: args.finalCategory,
          manualOverride: true,
          overriddenBy: userId,
        });
      }
    }

    if (args.threadId && isTriageCategory(args.finalCategory)) {
      const thread = await ctx.db.get(args.threadId);
      if (thread) {
        const filtered = thread.labels.filter((l) => !l.startsWith("triage:"));
        filtered.push(`triage:${args.finalCategory}`);
        await ctx.db.patch(args.threadId, { labels: filtered });
      }
    }

    // Keep the SPAM label on the thread in lockstep with the user's
    // verdict so Orbi's Spam folder (which mirrors that label) reflects
    // what the user just decided. Adding "spam" → ensure SPAM label
    // present; moving out of spam → remove it.
    if (args.threadId) {
      const thread = await ctx.db.get(args.threadId);
      if (thread) {
        const hasSpamLabel = thread.labels.includes("SPAM");
        if (args.finalCategory === "spam" && !hasSpamLabel) {
          await ctx.db.patch(args.threadId, {
            labels: [...thread.labels, "SPAM"],
          });
        } else if (args.finalCategory !== "spam" && hasSpamLabel) {
          await ctx.db.patch(args.threadId, {
            labels: thread.labels.filter((l) => l !== "SPAM"),
          });
        }
      }
    }

    // Optional permanent override (for the "always allow this sender / domain"
    // prompt that fires when pulling an email out of Spam). Upsert so the
    // user can flip the same pattern between categories without piling rows.
    if (args.allowPattern && args.allowKind) {
      const normalized = args.allowPattern.toLowerCase().trim();
      const existing = await ctx.db
        .query("senderTriageOverrides")
        .withIndex("by_user_pattern", (q) =>
          q.eq("userId", userId).eq("pattern", normalized),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          kind: args.allowKind,
          forceCategory: args.finalCategory,
        });
      } else {
        await ctx.db.insert("senderTriageOverrides", {
          userId,
          kind: args.allowKind,
          pattern: normalized,
          forceCategory: args.finalCategory,
        });
      }
    }

    // Count user feedback (bounded by user index)
    const all = await ctx.db
      .query("triageFeedback")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    return { success: true, feedbackCount: all.length };
  },
});

export const getStats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const all = await ctx.db
      .query("triageFeedback")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return { feedbackCount: all.length };
  },
});

export const listFeedback = query({
  args: {
    page: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { page, limit }) => {
    const userId = await requireUser(ctx);
    const take = Math.min(limit ?? 20, 100);
    const skip = (Math.max(page ?? 1, 1) - 1) * take;

    const all = await ctx.db
      .query("triageFeedback")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    const data = all.slice(skip, skip + take);
    return {
      data,
      meta: {
        total: all.length,
        page: Math.max(page ?? 1, 1),
        limit: take,
        totalPages: Math.ceil(all.length / take),
      },
    };
  },
});

export const updateFeedback = mutation({
  args: {
    id: v.id("triageFeedback"),
    finalCategory: v.string(),
  },
  handler: async (ctx, { id, finalCategory }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db.get(id);
    if (!existing || existing.userId !== userId) {
      throw new Error("Feedback not found");
    }
    await ctx.db.patch(id, { finalCategory });
    if (existing.emailId) {
      const cls = await ctx.db
        .query("emailClassifications")
        .withIndex("by_email", (q) =>
          q.eq("emailId", existing.emailId as import("./_generated/dataModel").Id<"emails">),
        )
        .unique();
      if (cls) {
        await ctx.db.patch(cls._id, {
          category: finalCategory,
          manualOverride: true,
          overriddenBy: userId,
        });
      }
    }
    return await ctx.db.get(id);
  },
});

export const deleteFeedback = mutation({
  args: { id: v.id("triageFeedback") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db.get(id);
    if (!existing || existing.userId !== userId) {
      throw new Error("Feedback not found");
    }
    await ctx.db.delete(id);
    return { success: true };
  },
});

// Re-export internalMutation only to keep tooling happy
export const _noop = internalMutation({
  args: {},
  handler: async () => null,
});
