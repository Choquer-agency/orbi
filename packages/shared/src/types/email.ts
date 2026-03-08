export interface EmailAddress {
  email: string;
  name: string | null;
}

export interface Thread {
  id: string;
  accountId: string;
  subject: string;
  snippet: string | null;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isTrashed: boolean;
  labels: string[];
  participantEmails: string[];
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  emails?: Email[];
}

export interface Email {
  id: string;
  accountId: string;
  threadId: string;
  providerMessageId: string;
  internetMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  fromName: string | null;
  toAddresses: EmailAddress[];
  ccAddresses: EmailAddress[] | null;
  bccAddresses: EmailAddress[] | null;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string | null;
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  labels: string[];
  hasAttachments: boolean;
  receivedAt: string;
  sentAt: string | null;
  createdAt: string;
  attachments?: Attachment[];
}

export interface Attachment {
  id: string;
  emailId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
}
