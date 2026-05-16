"use node";

// ─────────────────────────────────────────────────────────────────────────────
// classifier.ts — port of services/ai/email-classifier.ts.
//
// Two internal actions:
//   - classifyEmail({ emailId })       — basic classification (no user context)
//   - classifyEmailWithContext({ emailId, userId }) — uses recent triage
//     feedback as few-shot examples for personalised triage decisions
//
// Both return the persisted `emailClassifications` row. If a classification
// already exists for the email, it is returned unchanged (idempotent).
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const MODEL = "claude-haiku-4-5-20251001";

const CLASSIFICATION_PROMPT = `You are an email classifier for a digital agency. Classify the incoming email into exactly one category. Respond with JSON only, no markdown.

IMPORTANT: When in doubt, prefer a business category over a triage category. Client and business emails belong in the primary inbox — only classify as marketing/spam when you are confident the email is NOT from a client, vendor, or business contact.

Categories (primary inbox — these stay in the user's inbox):
- revision_request: Client asking for changes to deliverables
- billing: Payment, invoice, or pricing questions
- new_inquiry: Potential new work or project scoping
- project_update: Status updates on ongoing work (includes contract signings, document completions, project milestones from clients or partners)
- meeting_scheduling: Requests to schedule calls or meetings
- feedback: Client providing feedback or sign-off
- support_request: Technical issues or support needs
- internal: Emails from team members
- other: Anything from a real person or business contact that doesn't fit above

Categories (triage — auto-sortable noise; do not create follow-up watches):
- notification: Automated system emails — analytics platforms, CI/CD pipelines, search console, server alerts, app notifications, calendar invites/RSVPs/Google Calendar invitations
- marketing: Newsletters, mailing lists, subscription content, promotional campaigns, sales emails, offers, cold outreach pitches (e.g. TechCrunch digests, Substack, SaaS upgrade nudges, Black Friday deals)
- spam: Unsolicited junk mail, phishing attempts, scam emails

Respond with this exact JSON structure:
{"category": "string", "confidence": 0.0-1.0, "urgency": "low|normal|high|urgent", "summary": "one sentence max 100 chars"}`;

export const TRIAGE_CATEGORIES = ["marketing", "spam", "notification"] as const;
const FOLLOW_UP_SKIP_CATEGORIES = new Set(["marketing", "spam", "notification", "newsletter", "junk"]);
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export function isTriageCategory(cat: string): cat is TriageCategory {
  return (TRIAGE_CATEGORIES as readonly string[]).includes(cat);
}

// Backing queries/mutations live in convex/ai/classifierData.ts.

// ── Actions ─────────────────────────────────────────────────────────────────

interface ParsedClassification {
  category: string;
  confidence: number;
  urgency: string;
  summary: string;
}

function parseModelOutput(text: string): ParsedClassification {
  try {
    const jsonStr = text
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim();
    return JSON.parse(jsonStr) as ParsedClassification;
  } catch {
    return { category: "other", confidence: 0.5, urgency: "normal", summary: "" };
  }
}

function isAnthropicAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
  return status === 401 || message.includes("invalid x-api-key") || message.includes("authentication_error");
}

const CLASSIFIER_UNAVAILABLE_FALLBACK: ParsedClassification = {
  category: "other",
  confidence: 0.2,
  urgency: "normal",
  summary: "AI classifier unavailable",
};

interface ClassificationDoc {
  _id: Id<"emailClassifications">;
  category: string;
  confidence: number;
  urgency: string;
  summary?: string;
  manualOverride: boolean;
  overriddenBy?: string;
}

// Known automated senders that are still actionable. We do not auto-classify
// these as "notification" — they need the LLM (or a future rule) to decide
// whether to surface them and create a follow-up watch.
const ACTIONABLE_AUTOMATED_HINTS = [
  "docusign",
  "hellosign",
  "stripe",
  "invoice",
  "billing",
  "receipts",
  "shopify",
  "plaid",
];

