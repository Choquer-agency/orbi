export interface ThreadComment {
  id: string;
  threadId: string;
  authorId: string;
  author?: { id: string; name: string; avatarUrl: string | null };
  bodyHtml: string;
  bodyText: string;
  isResolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  isEdited: boolean;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  mentions?: ThreadMention[];
  reactions?: CommentReaction[];
}

export interface ThreadMention {
  id: string;
  commentId: string;
  threadId: string;
  mentionedUserId: string;
  mentionedUser?: { id: string; name: string; avatarUrl: string | null };
  createdAt: string;
}

export interface CommentReaction {
  id: string;
  commentId: string;
  userId: string;
  user?: { id: string; name: string };
  emoji: string;
  createdAt: string;
}

export enum AccessLevel {
  VIEWER = 'VIEWER',
  COLLABORATOR = 'COLLABORATOR',
  OWNER = 'OWNER',
}

export interface ThreadAccess {
  id: string;
  threadId: string;
  userId: string;
  accessLevel: AccessLevel;
  grantedAt: string;
}
