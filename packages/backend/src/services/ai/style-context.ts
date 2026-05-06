import type { PrismaClient } from '@prisma/client';

const TONE_LABELS: Record<number, string> = {
  1: 'very casual',
  2: 'casual-leaning',
  3: 'balanced',
  4: 'formal-leaning',
  5: 'very formal',
};

const VERBOSITY_LABELS: Record<number, string> = {
  1: 'very terse/punchy',
  2: 'concise',
  3: 'balanced',
  4: 'detailed',
  5: 'very thorough/detailed',
};

/**
 * Build style context for the AI system prompt.
 * Combines user preferences, per-contact overrides, and learned corrections.
 */
export async function buildStyleContext(
  prisma: PrismaClient,
  userId: string,
  contactEmail?: string | null,
): Promise<{ contextText: string; correctionCount: number }> {
  const [prefs, contactStyle, corrections] = await Promise.all([
    prisma.writingPreferences.findUnique({ where: { userId } }),
    contactEmail
      ? prisma.contactStyle.findUnique({
          where: { userId_contactEmail: { userId, contactEmail } },
        })
      : null,
    prisma.styleCorrection.findMany({
      where: {
        userId,
        OR: contactEmail
          ? [{ contactEmail }, { contactEmail: null }]
          : [{ contactEmail: null }],
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const lines: string[] = [];

  // Global preferences
  lines.push('## User\'s Writing Style');
  if (prefs) {
    if (prefs.greetingStyle) lines.push(`- Greeting: "${prefs.greetingStyle}"`);
    if (prefs.signOffStyle === 'None') {
      lines.push('- Sign-off: Do not include any sign-off (no "Best", "Thanks", etc.)');
    } else if (prefs.signOffStyle) {
      lines.push(`- Sign-off: "${prefs.signOffStyle}"`);
    }
    lines.push(`- Tone: ${prefs.tone}/5 (${TONE_LABELS[prefs.tone] || 'balanced'})`);
    lines.push(`- Verbosity: ${prefs.verbosity}/5 (${VERBOSITY_LABELS[prefs.verbosity] || 'balanced'})`);
    if (prefs.descriptors.length > 0) {
      lines.push(`- Style: ${prefs.descriptors.join(', ')}`);
    }
    if (prefs.customRules.length > 0) {
      lines.push('- Custom rules:');
      for (const rule of prefs.customRules) {
        lines.push(`  • ${rule}`);
      }
    }
  } else {
    lines.push('- No preferences configured yet. Use a professional, balanced tone.');
  }

  // Per-contact overrides
  if (contactStyle) {
    lines.push('');
    lines.push(`## Style for this contact (${contactEmail})`);
    if (contactStyle.contactName) lines.push(`- Contact name: ${contactStyle.contactName}`);
    if (contactStyle.greetingStyle) lines.push(`- Greeting override: "${contactStyle.greetingStyle}"`);
    if (contactStyle.signOffStyle === 'None') {
      lines.push('- Sign-off override: Do not include any sign-off');
    } else if (contactStyle.signOffStyle) {
      lines.push(`- Sign-off override: "${contactStyle.signOffStyle}"`);
    }
    if (contactStyle.tone != null) lines.push(`- Tone: ${contactStyle.tone}/5 (${TONE_LABELS[contactStyle.tone] || 'balanced'})`);
    if (contactStyle.verbosity != null) lines.push(`- Verbosity: ${contactStyle.verbosity}/5 (${VERBOSITY_LABELS[contactStyle.verbosity] || 'balanced'})`);
    if (contactStyle.notes) lines.push(`- Notes: ${contactStyle.notes}`);
  }

  // Learned corrections
  if (corrections.length > 0) {
    lines.push('');
    lines.push('## Learned corrections (apply these patterns)');
    for (const c of corrections) {
      if (c.summary) {
        const scope = c.contactEmail ? `(for ${c.contactEmail})` : '(general)';
        lines.push(`- ${c.summary} ${scope}`);
      }
    }
  }

  return { contextText: lines.join('\n'), correctionCount: corrections.length };
}
