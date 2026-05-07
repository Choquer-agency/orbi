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
- notification: Automated system emails — analytics platforms, CI/CD pipelines, search console, server alerts, app notifications
- other: Anything from a real person or business contact that doesn't fit above

Categories (triage — auto-sortable noise):
- marketing: Newsletters, mailing lists, subscription content, promotional campaigns, sales emails, offers, cold outreach pitches (e.g. TechCrunch digests, Substack, SaaS upgrade nudges, Black Friday deals)
- spam: Unsolicited junk mail, phishing attempts, scam emails

Respond with this exact JSON structure:
{"category": "string", "confidence": 0.0-1.0, "urgency": "low|normal|high|urgent", "summary": "one sentence max 100 chars"}`;

export const TRIAGE_CATEGORIES = ["marketing", "spam"] as const;
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

interface ClassificationDoc {
  _id: Id<"emailClassifications">;
  category: string;
  confidence: number;
  urgency: string;
  summary?: string;
  manualOverride: boolean;
  overriddenBy?: string;
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
        subject: string;
        fromAddress: string;
        fromName?: string;
        bodyText?: string;
        snippet?: string;
      };
      existing: ClassificationDoc | null;
    } | null;
    if (!fetched) throw new Error(`Email ${emailId} not found`);
    if (fetched.existing) return fetched.existing;

    const { email } = fetched;
    const bodyPreview = (email.bodyText || email.snippet || "").slice(0, 500);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parsed = parseModelOutput(text);
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
        subject: string;
        fromAddress: string;
        fromName?: string;
        bodyText?: string;
        snippet?: string;
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
    const bodyPreview = (email.bodyText || email.snippet || "").slice(0, 500);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parsed = parseModelOutput(text);
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
    return {
      classification,
      isTriageCategory: classification
        ? isTriageCategory(classification.category)
        : false,
    };
  },
});
