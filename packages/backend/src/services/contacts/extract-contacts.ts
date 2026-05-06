import type { PrismaClient } from '@prisma/client';
import { extractNameFromBody, looksLikeEmailLocalPart } from './name-extraction.js';
import { assignOrCreatePerson } from './person-merge.js';

interface EmailParticipant {
  email: string;
  name?: string;
}

/**
 * Extract the signature block from an email body.
 * Looks for common signature delimiters before falling back to the last few lines.
 */
function extractSignatureBlock(bodyText: string): string | null {
  const lines = bodyText.split('\n');

  // Strip quoted content (lines starting with >) and everything after "On ... wrote:"
  const originalLines: string[] = [];
  for (const line of lines) {
    // Stop at quoted reply markers
    if (/^On .+ wrote:$/i.test(line.trim())) break;
    if (/^-{3,}\s*Original Message/i.test(line.trim())) break;
    if (/^_{3,}/.test(line.trim())) break;
    // Skip quoted lines
    if (/^>/.test(line.trim())) continue;
    originalLines.push(line);
  }

  if (originalLines.length === 0) return null;

  // Look for common signature separators
  const separators = ['--', '— ', '---', '━', '⎯', 'Best regards', 'Kind regards', 'Regards,', 'Thanks,', 'Thank you,', 'Cheers,', 'Sincerely,', 'Best,', 'Warm regards'];

  let sigStart = -1;
  for (let i = originalLines.length - 1; i >= Math.max(0, originalLines.length - 20); i--) {
    const trimmed = originalLines[i].trim();
    for (const sep of separators) {
      if (trimmed === sep || trimmed.startsWith(sep)) {
        sigStart = i;
        break;
      }
    }
    if (sigStart !== -1) break;
  }

  if (sigStart !== -1) {
    return originalLines.slice(sigStart).join('\n');
  }

  // No separator found — use last 8 lines of original content (conservative)
  return originalLines.slice(-8).join('\n');
}

/**
 * Extract structured info from an email signature.
 * Uses strict regex patterns to avoid pulling email body content.
 */
function parseSignature(bodyText: string | null): {
  company?: string;
  title?: string;
  phone?: string;
} {
  if (!bodyText) return {};

  const sigBlock = extractSignatureBlock(bodyText);
  if (!sigBlock) return {};

  const sigLines = sigBlock.split('\n').map((l) => l.trim()).filter(Boolean);

  let phone: string | undefined;
  let title: string | undefined;
  let company: string | undefined;

  // Phone: require a label prefix for reliability
  for (const line of sigLines) {
    const phoneMatch = line.match(
      /(?:phone|tel|mobile|cell|direct|office|fax|ph?)\s*[:.]\s*(\+?[\d\s\-().]{7,20})/i,
    );
    if (phoneMatch) {
      const cleaned = phoneMatch[1].replace(/[\s()-]/g, '');
      if (cleaned.length >= 7 && cleaned.length <= 15) {
        phone = phoneMatch[1].trim();
        break;
      }
    }
  }

  // Title at Company: "Title at Company" pattern
  for (const line of sigLines) {
    const match = line.match(/^(.{3,40})\s+(?:at|@)\s+(.{2,50})$/i);
    if (match) {
      const candidateTitle = match[1].trim();
      const candidateCompany = match[2].trim();
      // Validate: title should look like a job title, company shouldn't be an address/number
      if (
        /\b(CEO|CTO|CFO|COO|VP|Director|Manager|Engineer|Designer|Founder|President|Lead|Head|Chief|Partner|Associate|Coordinator|Specialist|Analyst|Consultant|Developer|Architect|Officer|Owner|Editor|Producer|Agent|Broker|Advisor|Strategist|Planner)\b/i.test(candidateTitle) &&
        !/^\d/.test(candidateCompany) // skip if company starts with a number (address)
      ) {
        title = candidateTitle;
        company = candidateCompany;
        break;
      }
    }
  }

  // Pipe/dash separated: "Name | Title | Company"
  if (!title) {
    for (const line of sigLines) {
      const parts = line.split(/\s*[|–—]\s*/);
      if (parts.length >= 2 && parts.length <= 4) {
        // All parts should be short (signature-like), not sentences
        if (parts.some((p) => p.trim().length > 60)) continue;

        const titleIdx = parts.findIndex((p) =>
          /\b(CEO|CTO|CFO|COO|VP|Director|Manager|Engineer|Designer|Founder|President|Lead|Head|Chief|Partner|Associate|Coordinator|Specialist|Analyst|Consultant|Developer|Architect|Officer|Owner|Editor|Producer|Agent|Broker|Advisor|Strategist|Planner)\b/i.test(p),
        );
        if (titleIdx !== -1) {
          title = parts[titleIdx].trim().slice(0, 100);
          // Company is the part that isn't a name or the title
          // Skip parts that look like person names (1-3 words, all capitalized)
          const companyCandidate = parts.find((p, i) => {
            if (i === titleIdx) return false;
            const trimmed = p.trim();
            if (trimmed.length < 2) return false;
            // Skip if it looks like a person name (2-3 capitalized words only)
            if (/^[A-Z][a-z]+(?: [A-Z][a-z]+){0,2}$/.test(trimmed) && trimmed.split(' ').length <= 3) return false;
            return true;
          });
          if (companyCandidate && !company) company = companyCandidate.trim();
          break;
        }
      }
    }
  }

  // Extract company from email domain as last resort (skip generic providers)
  // Not done here — domain extraction belongs in the upsert logic if needed

  return { company, title, phone };
}

