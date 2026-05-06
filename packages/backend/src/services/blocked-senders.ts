import type { PrismaClient } from '@prisma/client';

export async function isBlockedSender(
  prisma: PrismaClient,
  userId: string,
  fromAddress: string,
): Promise<boolean> {
  const email = fromAddress.toLowerCase().trim();
  const domain = email.split('@')[1];

  const blocked = await prisma.blockedSender.findFirst({
    where: {
      userId,
      OR: [
        { emailAddress: email },
        ...(domain ? [{ domain }] : []),
      ],
    },
  });

  return !!blocked;
}
