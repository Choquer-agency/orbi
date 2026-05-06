import type { Server } from 'socket.io';

function toArray(userId: string | string[]): string[] {
  return Array.isArray(userId) ? userId : [userId];
}

export function emitThreadsUpdated(io: Server, userId: string | string[], threadIds?: string[]): void {
  const payload = { threadIds };
  for (const uid of toArray(userId)) {
    io.to(`user:${uid}`).emit('threads:updated', payload);
  }
}

export function emitCommentsUpdated(io: Server, userId: string | string[], threadId: string): void {
  const payload = { threadId };
  for (const uid of toArray(userId)) {
    io.to(`user:${uid}`).emit('comments:updated', payload);
  }
}

export function emitDraftsUpdated(io: Server, userId: string): void {
  io.to(`user:${userId}`).emit('drafts:updated', {});
}
