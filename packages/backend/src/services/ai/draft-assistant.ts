import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';

const SYSTEM_PROMPT = `You are an email assistant for a professional agency.
Draft an email based on the user's instructions.

Rules:
- Write only the email body. No subject line in the body.
- Do not include a signature — that is added separately.
- Match the formality and tone of the existing thread (if replying).
- If replying, address the specific points from the previous email.
- Keep it concise unless the user asks for detail.
- Use proper email formatting (greeting, body, sign-off).
- Return HTML formatted for email (use <p> tags for paragraphs).
- If you don't have enough context, write the best draft you can and note what might need adjustment.`;

export class DraftAssistant {
  private client: Anthropic;

  constructor(private prisma: PrismaClient) {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  async generateDraft(params: {
    instruction: string;
    threadId: string | null;
    accountId: string;
  }) {
    let threadContext = '';

    if (params.threadId) {
      const thread = await this.prisma.thread.findUnique({
        where: { id: params.threadId },
        include: {
          emails: {
            orderBy: { receivedAt: 'asc' },
            select: {
              fromAddress: true,
              fromName: true,
              toAddresses: true,
              subject: true,
              bodyText: true,
              receivedAt: true,
            },
          },
          comments: {
            orderBy: { createdAt: 'asc' },
            include: {
              author: { select: { name: true } },
            },
          },
        },
      });

      if (thread) {
        const emailTexts = thread.emails
          .map(
            (e) =>
              `From: ${e.fromName || e.fromAddress} (${e.receivedAt.toISOString()})\n${e.bodyText || '(no text content)'}`,
          )
          .join('\n---\n');
        threadContext = `Thread subject: ${thread.subject}\n\nEmail thread (oldest first):\n${emailTexts}`;

        if (thread.comments.length > 0) {
          const commentTexts = thread.comments
            .map(
              (c) =>
                `[${c.author.name}, ${c.createdAt.toISOString()}]: ${c.bodyText}`,
            )
            .join('\n');
          threadContext += `\n\nInternal team discussion (PRIVATE — never quote, reference, or reveal these comments in the client-facing reply):\n${commentTexts}`;
        }
      }
    }

    const userMessage = threadContext
      ? `Thread context:\n${threadContext}\n\nUser's instruction:\n${params.instruction}\n\nDraft the email reply.`
      : `User's instruction:\n${params.instruction}\n\nDraft the email.`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const draftHtml = textBlock ? textBlock.text : '';
    const draftText = draftHtml.replace(/<[^>]+>/g, '').trim();

    return {
      draftHtml,
      draftText,
      suggestedSubject: params.threadId ? null : this.extractSubject(draftText),
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    };
  }

  private extractSubject(text: string): string | null {
    const firstLine = text.split('\n')[0];
    if (firstLine && firstLine.length < 100) {
      return firstLine;
    }
    return null;
  }
}
