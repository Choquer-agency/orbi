// ─────────────────────────────────────────────────────────────────────────────
// lib/nameExtraction.ts — direct port of services/contacts/name-extraction.ts.
// No I/O, no Prisma imports — pure string heuristics.
// ─────────────────────────────────────────────────────────────────────────────

const COMPANY_SUFFIXES =
  /\b(Inc|LLC|Ltd|Corp|Co|Group|Agency|Studio|Labs|Media|Digital|Solutions|Services|Technologies|Consulting|Partners|Associates|Holdings|Ventures|Capital|Foundation|Institute|University|College)\b/i;

export function isProperName(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length < 3 || trimmed.length > 50) return false;

  if (/@|https?:|www\.|\.com|\.org|\.net/i.test(trimmed)) return false;
  if (/[|•·\t]/.test(trimmed)) return false;
  if (/^\+?\d[\d\s\-().]+$/.test(trimmed)) return false;
  if (COMPANY_SUFFIXES.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;

  for (const word of words) {
    if (!/^[A-Z]/.test(word)) return false;
    if (word.length > 3 && word === word.toUpperCase()) return false;
  }
  return true;
}

export function extractNameFromBody(bodyText: string): string | null {
  if (!bodyText || bodyText.trim().length === 0) return null;

  const lines = bodyText.split("\n");
  const originalLines: string[] = [];
  for (const line of lines) {
    if (/^On .+ wrote:$/i.test(line.trim())) break;
    if (/^-{3,}\s*Original Message/i.test(line.trim())) break;
    if (/^_{3,}/.test(line.trim())) break;
    if (/^>/.test(line.trim())) continue;
    originalLines.push(line);
  }
  if (originalLines.length === 0) return null;

  const sigName = extractFromSignatureBlock(originalLines);
  if (sigName) return sigName;

  const signOffName = extractFromSignOff(originalLines);
  if (signOffName) return signOffName;

  const dashName = extractFromDashName(originalLines);
  if (dashName) return dashName;

  const introName = extractFromIntroduction(originalLines);
  if (introName) return introName;

  return null;
}

function extractFromSignatureBlock(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "--" || trimmed === "---" || trimmed === "— " || trimmed === "—") {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        if (isProperName(candidate)) return candidate;
        break;
      }
    }
  }
  return null;
}

function extractFromSignOff(lines: string[]): string | null {
  const signOffPatterns = [
    "Best regards", "Kind regards", "Warm regards", "Regards",
    "Best", "Thanks", "Thank you", "Cheers", "Sincerely",
    "All the best", "Many thanks", "With appreciation",
    "Respectfully", "Cordially", "Take care",
  ];

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
    const trimmed = lines[i].trim();
    const isSignOff = signOffPatterns.some((p) => {
      const lower = trimmed.toLowerCase().replace(/,\s*$/, "");
      return lower === p.toLowerCase();
    });

    if (isSignOff) {
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

function extractFromDashName(lines: string[]): string | null {
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

function extractFromIntroduction(lines: string[]): string | null {
  const firstLines = lines.slice(0, 5);
  for (const line of firstLines) {
    const nameIsMatch = line.match(
      /my name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i,
    );
    if (nameIsMatch && isProperName(nameIsMatch[1])) return nameIsMatch[1];

    const imMatch = line.match(
      /(?:I'm|I am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/,
    );
    if (imMatch && isProperName(imMatch[1])) return imMatch[1];
  }
  return null;
}

export function looksLikeEmailLocalPart(name: string): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (/^[a-z0-9]+\.[a-z0-9]+$/i.test(trimmed)) return true;
  if (trimmed === trimmed.toLowerCase() && !/\s/.test(trimmed)) return true;
  if (/\d/.test(trimmed) && /[a-z]/i.test(trimmed) && !/\s/.test(trimmed)) return true;
  return false;
}
