import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';

const MODEL = 'claude-haiku-4-5-20251001';

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

/** Categories that map to triage folders. */
export const TRIAGE_CATEGORIES = ['marketing', 'spam'] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export function isTriageCategory(cat: string): cat is TriageCategory {
  return (TRIAGE_CATEGORIES as readonly string[]).includes(cat);
}

export class EmailClassifier {
  private client: Anthropic;
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    this.prisma = prisma;
  }

  async classify(emailId: string) {
    const email = await this.prisma.email.findUnique({
      where: { id: emailId },
      select: {
        id: true,
        subject: true,
        fromAddress: true,
        fromName: true,
        bodyText: true,
        snippet: true,
      },
    });

    if (!email) {
      throw new Error(`Email ${emailId} not found`);
    }

    // Check if already classified
    const existing = await this.prisma.emailClassification.findUnique({
      where: { emailId },
    });
    if (existing) return existing;

    const bodyPreview = (email.bodyText || email.snippet || '').slice(0, 500);

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `Subject: ${email.subject}\nFrom: ${email.fromName || ''} <${email.fromAddress}>\nBody: ${bodyPreview}`,
        },
      ],
      system: CLASSIFICATION_PROMPT,
    });

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    let parsed: { category: string; confidence: number; urgency: string; summary: string };
    try {
      // Handle potential markdown code blocks
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      parsed = { category: 'other', confidence: 0.5, urgency: 'normal', summary: '' };
    }

    const classification = await this.prisma.emailClassification.create({
      data: {
        emailId,
        category: parsed.category,
        confidence: parsed.confidence,
        urgency: parsed.urgency,
        summary: parsed.summary || null,
      },
    });

    return classification;
  }

  /**
   * Classify with user-specific feedback context for improved triage accuracy.
   * Fetches recent TriageFeedback as few-shot examples to personalise the prompt.
   */
  async classifyWithContext(emailId: string, userId: string) {
    const email = await this.prisma.email.findUnique({
      where: { id: emailId },
      select: {
        id: true,
        subject: true,
        fromAddress: true,
        fromName: true,
        bodyText: true,
        snippet: true,
      },
    });

    if (!email) {
      throw new Error(`Email ${emailId} not found`);
    }

    // Return existing classification if present
    const existing = await this.prisma.emailClassification.findUnique({
      where: { emailId },
    });
    if (existing) {
      return {
        classification: existing,
        isTriageCategory: isTriageCategory(existing.category),
      };
    }

    // Fetch recent feedback to inject as few-shot examples
    const recentFeedback = await this.prisma.triageFeedback.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    let systemPrompt = CLASSIFICATION_PROMPT;

    if (recentFeedback.length > 0) {
      const examples = recentFeedback
        .map((f) => `- "${f.subjectSnippet}" <${f.senderAddress}> → ${f.finalCategory}`)
        .join('\n');
      systemPrompt += `\n\nLearn from this user's recent triage decisions:\n${examples}`;
    }

    const bodyPreview = (email.bodyText || email.snippet || '').slice(0, 500);

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `Subject: ${email.subject}\nFrom: ${email.fromName || ''} <${email.fromAddress}>\nBody: ${bodyPreview}`,
        },
      ],
      system: systemPrompt,
    });

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    let parsed: { category: string; confidence: number; urgency: string; summary: string };
    try {
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      parsed = { category: 'other', confidence: 0.5, urgency: 'normal', summary: '' };
    }

    const classification = await this.prisma.emailClassification.create({
      data: {
        emailId,
        category: parsed.category,
        confidence: parsed.confidence,
        urgency: parsed.urgency,
        summary: parsed.summary || null,
      },
    });

    return {
      classification,
      isTriageCategory: isTriageCategory(classification.category),
    };
  }
}
