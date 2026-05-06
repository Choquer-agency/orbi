import type { PrismaClient } from '@prisma/client';

/**
 * Compute average response time for a user across all their accounts.
 * Looks at threads where someone emailed the user and the user replied.
 * Excludes emails from addresses in the user's tracking exclusion list.
 */
export async function computeResponseTime(prisma: PrismaClient, userId: string) {
  const accounts = await prisma.account.findMany({
    where: { userId },
    select: { id: true, email: true },
  });

  if (accounts.length === 0) {
    return { averageMinutes: 0, medianMinutes: 0, totalReplies: 0 };
  }

  const userEmails = accounts.map((a) => a.email.toLowerCase());
  const accountIds = accounts.map((a) => a.id);

  // Fetch tracking exclusions
  const exclusions = await prisma.trackingExclusion.findMany({
    where: { userId },
    select: { emailAddress: true },
  });
  const excludedSet = new Set(exclusions.map((e) => e.emailAddress.toLowerCase()));

  // Get all threads for this user's accounts
  const threads = await prisma.thread.findMany({
    where: {
      accountId: { in: accountIds },
      isArchived: false,
      isTrashed: false,
    },
    include: {
      emails: {
        orderBy: { receivedAt: 'asc' },
        select: { fromAddress: true, receivedAt: true },
      },
    },
  });

  const deltas: number[] = [];

  for (const thread of threads) {
    const emails = thread.emails;
    for (let i = 0; i < emails.length - 1; i++) {
      const incoming = emails[i];
      const next = emails[i + 1];

      // Skip if from an excluded address
      if (excludedSet.has(incoming.fromAddress.toLowerCase())) continue;

      // Incoming from someone else, next from user = a reply
      const isIncoming = !userEmails.includes(incoming.fromAddress.toLowerCase());
      const isReply = userEmails.includes(next.fromAddress.toLowerCase());

      if (isIncoming && isReply) {
        const deltaMs = next.receivedAt.getTime() - incoming.receivedAt.getTime();
        if (deltaMs > 0) {
          deltas.push(deltaMs / (1000 * 60)); // minutes
        }
      }
    }
  }

  if (deltas.length === 0) {
    return { averageMinutes: 0, medianMinutes: 0, totalReplies: 0 };
  }

  const sorted = [...deltas].sort((a, b) => a - b);
  const avg = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  const median = sorted[Math.floor(sorted.length / 2)];

  return {
    averageMinutes: Math.round(avg),
    medianMinutes: Math.round(median),
    totalReplies: deltas.length,
  };
}

/**
 * Find the top contacts waiting for a reply, sorted by longest wait first.
 * Excludes contacts in the user's tracking exclusion list.
 */
export async function computeNeedsReply(prisma: PrismaClient, userId: string) {
  const accounts = await prisma.account.findMany({
    where: { userId },
    select: { id: true, email: true },
  });

  if (accounts.length === 0) return [];

  const userEmails = accounts.map((a) => a.email.toLowerCase());
  const accountIds = accounts.map((a) => a.id);

  // Fetch tracking exclusions
  const exclusions = await prisma.trackingExclusion.findMany({
    where: { userId },
    select: { emailAddress: true },
  });
  const excludedSet = new Set(exclusions.map((e) => e.emailAddress.toLowerCase()));

  const threads = await prisma.thread.findMany({
    where: {
      accountId: { in: accountIds },
      isArchived: false,
      isTrashed: false,
    },
    include: {
      emails: {
        orderBy: { receivedAt: 'desc' },
        take: 1,
        select: {
          fromAddress: true,
          fromName: true,
          receivedAt: true,
        },
      },
    },
    orderBy: { lastMessageAt: 'desc' },
  });

  const now = Date.now();
  const needsReply: {
    contactEmail: string;
    contactName: string | null;
    threadId: string;
    threadSubject: string;
    waitingHours: number;
    lastMessageAt: Date;
  }[] = [];

  for (const thread of threads) {
    const lastEmail = thread.emails[0];
    if (!lastEmail) continue;

    // Skip if user sent the last email (no reply needed)
    if (userEmails.includes(lastEmail.fromAddress.toLowerCase())) continue;

    // Skip if from an excluded address
    if (excludedSet.has(lastEmail.fromAddress.toLowerCase())) continue;

    const waitingMs = now - lastEmail.receivedAt.getTime();
    needsReply.push({
      contactEmail: lastEmail.fromAddress,
      contactName: lastEmail.fromName,
      threadId: thread.id,
      threadSubject: thread.subject,
      waitingHours: Math.round(waitingMs / (1000 * 60 * 60)),
      lastMessageAt: lastEmail.receivedAt,
    });
  }

  // Sort by waiting time descending (biggest fires first)
  needsReply.sort((a, b) => b.waitingHours - a.waitingHours);

  return needsReply.slice(0, 10);
}
