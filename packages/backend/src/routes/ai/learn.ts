import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { env } from '../../config/env.js';

const MODEL = 'claude-sonnet-4-6';

const CATEGORIZE_PROMPT = `You are analyzing how a user edited an AI-generated email draft. Compare the original and edited versions, then categorize the changes.

Respond with a JSON object:
{
  "category": one of "greeting", "signoff", "tone", "length", "phrasing", "structure",
  "summary": a single sentence describing the pattern (e.g., "Changed greeting from 'Hi' to 'Hey'"),
  "greeting_changed": the new greeting if changed (e.g., "Hey Rachel"), or null,
  "signoff_changed": the new sign-off if changed (e.g., "Cheers"), or null
}

Pick the most significant category. Focus on what the user consistently prefers.`;

export default async function learnRoutes(app: FastifyInstance) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  app.post('/api/ai/learn', { preHandler: [authenticate] }, async (request, reply) => {
    const { originalText, editedText, contactEmail, threadId } = request.body as {
      originalText: string;
      editedText: string;
      contactEmail?: string;
      threadId?: string;
    };

    if (!originalText || !editedText) {
      return reply.status(400).send({ error: 'Both originalText and editedText are required' });
    }

    // Skip if no meaningful changes
    if (originalText.trim() === editedText.trim()) {
      return { data: { skipped: true, reason: 'No changes detected' } };
    }

    try {
      // Use Claude to categorize the correction
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: `Original draft:\n${originalText.slice(0, 2000)}\n\nEdited version (what user actually sent):\n${editedText.slice(0, 2000)}`,
          },
        ],
        system: CATEGORIZE_PROMPT,
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock) {
        return { data: { skipped: true, reason: 'No analysis returned' } };
      }

      let analysis: {
        category: string;
        summary: string;
        greeting_changed?: string | null;
        signoff_changed?: string | null;
      };
      try {
        // Extract JSON from response (may be wrapped in markdown code block)
        const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
        analysis = JSON.parse(jsonMatch?.[0] || textBlock.text);
      } catch {
        return { data: { skipped: true, reason: 'Could not parse analysis' } };
      }

      // Store the correction
      await app.prisma.styleCorrection.create({
        data: {
          userId: request.user.userId,
          contactEmail: contactEmail || null,
          category: analysis.category,
          originalText: originalText.slice(0, 5000),
          editedText: editedText.slice(0, 5000),
          summary: analysis.summary,
          threadId: threadId || null,
        },
      });

      // Auto-update ContactStyle if greeting or signoff changed
      if (contactEmail && (analysis.greeting_changed || analysis.signoff_changed)) {
        const updateData: Record<string, unknown> = {};
        if (analysis.greeting_changed) updateData.greetingStyle = analysis.greeting_changed;
        if (analysis.signoff_changed) updateData.signOffStyle = analysis.signoff_changed;

        await app.prisma.contactStyle.upsert({
          where: {
            userId_contactEmail: {
              userId: request.user.userId,
              contactEmail,
            },
          },
          create: {
            userId: request.user.userId,
            contactEmail,
            ...updateData,
            isAutoLearned: true,
          },
          update: updateData,
        });
      }

      return { data: { learned: true, category: analysis.category, summary: analysis.summary } };
    } catch (err) {
      app.log.error(err, 'Failed to process style learning');
      return { data: { skipped: true, reason: 'Processing error' } };
    }
  });
}
