import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { buildThreadContext } from './thread-context.js';

const MODEL = 'claude-sonnet-4-6';

const TONE_LABELS: Record<number, { label: string; instruction: string }> = {
  0: {
    label: 'casual',
    instruction: 'Write a casual, light follow-up. Keep it friendly and low-pressure. Something like checking in.',
  },
  1: {
    label: 'direct',
    instruction: 'Write a slightly more direct follow-up. Be polite but clear that you need a response.',
  },
  2: {
    label: 'final',
    instruction: 'Write a final check-in. Be professional but make it clear this is the last follow-up. Suggest next steps if no reply.',
  },
};

export class FollowUpAgent {
  private client: Anthropic;
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    this.prisma = prisma;
  }

  async checkWatch(watchId: string) {
    const watch = await this.prisma.followUpWatch.findUnique({
      where: { id: watchId },
      include: { thread: true },
    });

    if (!watch || watch.status !== 'WATCHING') return null;

    // Check if the contact has replied
    const replyExists = await this.prisma.email.findFirst({
      where: {
        threadId: watch.threadId,
        fromAddress: watch.contactEmail,
        receivedAt: { gt: watch.createdAt },
      },
    });

    if (replyExists) {
      await this.prisma.followUpWatch.update({
        where: { id: watchId },
        data: { status: 'REPLIED', resolvedAt: new Date() },
      });
      await this.prisma.followUpEvent.create({
        data: { watchId, type: 'reply_received' },
      });
      return { status: 'replied' };
    }

    // Check if we've exceeded max follow-ups
    if (watch.currentStep >= watch.intervals.length) {
      await this.prisma.followUpWatch.update({
        where: { id: watchId },
        data: { status: 'EXPIRED', resolvedAt: new Date() },
      });
      return { status: 'expired' };
    }

    // Draft a follow-up
    const draft = await this.draftFollowUp(watch);

    // Advance the step
    const nextStep = watch.currentStep + 1;
    const nextInterval = watch.intervals[nextStep];
    const nextCheckAt = nextInterval
      ? new Date(Date.now() + nextInterval * 24 * 60 * 60 * 1000)
      : new Date(); // no more checks

    await this.prisma.followUpWatch.update({
      where: { id: watchId },
      data: {
        currentStep: nextStep,
        nextCheckAt,
        status: nextStep >= watch.intervals.length ? 'EXPIRED' : 'WATCHING',
      },
    });

    await this.prisma.followUpEvent.create({
      data: {
        watchId,
        type: 'follow_up_drafted',
        draftBody: draft,
        draftTone: TONE_LABELS[watch.currentStep]?.label || 'casual',
      },
    });

    return { status: 'drafted', draft, tone: TONE_LABELS[watch.currentStep]?.label };
  }

  async draftFollowUp(watch: any): Promise<string> {
    const step = Math.min(watch.currentStep, 2);
    const tone = TONE_LABELS[step];

    const threadContext = await buildThreadContext(this.prisma, watch.threadId);

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: `You are drafting a follow-up email for a professional agency.
${tone.instruction}

Context: The original email was sent ${watch.intervals[step] || 3} days ago with no reply from ${watch.contactEmail}.
This is follow-up #${step + 1}.

Return only the email body text, no subject line or signature.`,
      messages: [
        {
          role: 'user',
          content: `Here is the email thread context:\n\n${threadContext}\n\nDraft a follow-up email.`,
        },
      ],
    });

    return response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');
  }
}
