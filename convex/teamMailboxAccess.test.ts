/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { canViewUserMailbox, listViewableMembers } from './lib/workspace';

const modules = import.meta.glob('./**/*.ts');
async function setup() {
  const t = convexTest(schema, modules);
  const fixture = await t.run(async (ctx) => {
    const owner = await ctx.db.insert('users', { name: 'Owner', role: 'ADMIN' });
    const manager = await ctx.db.insert('users', { name: 'Manager', role: 'MANAGER' });
    const employee = await ctx.db.insert('users', { name: 'Employee', role: 'AGENT', managerUserId: manager });
    const peer = await ctx.db.insert('users', { name: 'Peer', role: 'AGENT' });
    const outsider = await ctx.db.insert('users', { name: 'Outsider', role: 'ADMIN' });
    const workspace = await ctx.db.insert('workspaces', { name: 'Choquer', ownerUserId: owner, features: ['team_hub'] });
    for (const id of [owner, manager, employee, peer]) await ctx.db.patch(id, { workspaceId: workspace });
    const mailboxes = await Promise.all([owner, manager, employee, peer, outsider].map(async (userId) => {
      const account = await ctx.db.insert('mailAccounts', {
        userId, provider: 'GMAIL', email: `${userId}@example.com`, accessToken: 'test',
        scopes: [], isActive: true, historicalSyncStatus: 'COMPLETED',
      });
      const thread = await ctx.db.insert('threads', {
        accountId: account, providerThreadId: `thread-${userId}`, subject: 'Client conversation',
        isRead: true, isStarred: false, isArchived: false, isTrashed: false,
        labels: ['INBOX'], participantEmails: [], messageCount: 1, lastMessageAt: Date.now(),
      });
      const email = await ctx.db.insert('emails', {
        accountId: account, threadId: thread, providerMessageId: `email-${userId}`,
        references: [], fromAddress: 'client@example.com', toAddresses: [], subject: 'Client conversation',
        bodyText: 'Private client message', isRead: true, isStarred: false, isDraft: false,
        labels: ['INBOX'], hasAttachments: false, receivedAt: Date.now(), sendStatus: 'NONE', sendAttempts: 0,
      });
      const scheduled = await ctx.db.insert('scheduledEmails', {
        userId, accountId: account, threadId: thread, mode: 'reply', toAddresses: [],
        subject: 'Reply', bodyHtml: '<p>Private scheduled reply</p>', bodyText: 'Private scheduled reply',
        sendAt: Date.now() + 3600000, status: 'SCHEDULED',
      });
      return { userId, account, thread, email, scheduled };
    }));
    return { owner, manager, employee, peer, outsider, workspace, mailboxes };
  });
  return { t, ...fixture, as: (userId: typeof fixture.owner) => t.withIdentity({ subject: userId }) };
}

