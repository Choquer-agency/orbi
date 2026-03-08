export enum UserRole {
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
  AGENT = 'AGENT',
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export enum AccountProvider {
  GMAIL = 'GMAIL',
  MICROSOFT = 'MICROSOFT',
  APPLE_IMAP = 'APPLE_IMAP',
}

export interface Account {
  id: string;
  userId: string;
  provider: AccountProvider;
  email: string;
  displayName: string | null;
  isActive: boolean;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}
