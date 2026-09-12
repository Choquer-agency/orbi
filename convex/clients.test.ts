/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { scheduleClientRefresh } from './lib/clientQueue';
import { patchThread } from './lib/inboxStamp';
import type { Doc } from './_generated/dataModel';
const modules = import.meta.glob('./**/*.ts');
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'alex@agency.test', role: 'AGENT' });
    const outsider = await ctx.db.insert('users', { email: 'other@agency.test', role: 'AGENT' });
    const workspaceId = await ctx.db.insert('workspaces', { name: 'Choquer', ownerUserId: userId, features: ['team_hub'] });
    await ctx.db.patch(userId, { workspaceId });
    const accountId = await ctx.db.insert('mailAccounts', { userId, provider: 'GMAIL', email: 'alex@agency.test', aliases: ['support@agency.test'], accessToken: 'test', scopes: [], isActive: true, historicalSyncStatus: 'COMPLETED' });
    const threadId = await ctx.db.insert('threads', { accountId, providerThreadId: 'thread', subject: 'Website updates', isRead: false, isStarred: false, isArchived: false, isTrashed: false, labels: ['INBOX'], participantEmails: [], messageCount: 1, lastMessageAt: 1 });
    await ctx.db.insert('clientDirectorySync', { workspaceId, version: 'v1', fingerprint: 'test', actorEmail: 'alex@agency.test', syncedAt: 1, rebuilding: false });
    await ctx.db.insert('erpClients', { workspaceId, version: 'v1', erpId: 'abc', name: 'ABC Company' });
    await ctx.db.insert('erpClientMatches', { workspaceId, version: 'v1', key: 'domain:abc.test', clientId: 'abc' });
    await ctx.db.insert('erpClientMatches', { workspaceId, version: 'v1', key: 'email:steve@gmail.com', clientId: 'abc' });
    return { userId, outsider, workspaceId, accountId, threadId };
  });
  const asUser = t.withIdentity({ subject: ids.userId });
  const add = async (at: number, extra: Partial<Doc<'emails'>> = {}) => t.run(async ctx => {
    const id = await ctx.db.insert('emails', { accountId: ids.accountId, threadId: ids.threadId, providerMessageId: `message-${at}-${Math.random()}`, references: [], fromAddress: 'client@abc.test', fromName: 'Client', toAddresses: [{ email: 'alex@agency.test' }], subject: 'Website updates', bodyText: 'Please make the updates.', isRead: false, isStarred: false, isDraft: false, labels: ['INBOX'], hasAttachments: false, receivedAt: at, sendStatus: 'NONE', sendAttempts: 0, ...extra });
    await scheduleClientRefresh(ctx, ids.threadId);
    return id;
  });
  const settle = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  const list = () => asUser.query(api.clients.list, { paginationOpts: { numItems: 50, cursor: null } });
  return { t, ...ids, asUser, add, settle, list };
}
describe('client reply queue', () => {
  it('includes old, read and archived client mail and remembers the oldest unanswered message', async () => {
    const f = await fixture();
    await f.add(1000); await f.add(2000); await f.settle();
    await f.t.run(ctx => patchThread(ctx, f.threadId, { isRead: true, isArchived: true }));
    expect((await f.list()).page).toMatchObject([{ clientName: 'ABC Company', waitingAt: 1000, latestAt: 2000, isRead: true }]);
  });
  it('clears only after a successful reply, recognizes aliases, and reopens on a new client email', async () => {
    const f = await fixture(); await f.add(1000);
    const sent = await f.add(2000, { fromAddress: 'support@agency.test', toAddresses: [{ email: 'client@abc.test' }], sendStatus: 'FAILED' });
    await f.settle(); expect((await f.list()).page).toHaveLength(1);
    await f.t.mutation(internal.emails._markSent, { emailId: sent }); await f.settle(); expect((await f.list()).page).toHaveLength(0);
    await f.add(3000); await f.settle(); expect((await f.list()).page).toMatchObject([{ waitingAt: 3000 }]);
  });
  it('keeps drafts, queued sends, forwards and internal discussion from clearing a client request', async () => {
    const f = await fixture(); await f.add(1000);
    await f.add(2000, { fromAddress: 'alex@agency.test', toAddresses: [{ email: 'colleague@agency.test' }] });
    await f.add(3000, { fromAddress: 'alex@agency.test', toAddresses: [{ email: 'client@abc.test' }], isDraft: true });
    await f.add(4000, { fromAddress: 'alex@agency.test', toAddresses: [{ email: 'client@abc.test' }], sendStatus: 'PENDING_SEND' });
    await f.add(5000, { fromAddress: 'alex@agency.test', toAddresses: [{ email: 'client@abc.test' }], subject: 'Fwd: Website updates', sendStatus: 'SENT' });
    await f.settle(); expect((await f.list()).page).toMatchObject([{ waitingAt: 1000 }]);
  });
  it('dismisses through the reviewed message, and a later client message returns', async () => {
    const f = await fixture(); const original = await f.add(1000); await f.settle();
    await f.asUser.mutation(api.clients.dismiss, { threadId: f.threadId, latestEmailId: original }); await f.settle();
    expect((await f.list()).page).toHaveLength(0);
    await f.add(2000); await f.settle(); expect((await f.list()).page).toMatchObject([{ waitingAt: 2000 }]);
    await expect(f.asUser.mutation(api.clients.dismiss, { threadId: f.threadId, latestEmailId: original })).rejects.toThrow('new message');
  });
  it('matches explicitly linked Gmail addresses without treating everyone on Gmail as a client', async () => {
    const f = await fixture(); await f.add(1000, { fromAddress: 'random@gmail.com' }); await f.settle(); expect((await f.list()).page).toHaveLength(0);
    await f.add(2000, { fromAddress: 'steve@gmail.com' }); await f.settle(); expect((await f.list()).page).toMatchObject([{ clientId: 'abc' }]);
  });
  it('ignores automated senders, removes spam and restores it when unmarked', async () => {
    const f = await fixture(); await f.add(1000, { fromAddress: 'noreply@abc.test' }); await f.settle(); expect((await f.list()).page).toHaveLength(0);
    await f.add(2000); await f.settle();
    await f.t.run(ctx => patchThread(ctx, f.threadId, { isSpam: true })); await f.settle(); expect((await f.list()).page).toHaveLength(0);
    await f.t.run(ctx => patchThread(ctx, f.threadId, { isSpam: false })); await f.settle(); expect((await f.list()).page).toHaveLength(1);
  });
  it('scans long threads in pages without dropping the oldest request', async () => {
    const f = await fixture();
    for (let i = 1; i <= 61; i++) await f.add(i * 1000);
    await f.settle(); expect((await f.list()).page).toMatchObject([{ waitingAt: 1000, latestAt: 61000 }]);
  });
  it('rejects another user trying to dismiss or extract a private conversation', async () => {
    const f = await fixture(); const email = await f.add(1000); await f.settle();
    const other = f.t.withIdentity({ subject: f.outsider });
    await expect(other.mutation(api.clients.dismiss, { threadId: f.threadId, latestEmailId: email })).rejects.toThrow();
    await expect(other.query(internal.clientWorkflow.context, { threadId: f.threadId })).rejects.toThrow();
    await expect(f.t.query(api.clients.list, { paginationOpts: { numItems: 50, cursor: null } })).rejects.toThrow();
  });
});
