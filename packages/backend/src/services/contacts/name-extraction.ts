/**
 * Smart name extraction from email body text.
 * Extracts sender names from signatures, sign-offs, and self-introductions.
 */

const COMPANY_SUFFIXES = /\b(Inc|LLC|Ltd|Corp|Co|Group|Agency|Studio|Labs|Media|Digital|Solutions|Services|Technologies|Consulting|Partners|Associates|Holdings|Ventures|Capital|Foundation|Institute|University|College)\b/i;

/**
 * Validate that a string looks like a proper human name.
 * Must be 2-4 capitalized words, no URLs, emails, or company patterns.
 */
export function isProperName(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length < 3 || trimmed.length > 50) return false;

  // Reject URLs, emails, phone numbers
  if (/@|https?:|www\.|\.com|\.org|\.net/i.test(trimmed)) return false;
  // Reject lines with special chars common in signatures but not names
  if (/[|•·\t]/.test(trimmed)) return false;
  // Reject lines that are mostly numbers
  if (/^\+?\d[\d\s\-().]+$/.test(trimmed)) return false;
  // Reject company-like patterns
  if (COMPANY_SUFFIXES.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;

  // Each word should start with a capital letter (allow single-letter initials like "J.")
  for (const word of words) {
    if (!/^[A-Z]/.test(word)) return false;
    // Reject words that are all-caps and longer than 3 chars (likely acronyms/companies)
    if (word.length > 3 && word === word.toUpperCase()) return false;
  }

  return true;
}

/**
 * Extract a name from the email body text using multiple heuristic patterns.
 * Returns null if no confident extraction can be made.
 */
export function extractNameFromBody(bodyText: string): string | null {
  if (!bodyText || bodyText.trim().length === 0) return null;

  const lines = bodyText.split('\n');

  // Strip quoted content
  const originalLines: string[] = [];
  for (const line of lines) {
    if (/^On .+ wrote:$/i.test(line.trim())) break;
    if (/^-{3,}\s*Original Message/i.test(line.trim())) break;
    if (/^_{3,}/.test(line.trim())) break;
    if (/^>/.test(line.trim())) continue;
    originalLines.push(line);
  }

  if (originalLines.length === 0) return null;

  // Pattern 1: Signature block — name after -- or --- separator
  const sigName = extractFromSignatureBlock(originalLines);
  if (sigName) return sigName;

  // Pattern 2: Sign-off — "Best,\n Name" / "Thanks,\n Name"
  const signOffName = extractFromSignOff(originalLines);
  if (signOffName) return signOffName;

  // Pattern 3: Dash-name — "- John Smith" or "— John Smith" at end
  const dashName = extractFromDashName(originalLines);
  if (dashName) return dashName;

  // Pattern 4: Self-introduction — "My name is John Smith" (first 5 lines only)
  const introName = extractFromIntroduction(originalLines);
  if (introName) return introName;

  return null;
}

/**
 * Look for a name as the first proper-name line after a -- or --- separator.
 */
function extractFromSignatureBlock(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const trimmed = lines[i].trim();
    if (trimmed === '--' || trimmed === '---' || trimmed === '— ' || trimmed === '—') {
      // Look at the next few lines for a name
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        if (isProperName(candidate)) return candidate;
        break; // First non-empty line after separator should be the name
      }
    }
  }
  return null;
}

/**
 * Look for sign-off patterns like "Best,\n John Smith"
 */
function extractFromSignOff(lines: string[]): string | null {
  const signOffPatterns = [
    'Best regards', 'Kind regards', 'Warm regards', 'Regards',
    'Best', 'Thanks', 'Thank you', 'Cheers', 'Sincerely',
    'All the best', 'Many thanks', 'With appreciation',
    'Respectfully', 'Cordially', 'Take care',
  ];

  // Search from the end, within last 15 lines
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
    const trimmed = lines[i].trim();
    // Check if this line is a sign-off (with or without comma)
    const isSignOff = signOffPatterns.some((p) => {
      const lower = trimmed.toLowerCase().replace(/,\s*$/, '');
      return lower === p.toLowerCase();
    });

    if (isSignOff) {
      // The name should be on the next non-empty line
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        if (isProperName(candidate)) return candidate;
        break;
      }
    }
  }
  return null;
}

/**
 * Look for "- Name" or "— Name" at the end of the email.
 */
function extractFromDashName(lines: string[]): string | null {
  // Check last 5 non-empty lines
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const tail = nonEmpty.slice(-5);

  for (const line of tail) {
    const match = line.trim().match(/^[-–—]\s*(.+)$/);
    if (match) {
      const candidate = match[1].trim();
      if (isProperName(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Look for self-introduction in the first few lines.
 * "My name is John Smith" / "I'm John Smith"
 */
function extractFromIntroduction(lines: string[]): string | null {
  const firstLines = lines.slice(0, 5);

  for (const line of firstLines) {
    // "My name is X"
    const nameIsMatch = line.match(/my name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i);
    if (nameIsMatch && isProperName(nameIsMatch[1])) return nameIsMatch[1];

    // "I'm X" / "I am X" — only if followed by a clear name (2+ words)
    const imMatch = line.match(/(?:I'm|I am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/);
    if (imMatch && isProperName(imMatch[1])) return imMatch[1];
  }

  return null;
}

/**
 * Check if a name looks like it was auto-generated from an email local-part.
 * e.g., "john.smith" or "jsmith123" — not a real display name.
 */
export function looksLikeEmailLocalPart(name: string): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  // Contains dots typical of email local parts
  if (/^[a-z0-9]+\.[a-z0-9]+$/i.test(trimmed)) return true;
  // All lowercase with no spaces
  if (trimmed === trimmed.toLowerCase() && !/\s/.test(trimmed)) return true;
  // Contains numbers mixed with letters (like "jsmith123")
  if (/\d/.test(trimmed) && /[a-z]/i.test(trimmed) && !/\s/.test(trimmed)) return true;
  return false;
}
