import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { buildThreadContext } from './thread-context.js';
import { buildStyleContext } from './style-context.js';

const SYSTEM_PROMPT = `You are an email assistant for a professional agency.
Draft an email based on the user's instructions.

Rules:
- Write only the email body. No subject line in the body.
- Do not include a signature — that is added separately.
- Match the formality and tone of the existing thread (if replying).
- If replying, address the specific points from the previous email.
- Keep it concise unless the user asks for detail.
- Use proper email formatting (greeting, body, sign-off).
- Return HTML formatted for email. Use separate <p> tags for each paragraph — every paragraph must be its own <p>...</p> block. Do NOT use <br> between paragraphs. This ensures proper spacing.
- If you don't have enough context, write the best draft you can and note what might need adjustment.
- Follow the user's writing style preferences provided below.`;

export class DraftAssistant {
  private client: Anthropic;

  constructor(private prisma: PrismaClient) {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  async generateDraft(params: {
    instruction: string;
    threadId: string | null;
    accountId: string;
    userId?: string;
  }) {
    let threadContext = '';

    if (params.threadId) {
      const result = await buildThreadContext(this.prisma, params.threadId);
      threadContext = result.contextText;
    }

    // Build style context if we have a userId
    let styleContext = '';
    let correctionsApplied = 0;
    if (params.userId) {
      // Try to find primary recipient from thread context
      let contactEmail: string | undefined;
      if (params.threadId) {
        const thread = await this.prisma.thread.findUnique({
          where: { id: params.threadId },
          select: { participantEmails: true },
        });
        contactEmail = thread?.participantEmails.find(
          (e) => !e.endsWith('@orbi.agency'),
        );
      }
      const styleResult = await buildStyleContext(this.prisma, params.userId, contactEmail);
      styleContext = styleResult.contextText;
      correctionsApplied = styleResult.correctionCount;
    }

    const systemParts = [SYSTEM_PROMPT];
    if (styleContext) {
      systemParts.push(`\n\n${styleContext}`);
    }

    const userMessage = threadContext
      ? `Thread context:\n${threadContext}\n\nUser's instruction:\n${params.instruction}\n\nDraft the email reply.`
      : `User's instruction:\n${params.instruction}\n\nDraft the email.`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemParts.join(''),
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
      correctionsApplied,
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