describe('one-way team mailbox visibility', () => {
  it('lets the workspace owner open every employee conversation and its scheduled replies', async () => {
    const f = await setup();
    const owner = f.as(f.owner);
    const ws = await owner.query(api.workspaces.myWorkspace, {});
    expect(ws?.members.filter(m => m.canView).map(m => m.id).sort())
      .toEqual([f.manager, f.employee, f.peer].sort());
    for (const box of f.mailboxes.filter(b => [f.manager, f.employee, f.peer].includes(b.userId))) {
      expect((await owner.query(api.workspaces.memberMailboxInfo, { memberUserId: box.userId })).accounts).toHaveLength(1);
      expect((await owner.query(api.threads.get, { threadId: box.thread })).data?.emails).toHaveLength(1);
      expect((await owner.query(api.emails.listByThread, { threadId: box.thread })).data).toHaveLength(1);
      expect(await owner.query(api.scheduledEmails.listByThread, { threadId: box.thread }))
        .toMatchObject([{ _id: box.scheduled, bodyText: 'Private scheduled reply' }]);
      expect(await f.t.query(internal.emails._userHasThreadAccessForEmail, { emailId: box.email, userId: f.owner })).toBe(true);
    }
  });

  it('hides the owner mailbox and rejects employee, manager, and outside-admin attempts to read it', async () => {
    const f = await setup();
    const box = f.mailboxes[0];
    for (const viewer of [f.manager, f.employee, f.peer, f.outsider]) {
      const actor = f.as(viewer);
      const ws = await actor.query(api.workspaces.myWorkspace, {});
      expect(ws?.members.find(m => m.id === f.owner)?.canView ?? false).toBe(false);
      await expect(actor.query(api.workspaces.memberMailboxInfo, { memberUserId: f.owner })).rejects.toThrow('Access denied');
      await expect(actor.query(api.threads.list, { viewAsUserId: f.owner })).rejects.toThrow('Access denied');
      await expect(actor.query(api.threads.get, { threadId: box.thread })).rejects.toThrow('Access denied');
      await expect(actor.query(api.emails.listByThread, { threadId: box.thread })).rejects.toThrow('Access denied');
      expect(await actor.query(api.scheduledEmails.listByThread, { threadId: box.thread })).toEqual([]);
      expect(await f.t.query(internal.emails._userHasThreadAccessForEmail, { emailId: box.email, userId: viewer })).toBe(false);
      expect(await f.t.query(internal.sync.onDemandBodyData._lookupForBodyFetch, { emailId: box.email, forUserId: viewer }))
        .toMatchObject({ authorized: false });
    }
  });

  it('allows a manager to review direct reports but not peers', async () => {
    const f = await setup();
    expect(await f.t.run(ctx => canViewUserMailbox(ctx, f.manager, f.employee))).toBe(true);
    expect(await f.t.run(ctx => canViewUserMailbox(ctx, f.manager, f.peer))).toBe(false);
    const ws = await f.as(f.manager).query(api.workspaces.myWorkspace, {});
    expect(ws?.members.filter(m => m.canView).map(m => m.id)).toEqual([f.employee]);
  });

  it('never exposes owner mail through a malformed reporting link', async () => {
    const f = await setup();
    await f.t.run(ctx => ctx.db.patch(f.owner, { managerUserId: f.employee }));
    expect(await f.t.run(ctx => canViewUserMailbox(ctx, f.employee, f.owner))).toBe(false);
    expect((await f.t.run(ctx => listViewableMembers(ctx, f.employee))).map(m => m._id)).not.toContain(f.owner);
    await expect(f.as(f.owner).mutation(api.workspaces.setManager, { memberUserId: f.owner, managerUserId: f.employee }))
      .rejects.toThrow('workspace owner');
    await expect(f.as(f.employee).mutation(api.workspaces.setManager, { memberUserId: f.owner, managerUserId: f.employee }))
      .rejects.toThrow('Only the workspace owner');
  });

  it('does not traverse reporting links across workspaces or loop on cycles', async () => {
    const f = await setup();
    await f.t.run(async ctx => {
      await ctx.db.patch(f.employee, { managerUserId: f.outsider });
      await ctx.db.patch(f.outsider, { managerUserId: f.manager });
    });
    expect(await f.t.run(ctx => canViewUserMailbox(ctx, f.manager, f.employee))).toBe(false);
    await f.t.run(async ctx => {
      await ctx.db.patch(f.employee, { managerUserId: f.manager });
      await ctx.db.patch(f.manager, { managerUserId: f.employee });
    });
    const visible = await f.t.run(ctx => listViewableMembers(ctx, f.manager));
    expect(visible.map(m => m._id)).toEqual([f.employee]);
  });

  it('keeps scheduled messages read-only for team reviewers', async () => {
    const f = await setup();
    const box = f.mailboxes[2];
    const owner = f.as(f.owner);
    await expect(owner.mutation(api.scheduledEmails.update, { id: box.scheduled, bodyText: 'Changed' })).rejects.toThrow();
    await expect(owner.mutation(api.scheduledEmails.cancel, { id: box.scheduled })).rejects.toThrow();
    await expect(owner.mutation(api.scheduledEmails.sendScheduledNow, { id: box.scheduled })).rejects.toThrow();
    expect(await f.t.run(ctx => ctx.db.get(box.scheduled))).toMatchObject({ status: 'SCHEDULED', bodyText: 'Private scheduled reply' });
  });

  it('does not expose another sender’s scheduled replies through a thread grant', async () => {
    const f = await setup();
    const box = f.mailboxes[2];
    await f.t.run(async ctx => {
      await ctx.db.insert('threadAccess', { threadId: box.thread, userId: f.peer, accessLevel: 'VIEWER', grantedAt: Date.now() });
      await ctx.db.patch(box.scheduled, { userId: f.owner, accountId: f.mailboxes[0].account });
    });
    expect(await f.as(f.peer).query(api.scheduledEmails.listByThread, { threadId: box.thread })).toEqual([]);
    expect(await f.as(f.employee).query(api.scheduledEmails.listByThread, { threadId: box.thread })).toEqual([]);
    expect(await f.as(f.owner).query(api.scheduledEmails.listByThread, { threadId: box.thread })).toHaveLength(1);
  });

  it('returns an empty schedule for invalid thread IDs and enforces authentication', async () => {
    const f = await setup();
    expect(await f.as(f.owner).query(api.scheduledEmails.listByThread, { threadId: 'invalid' })).toEqual([]);
    await expect(f.t.query(api.scheduledEmails.listByThread, { threadId: f.mailboxes[0].thread })).rejects.toThrow('Unauthorized');
  });

  it('removes team mailbox access when the workspace entitlement is disabled', async () => {
    const f = await setup();
    await f.t.run(ctx => ctx.db.patch(f.workspace, { features: [] }));
    expect(await f.as(f.owner).query(api.workspaces.myWorkspace, {})).toBeNull();
    expect(await f.t.run(ctx => canViewUserMailbox(ctx, f.owner, f.employee))).toBe(false);
    expect(await f.as(f.owner).query(api.scheduledEmails.listByThread, { threadId: f.mailboxes[2].thread })).toEqual([]);
  });
});
