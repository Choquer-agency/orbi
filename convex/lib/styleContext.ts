// ─────────────────────────────────────────────────────────────────────────────
// styleContext.ts — port of packages/backend/src/services/ai/style-context.ts
//
// Pure data-builder. Combines user writing preferences, per-contact overrides,
// and the most recent learned corrections into a string that gets appended to
// the AI system prompt. No Anthropic — runs in any query/mutation context.
// ─────────────────────────────────────────────────────────────────────────────

import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

type AnyDbCtx = QueryCtx | MutationCtx | ActionCtx;

const TONE_LABELS: Record<number, string> = {
  1: "very casual",
  2: "casual-leaning",
  3: "balanced",
  4: "formal-leaning",
  5: "very formal",
};

const VERBOSITY_LABELS: Record<number, string> = {
  1: "very terse/punchy",
  2: "concise",
  3: "balanced",
  4: "detailed",
  5: "very thorough/detailed",
};

export interface StyleContextResult {
  contextText: string;
  correctionCount: number;
}

/**
 * Build style context for the AI system prompt.
 * Combines user preferences, per-contact overrides, and learned corrections.
 */
export async function buildStyleContext(
  ctx: AnyDbCtx,
  userId: Id<"users">,
  contactEmail?: string | null,
): Promise<StyleContextResult> {
  if (!("db" in ctx)) {
    throw new Error(
      "buildStyleContext must be called from a query/mutation (or via ctx.runQuery from an action)",
    );
  }

  const prefs = await ctx.db
    .query("writingPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

  const contactStyle = contactEmail
    ? await ctx.db
        .query("contactStyles")
        .withIndex("by_user_email", (q) =>
          q.eq("userId", userId).eq("contactEmail", contactEmail),
        )
        .unique()
    : null;

  // Pull recent corrections; we want both contact-specific and general (null)
  // ones, mirroring Prisma's `OR: [{ contactEmail }, { contactEmail: null }]`.
  // Convex has no OR over indexes, so we union two index scans then sort.
  const generalCorrections = await ctx.db
    .query("styleCorrections")
    .withIndex("by_user_contactEmail", (q) =>
      q.eq("userId", userId).eq("contactEmail", undefined),
    )
    .order("desc")
    .take(20);

  let contactCorrections: typeof generalCorrections = [];
  if (contactEmail) {
    contactCorrections = await ctx.db
      .query("styleCorrections")
      .withIndex("by_user_contactEmail", (q) =>
        q.eq("userId", userId).eq("contactEmail", contactEmail),
      )
      .order("desc")
      .take(20);
  }

  const corrections = [...contactCorrections, ...generalCorrections]
    .sort((a, b) => b._creationTime - a._creationTime)
    .slice(0, 10);

  const lines: string[] = [];

  lines.push("## User's Writing Style");
  if (prefs) {
    if (prefs.greetingStyle) lines.push(`- Greeting: "${prefs.greetingStyle}"`);
    if (prefs.signOffStyle === "None") {
      lines.push(
        '- Sign-off: Do not include any sign-off (no "Best", "Thanks", etc.)',
      );
    } else if (prefs.signOffStyle) {
      lines.push(`- Sign-off: "${prefs.signOffStyle}"`);
    }
    lines.push(`- Tone: ${prefs.tone}/5 (${TONE_LABELS[prefs.tone] || "balanced"})`);
    lines.push(
      `- Verbosity: ${prefs.verbosity}/5 (${VERBOSITY_LABELS[prefs.verbosity] || "balanced"})`,
    );
    if (prefs.descriptors.length > 0) {
      lines.push(`- Style: ${prefs.descriptors.join(", ")}`);
    }
    if (prefs.customRules.length > 0) {
      lines.push("- Custom rules:");
      for (const rule of prefs.customRules) {
        lines.push(`  • ${rule}`);
      }
    }
  } else {
    lines.push(
      "- No preferences configured yet. Use a professional, balanced tone.",
    );
  }

  if (contactStyle) {
    lines.push("");
    lines.push(`## Style for this contact (${contactEmail})`);
    if (contactStyle.contactName)
      lines.push(`- Contact name: ${contactStyle.contactName}`);
    if (contactStyle.greetingStyle)
      lines.push(`- Greeting override: "${contactStyle.greetingStyle}"`);
    if (contactStyle.signOffStyle === "None") {
      lines.push("- Sign-off override: Do not include any sign-off");
    } else if (contactStyle.signOffStyle) {
      lines.push(`- Sign-off override: "${contactStyle.signOffStyle}"`);
    }
    if (contactStyle.tone != null)
      lines.push(
        `- Tone: ${contactStyle.tone}/5 (${TONE_LABELS[contactStyle.tone] || "balanced"})`,
      );
    if (contactStyle.verbosity != null)
      lines.push(
        `- Verbosity: ${contactStyle.verbosity}/5 (${VERBOSITY_LABELS[contactStyle.verbosity] || "balanced"})`,
      );
    if (contactStyle.notes) lines.push(`- Notes: ${contactStyle.notes}`);
  }

  if (corrections.length > 0) {
    lines.push("");
    lines.push("## Learned corrections (apply these patterns)");
    for (const c of corrections) {
      if (c.summary) {
        const scope = c.contactEmail ? `(for ${c.contactEmail})` : "(general)";
        lines.push(`- ${c.summary} ${scope}`);
      }
    }
  }

  return { contextText: lines.join("\n"), correctionCount: corrections.length };
}