function deterministicNoiseCategory(email: {
  subject: string;
  fromAddress: string;
  fromName?: string;
  bodyText?: string;
  snippet?: string;
}): "notification" | "marketing" | "spam" | null {
  const from = email.fromAddress.toLowerCase();
  const name = (email.fromName || "").toLowerCase();
  const subject = email.subject.toLowerCase();
  const bodyForCheck = (email.bodyText || email.snippet || "").toLowerCase();
  const fromOrName = `${from} ${name}`;
  const isAllowlisted = ACTIONABLE_AUTOMATED_HINTS.some((hint) => fromOrName.includes(hint));

  const isCalendarInvite =
    from.includes("calendar-notification@google.com") ||
    from.includes("calendar-server") ||
    from.includes("calendar-notification") ||
    subject.includes("invitation:") ||
    subject.includes("updated invitation:") ||
    subject.includes("accepted:") ||
    subject.includes("declined:") ||
    /\b(google calendar|calendar invitation|invited you to|has accepted this invitation)\b/i.test(bodyForCheck);
  if (isCalendarInvite) {
    return "notification";
  }

  const isNoReplySender = /(^|[._-])(no-?reply|do-?not-?reply|donotreply)(@|[._-])/.test(from);
  if (isNoReplySender && !isAllowlisted) {
    return "notification";
  }

  // Only treat as marketing when the body has a real unsubscribe link, a
  // list-unsubscribe-style footer, or the sender literally identifies itself
  // as a newsletter. Plain substring "unsubscribe" matched quoted footers in
  // real client replies and forced them to marketing.
  const isMarketingFooter =
    /(click\s+here\s+to\s+)?unsubscribe\b[^\n]{0,80}(here|link|now|from this list|email)/i.test(
      bodyForCheck,
    ) ||
    /to\s+unsubscribe[, ]/i.test(bodyForCheck) ||
    /view (this email )?in (your )?browser/i.test(bodyForCheck);
  const isExplicitNewsletter =
    name.includes("newsletter") || subject.includes("newsletter") || /digest\b/i.test(subject);
  if (!isAllowlisted && (isMarketingFooter || isExplicitNewsletter)) {
    return "marketing";
  }

  return null;
}

async function persistCategoryClassification(
  ctx: any,
  emailId: Id<"emails">,
  category: string,
  confidence: number,
  summary: string,
): Promise<ClassificationDoc | null> {
  return (await ctx.runMutation(internal.ai.classifierData._persistClassification, {
    emailId,
    category,
    confidence,
    urgency: "low",
    summary,
  })) as ClassificationDoc | null;
}

async function persistDeterministicClassification(
  ctx: any,
  emailId: Id<"emails">,
  category: "notification" | "marketing" | "spam",
): Promise<ClassificationDoc | null> {
  return await persistCategoryClassification(
    ctx,
    emailId,
    category,
    // marketing detection is heuristic and occasionally fires on quoted
    // footers in real replies. Keep confidence below the threshold a UI
    // would use to hide the email from review.
    category === "marketing" ? 0.8 : 0.95,
    category === "marketing" ? "Automated marketing email" : "Automated notification",
  );
}

async function recordDeterministicClassification(
  ctx: any,
  userId: Id<"users"> | undefined,
  category: "notification" | "marketing" | "spam",
) {
  try {
    await ctx.runMutation(internal.ai.usageData._record, {
      userId,
      feature: "classifier_deterministic",
      model: "deterministic",
      inputTokens: 0,
      outputTokens: 0,
      providerCallCount: 0,
      metadata: { category },
    });
  } catch {
    // Telemetry must never break classification.
  }
}

function shouldCreateInboundFollowUp(category: string, fromAddress: string): boolean {
  if (FOLLOW_UP_SKIP_CATEGORIES.has(category.toLowerCase())) return false;
  const from = fromAddress.toLowerCase();
  const isNoReplySender = /(^|[._-])(no-?reply|do-?not-?reply|donotreply)(@|[._-])/.test(from);
  return !isNoReplySender;
}

async function recordAiUsage(
  ctx: any,
  userId: Id<"users"> | undefined,
  feature: string,
  inputTokens?: number,
  outputTokens?: number,
  requestId?: string,
  stopReason?: string | null,
) {
  try {
    await ctx.runMutation(internal.ai.usageData._record, {
      userId,
      feature,
      model: MODEL,
      inputTokens,
      outputTokens,
      providerCallCount: 1,
      requestId,
      metadata: {
        stopReason: stopReason ?? null,
        truncated: stopReason === "max_tokens",
      },
    });
  } catch {
    // Never fail classification because telemetry failed.
  }
}

export const classifyEmail = internalAction({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }): Promise<ClassificationDoc | null> => {
    const fetched = (await ctx.runQuery(
      internal.ai.classifierData._getEmailForClassification,
      { emailId },
    )) as {
      email: {
        id: Id<"emails">;
        accountId: Id<"mailAccounts">;
        threadId: Id<"threads">;
        subject: string;
        fromAddress: string;
        fromName?: string;
        bodyText?: string;
        snippet?: string;
        isDraft: boolean;
        sentAt?: number;
      };
      existing: ClassificationDoc | null;
    } | null;
    if (!fetched) throw new Error(`Email ${emailId} not found`);
    if (fetched.existing) return fetched.existing;

    const { email } = fetched;
    const deterministicCategory = deterministicNoiseCategory(email);
    if (deterministicCategory) {
      await recordDeterministicClassification(ctx, undefined, deterministicCategory);
      return await persistDeterministicClassification(ctx, emailId, deterministicCategory);
    }
    const bodyPreview = (email.bodyText || email.snippet || "").slice(0, 500);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let parsed: ParsedClassification;
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: CLASSIFICATION_PROMPT,
        messages: [
          {
            role: "user",
            content: `Subject: ${email.subject}\nFrom: ${email.fromName || ""} <${email.fromAddress}>\nBody: ${bodyPreview}`,
          },
        ],
      });

      await recordAiUsage(
        ctx,
        undefined,
        "classifier",
        response.usage?.input_tokens,
        response.usage?.output_tokens,
        response.id,
        response.stop_reason,
      );

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      parsed = parseModelOutput(text);
    } catch (error) {
      if (!isAnthropicAuthError(error)) throw error;
      console.error("Anthropic classifier auth error; using low-confidence fallback", error);
      parsed = CLASSIFIER_UNAVAILABLE_FALLBACK;
    }
    return (await ctx.runMutation(
      internal.ai.classifierData._persistClassification,
      {
        emailId,
        category: parsed.category,
        confidence: parsed.confidence,
        urgency: parsed.urgency,
        summary: parsed.summary || undefined,
      },
    )) as ClassificationDoc | null;
  },
});

