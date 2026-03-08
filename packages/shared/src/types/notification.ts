export enum NotificationType {
  NEW_EMAIL = 'NEW_EMAIL',
  MENTION = 'MENTION',
  COMMENT = 'COMMENT',
  ASSIGNMENT = 'ASSIGNMENT',
  SLA_WARNING = 'SLA_WARNING',
  SLA_BREACH = 'SLA_BREACH',
}

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
}
