import { Client } from '@microsoft/microsoft-graph-client';
import type { PrismaClient } from '@prisma/client';
import { TokenManager } from '../oauth/token-manager.js';

/**
 * Microsoft well-known folder IDs → our label system.
 */
const FOLDER_LABEL_MAP: Record<string, string> = {
  inbox: 'INBOX',
  sentitems: 'SENT',
  drafts: 'DRAFT',
  deleteditems: 'TRASH',
  archive: 'ARCHIVE',
  junkemail: 'SPAM',
};

/**
 * Map a Microsoft Graph parentFolderId (display name or well-known name) to our labels.
 */
export function mapFolderToLabels(folderDisplayName: string | undefined): string[] {
  if (!folderDisplayName) return [];
  const key = folderDisplayName.toLowerCase().replace(/\s+/g, '');
  const mapped = FOLDER_LABEL_MAP[key];
  return mapped ? [mapped] : [];
}

/**
 * Build an authenticated Microsoft Graph client for the given account.
 */
export async function getGraphClient(
  prisma: PrismaClient,
  accountId: string,
): Promise<{ client: Client; account: { id: string; userId: string; syncCursor: string | null; email: string } }> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { id: true, userId: true, email: true, syncCursor: true, accessToken: true, refreshToken: true, tokenExpiry: true, provider: true, scopes: true, displayName: true, isActive: true, createdAt: true, updatedAt: true, lastSyncAt: true, historicalSyncStatus: true, historicalSyncProgress: true, historicalSyncCompletedAt: true },
  });

  const tokenManager = new TokenManager(prisma);
  const accessToken = await tokenManager.getValidAccessToken(account as any);

  const client = Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
  });

  return { client, account };
}

/**
 * Well-known folder IDs for Microsoft Graph.
 * Used to query specific folders.
 */
export const WELL_KNOWN_FOLDERS = {
  INBOX: 'inbox',
  SENT: 'sentitems',
  DRAFTS: 'drafts',
  TRASH: 'deleteditems',
  ARCHIVE: 'archive',
  SPAM: 'junkemail',
} as const;

/**
 * The $select fields we request for messages.
 */
export const MESSAGE_SELECT_FIELDS = [
  'id',
  'conversationId',
  'subject',
  'bodyPreview',
  'body',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'isRead',
  'isDraft',
  'hasAttachments',
  'flag',
  'parentFolderId',
  'internetMessageId',
  'internetMessageHeaders',
].join(',');