export const classifyEmailWithContext = internalAction({
  args: { emailId: v.id("emails"), userId: v.id("users") },
  handler: async (
    ctx,
    { emailId, userId },
  ): Promise<{
    classification: ClassificationDoc | null;
    isTriageCategory: boolean;
  }> => {
    const fetched = (await ctx.runQuery(
      internal.ai.classifierData._getEmailForClassification,
      { emailId },
    )) as {
      email: {
        id: Id<"emails">;
        accountId: Id<"mailAccounts">;
        threadId: Id<"threads">;
        subject: string;
        fromAddress: string;
        fromName?: string;
        bodyText?: string;
        snippet?: string;
        isDraft: boolean;
        sentAt?: number;
      };
      existing: ClassificationDoc | null;
    } | null;
    if (!fetched) throw new Error(`Email ${emailId} not found`);
    if (fetched.existing) {
      return {
        classification: fetched.existing,
        isTriageCategory: isTriageCategory(fetched.existing.category),
      };
    }

    const recentFeedback = (await ctx.runQuery(
      internal.ai.classifierData._getRecentTriageFeedback,
      { userId },
    )) as Array<{
      subjectSnippet: string;
      senderAddress: string;
      finalCategory: string;
    }>;

    let systemPrompt = CLASSIFICATION_PROMPT;
    if (recentFeedback.length > 0) {
      const examples = recentFeedback
        .map(
          (f) =>
            `- "${f.subjectSnippet}" <${f.senderAddress}> → ${f.finalCategory}`,
        )
        .join("\n");
      systemPrompt += `\n\nLearn from this user's recent triage decisions:\n${examples}`;
    }

    const { email } = fetched;
    const senderRule = (await ctx.runQuery(
      internal.ai.classifierData._getSenderTriageRule,
      { userId, senderAddress: email.fromAddress },
    )) as { category: string; confidence: number; examples: number } | null;
    if (senderRule) {
      const classification = await persistCategoryClassification(
        ctx,
        emailId,
        senderRule.category,
        senderRule.confidence,
        `Matched your previous classification for ${email.fromAddress}`,
      );
      return {
        classification,
        isTriageCategory: isTriageCategory(senderRule.category),
      };
    }

    const deterministicCategory = deterministicNoiseCategory(email);
    if (deterministicCategory) {
      await recordDeterministicClassification(ctx, userId, deterministicCategory);
      const classification = await persistDeterministicClassification(ctx, emailId, deterministicCategory);
      return {
        classification,
        isTriageCategory: true,
      };
    }
    const bodyPreview = (email.bodyText || email.snippet || "").slice(0, 500);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let parsed: ParsedClassification;
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Subject: ${email.subject}\nFrom: ${email.fromName || ""} <${email.fromAddress}>\nBody: ${bodyPreview}`,
          },
        ],
        metadata: { user_id: String(userId) },
      });

      await recordAiUsage(
        ctx,
        userId,
        "classifier",
        response.usage?.input_tokens,
        response.usage?.output_tokens,
        response.id,
        response.stop_reason,
      );

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      parsed = parseModelOutput(text);
    } catch (error) {
      if (!isAnthropicAuthError(error)) throw error;
      console.error("Anthropic classifier auth error; using low-confidence fallback", error);
      parsed = CLASSIFIER_UNAVAILABLE_FALLBACK;
    }
    const classification = (await ctx.runMutation(
      internal.ai.classifierData._persistClassification,
      {
        emailId,
        category: parsed.category,
        confidence: parsed.confidence,
        urgency: parsed.urgency,
        summary: parsed.summary || undefined,
      },
    )) as ClassificationDoc | null;

    if (classification && shouldCreateInboundFollowUp(classification.category, email.fromAddress)) {
      await ctx.runMutation(internal.followUps._ensureWatchForEmail, {
        userId,
        threadId: email.threadId,
        emailId: String(email.id),
        contactEmail: email.fromAddress,
      });
    }

    return {
      classification,
      isTriageCategory: classification
        ? isTriageCategory(classification.category)
        : false,
    };
  },
});
