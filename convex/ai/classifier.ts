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

IMPORTANT: When in doubt, prefer a business category over a triage category. Client and business emails belong in the primary inbox — only classify as marketing when you are confident the email is NOT from a client, vendor, or business contact.

Spam is NOT one of your categories. The mail provider (Gmail / Outlook) handles spam upstream; trust it. Even if an email looks suspicious or unsolicited, choose the closest non-spam category below.

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

Respond with this exact JSON structure:
{"category": "string"}`;

// Spam is intentionally not in TRIAGE_CATEGORIES — Orbi's Spam folder mirrors
// the upstream provider's spam label directly (see threads.list spam fast path).
// The classifier may still emit "spam" rarely; we coerce it to "marketing"
// in parseModelOutput so it never lands in our triage UI as spam.
export const TRIAGE_CATEGORIES = ["marketing"] as const;
const FOLLOW_UP_SKIP_CATEGORIES = new Set(["marketing", "spam", "notification", "newsletter", "junk"]);
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export function isTriageCategory(cat: string): cat is TriageCategory {
  return (TRIAGE_CATEGORIES as readonly string[]).includes(cat);
}

// Backing queries/mutations live in convex/ai/classifierData.ts.

// ── Actions ─────────────────────────────────────────────────────────────────

interface ParsedClassification {
  category: string;
}

function parseModelOutput(text: string): ParsedClassification {
  try {
    const jsonStr = text
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim();
    const parsed = JSON.parse(jsonStr) as ParsedClassification;
    // Belt-and-suspenders: even though the prompt forbids "spam", the model
    // sometimes returns it anyway. Coerce to marketing so it never leaks
    // into our triage UI as spam (we use the provider's SPAM label for that).
    if (parsed.category === "spam") parsed.category = "marketing";
    return parsed;
  } catch {
    return { category: "other" };
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
};

interface ClassificationDoc {
  _id: Id<"emailClassifications">;
  category: string;
  // Kept optional for back-compat with legacy rows; new writes don't set them.
  confidence?: number;
  urgency?: string;
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

  // ── Sender heuristics ─────────────────────────────────────────────────────
  // Various flavours of "this address never receives replies" — broader than
  // the original no-reply regex. Covers em@, info@, noreply variants, common
  // bounce / mailer pattern, and ESP send-domains (sendgrid, mailgun, etc).
  const isNoReplySender =
    /(^|[._-])(no-?reply|do-?not-?reply|donotreply|noreply)(@|[._-])/.test(from) ||
    /(^|[._-])(mailer-daemon|mailerdaemon|bounce[-_]?\w*|postmaster)@/.test(from) ||
    /@(em|email|mail|mailer|mailing|send|sendgrid\.net|mailgun\.org|mandrillapp\.com|sendinblue\.com|mailchimpapp\.net|amazonses\.com|sparkpostmail\.com|klaviyomail\.com)\./.test(from);
  if (isNoReplySender && !isAllowlisted) {
    return "notification";
  }

  // ── Body / footer heuristics ──────────────────────────────────────────────
  // Wider net for marketing-footer language. Real client replies sometimes
  // quote these in trailing history, so we still require either a phrase
  // structure (not just "unsubscribe") or an explicit list/ESP marker.
  const isMarketingFooter =
    /(click\s+here\s+to\s+)?unsubscribe\b[^\n]{0,80}(here|link|now|from this list|email)/i.test(
      bodyForCheck,
    ) ||
    /to\s+unsubscribe[, ]/i.test(bodyForCheck) ||
    /view (this email )?in (your )?browser/i.test(bodyForCheck) ||
    /manage (your )?(email )?(preferences|subscription|subscriptions)/i.test(bodyForCheck) ||
    /update (your )?(email )?preferences/i.test(bodyForCheck) ||
    /if you no longer wish to receive/i.test(bodyForCheck) ||
    /you (are )?receiv(e|ing) this (email|message) because/i.test(bodyForCheck) ||
    /sent (to|by)[^\n]{0,80}via\s+(mailchimp|sendgrid|klaviyo|hubspot|constant contact|active ?campaign|drip|convertkit|substack|beehiiv)/i.test(bodyForCheck) ||
    /powered by\s+(mailchimp|sendgrid|klaviyo|hubspot|substack|beehiiv|constant contact)/i.test(bodyForCheck);

  // Explicit newsletter/digest signals in the from-name or subject.
  const isExplicitNewsletter =
    name.includes("newsletter") ||
    subject.includes("newsletter") ||
    /\bdigest\b/i.test(subject) ||
    /\b(weekly|monthly|daily)\s+(roundup|summary|update|recap)\b/i.test(subject) ||
    /^\s*\[(newsletter|digest|weekly|monthly|update)\]/i.test(subject);

  if (!isAllowlisted && (isMarketingFooter || isExplicitNewsletter)) {
    return "marketing";
  }

  // ── Notification / system-mail subject heuristics ────────────────────────
  // Generic automated alerts that don't already match the no-reply rule
  // (some real-world systems use a person's name as the from address).
  const isAutomatedSubject =
    /^\s*\[?(alert|notification|reminder|action required|password reset|verify|verification|security alert)/i.test(subject) ||
    /\byour\s+(receipt|order|shipment|tracking|invoice|statement|verification code|security code)\b/i.test(subject) ||
    /\b(welcome to|getting started with|your trial|trial expires|subscription renew)/i.test(subject);
  if (isAutomatedSubject && !isAllowlisted) {
    return "notification";
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
  usage: Anthropic.Usage | undefined,
  requestId?: string,
  stopReason?: string | null,
) {
  try {
    await ctx.runMutation(internal.ai.usageData._record, {
      userId,
      feature,
      model: MODEL,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? undefined,
      cacheReadInputTokens: usage?.cache_read_input_tokens ?? undefined,
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
        // CLASSIFICATION_PROMPT is identical across every classifier call —
        // mark it cacheable so Anthropic only bills 10% on cache reads and
        // we don't re-upload it on every per-email call. 5 min TTL.
        system: [
          {
            type: "text",
            text: CLASSIFICATION_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
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
        response.usage,
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
      { emailId, category: parsed.category },
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

    // User-set sender / domain override — skip Claude entirely and persist
    // the forced category so future renders are instant. Cheap + zero AI tokens.
    const override = (await ctx.runQuery(
      internal.ai.classifierData._getSenderOverride,
      { userId, fromAddress: fetched.email.fromAddress },
    )) as { category: string; kind: "email" | "domain" } | null;
    if (override) {
      const classification = (await ctx.runMutation(
        internal.ai.classifierData._persistClassification,
        {
          emailId,
          category: override.category,
          manualOverride: true,
        },
      )) as ClassificationDoc;
      return {
        classification,
        isTriageCategory: isTriageCategory(override.category),
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

    // Split the system prompt into a stable (cacheable) prefix and a
    // per-user dynamic suffix. The stable block is identical for every
    // classification call across all users so Anthropic should serve it
    // from the prompt cache after the first request in each 5-min window.
    //
    // Note: Anthropic ignores cache_control blocks below the model
    // minimum (2048 tokens for Haiku, 1024 for Sonnet). Today
    // CLASSIFICATION_PROMPT is under that threshold so caching is a no-op
    // here; we keep the marker so it activates automatically if the
    // prompt grows.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: CLASSIFICATION_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ];
    if (recentFeedback.length > 0) {
      const examples = recentFeedback
        .map(
          (f) =>
            `- "${f.subjectSnippet}" <${f.senderAddress}> → ${f.finalCategory}`,
        )
        .join("\n");
      systemBlocks.push({
        type: "text",
        text: `\n\nLearn from this user's recent triage decisions:\n${examples}`,
      });
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
        system: systemBlocks,
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
        response.usage,
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
      { emailId, category: parsed.category },
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