/**
 * Upsert contacts from email participants.
 * Called during email sync — extracts contacts from from/to/cc fields.
 *
 * @param isOutbound - true if the user sent this email (counts toward emailCount)
 */
export async function extractAndUpsertContacts(
  prisma: PrismaClient,
  userId: string,
  participants: EmailParticipant[],
  bodyText: string | null,
  emailDate: Date,
  userEmails: string[], // user's own email addresses to skip
  senderEmail?: string, // the From address — sig info only applies to this contact
  isOutbound?: boolean, // whether the user sent this email
): Promise<void> {
  const sigInfo = parseSignature(bodyText);

  // Try to extract a name from the email body for contacts that lack one
  const bodyExtractedName = bodyText ? extractNameFromBody(bodyText) : null;

  for (const participant of participants) {
    const email = participant.email.toLowerCase().trim();
    // Signature data only applies to the sender, not to/cc recipients
    const isSender = senderEmail ? email === senderEmail.toLowerCase().trim() : false;

    // Skip the user's own emails and no-reply addresses
    if (userEmails.includes(email)) continue;
    if (/noreply|no-reply|donotreply|mailer-daemon|notifications?@|bounce/i.test(email)) continue;

    // Determine the best available name for this participant
    let participantName = participant.name || null;
    // If no name from headers, or name looks like an email local-part, try body extraction (sender only)
    if (isSender && (!participantName || looksLikeEmailLocalPart(participantName)) && bodyExtractedName) {
      participantName = bodyExtractedName;
    }

    try {
      const existing = await prisma.contact.findUnique({
        where: { userId_email: { userId, email } },
      });

      let contactId: string;

      if (existing) {
        contactId = existing.id;
        const updates: Record<string, any> = {};

        // Only count emails the user sent TO this contact
        if (isOutbound) {
          updates.emailCount = { increment: 1 };
        }

        if (!existing.lastEmailed || emailDate > existing.lastEmailed) {
          updates.lastEmailed = emailDate;
        }

        // Only fill empty fields, don't overwrite user edits
        if (!existing.name && participantName) updates.name = participantName;
        // Upgrade auto-generated names with better extracted names
        if (existing.name && existing.isAutoLearned && looksLikeEmailLocalPart(existing.name) && participantName && !looksLikeEmailLocalPart(participantName)) {
          updates.name = participantName;
        }
        if (existing.isAutoLearned && isSender) {
          if (!existing.company && sigInfo.company) updates.company = sigInfo.company;
          if (!existing.title && sigInfo.title) updates.title = sigInfo.title;
          if (!existing.phone && sigInfo.phone) updates.phone = sigInfo.phone;
        }

        if (Object.keys(updates).length > 0) {
          await prisma.contact.update({
            where: { userId_email: { userId, email } },
            data: updates,
          });
        }
      } else {
        const created = await prisma.contact.create({
          data: {
            userId,
            email,
            name: participantName,
            company: (isSender ? sigInfo.company : null) || null,
            title: (isSender ? sigInfo.title : null) || null,
            phone: (isSender ? sigInfo.phone : null) || null,
            lastEmailed: emailDate,
            emailCount: isOutbound ? 1 : 0,
            isAutoLearned: true,
          },
        });
        contactId = created.id;
      }

      // Assign contact to a Person (find matching or create new)
      try {
        await assignOrCreatePerson(prisma, userId, contactId, email, participantName);
      } catch {
        // Non-critical — person assignment can be retried later via backfill
      }
    } catch {
      // Unique constraint race — safe to ignore
    }
  }
}
