/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';

const modules = import.meta.glob('./**/*.ts');
const hit = {
  providerMessageId: 'message-1',
  providerThreadId: 'thread-1',
  subject: 'Project update',
  snippet: 'See the details',
  fromAddress: 'mike@example.com',
  fromName: 'Mike Nunn',
  toAddresses: [{ email: 'owner@example.com' }],
  ccAddresses: [{ email: 'rick@example.com', name: 'Rick Green' }],
  receivedAt: Date.parse('2026-01-01'),
  isRead: true,
  isStarred: true,
  isDraft: false,
  hasAttachments: true,
  labels: ['INBOX'],
};
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { name: 'Owner' });
    const strangerId = await ctx.db.insert('users', { name: 'Stranger' });
    const account = {
      provider: 'GMAIL' as const,
      email: 'owner@example.com',
      accessToken: 'test',
      scopes: [],
      isActive: true,
      historicalSyncStatus: 'COMPLETED' as const,
    };
    const accountId = await ctx.db.insert('mailAccounts', { ...account, userId });
    const otherAccountId = await ctx.db.insert('mailAccounts', { ...account, userId: strangerId });
    return { userId, strangerId, accountId, otherAccountId };
  });
  return {
    t,
    ...ids,
    owner: t.withIdentity({ subject: ids.userId }),
    stranger: t.withIdentity({ subject: ids.strangerId }),
  };
}

describe('mail search data', () => {
  it('finds a multiword sender in mail older than 500 newer conversations', async () => {
    const { t, owner, accountId } = await setup();
    await t.mutation(internal.searchProviderData._upsertSearchHits, { accountId, hits: [hit] });
    await t.run(async (ctx) => {
      for (let i = 0; i < 510; i++)
        await ctx.db.insert('threads', {
          accountId,
          providerThreadId: `new-${i}`,
          subject: 'Other mail',
          isRead: true,
          isStarred: false,
          isArchived: false,
          isTrashed: false,
          labels: [],
          participantEmails: [],
          messageCount: 1,
          lastMessageAt: hit.receivedAt + 1000 + i,
          lastReceivedAt: hit.receivedAt + 1000 + i,
        });
    });
    const results = await owner.query(api.threads.list, { search: 'from:Mike Nunn' });
    expect(results.data).toHaveLength(1);
    expect(results.data[0].subject).toBe('Project update');
  });
  it('finds the sender before the latest ten replies', async () => {
    const { t, owner, accountId } = await setup();
    await t.mutation(internal.searchProviderData._upsertSearchHits, { accountId, hits: [hit] });
    await t.mutation(internal.searchProviderData._upsertSearchHits, {
      accountId,
      hits: Array.from({ length: 12 }, (_, i) => ({
        ...hit,
        providerMessageId: `reply-${i}`,
        fromAddress: 'other@example.com',
        fromName: 'Someone Else',
        receivedAt: hit.receivedAt + i + 1,
      })),
    });
    expect((await owner.query(api.threads.list, { search: 'from:Mike Nunn' })).data).toHaveLength(
      1,
    );
  });
  it('applies cc-only filters rather than returning unrelated threads', async () => {
    const { t, owner, accountId } = await setup();
    await t.mutation(internal.searchProviderData._upsertSearchHits, {
      accountId,
      hits: [
        hit,
        { ...hit, providerMessageId: 'other', providerThreadId: 'other', ccAddresses: [] },
      ],
    });
    expect((await owner.query(api.threads.list, { search: 'cc:Rick Green' })).data).toHaveLength(1);
  });
  it('displays provider body matches without requiring the body in local storage', async () => {
    const { t, owner, accountId } = await setup();
    const saved = await t.mutation(internal.searchProviderData._upsertSearchHits, {
      accountId,
      hits: [hit],
    });
    const results = await owner.query(api.searchProviderData.results, { emailIds: saved.emailIds });
    expect(results).toHaveLength(1);
    expect(results[0].emails[0].fromName).toBe('Mike Nunn');
    expect(await t.run((ctx) => ctx.db.query('emailSearchText').take(1))).toEqual([]);
  });
  it('isolates same provider message IDs across accounts and rejects foreign result IDs', async () => {
    const { t, owner, stranger, accountId, otherAccountId } = await setup();
    const first = await t.mutation(internal.searchProviderData._upsertSearchHits, {
      accountId,
      hits: [hit],
    });
    const second = await t.mutation(internal.searchProviderData._upsertSearchHits, {
      accountId: otherAccountId,
      hits: [hit],
    });
    expect(first.emailIds[0]).not.toBe(second.emailIds[0]);
    expect(
      await stranger.query(api.searchProviderData.results, { emailIds: first.emailIds }),
    ).toEqual([]);
    expect(
      await owner.query(api.searchProviderData.results, { emailIds: second.emailIds }),
    ).toEqual([]);
  });
  it('keeps import metadata accurate and repeated search imports idempotent', async () => {
    const { t, owner, accountId } = await setup();
    const first = await t.mutation(internal.searchProviderData._upsertSearchHits, {
      accountId,
      hits: [hit],
    });
    const repeat = await t.mutation(internal.searchProviderData._upsertSearchHits, {
      accountId,
      hits: [hit],
    });
    expect(repeat.imported).toBe(0);
    const email = await t.run((ctx) => ctx.db.get(first.emailIds[0]));
    expect(email).toMatchObject({ isStarred: true, hasAttachments: true });
    const results = await owner.query(api.searchProviderData.results, { emailIds: first.emailIds });
    expect(results[0].messageCount).toBe(1);
    expect(results[0].participantEmails).toContain('rick@example.com');
  });
  it('preserves archive state and newest timestamps when importing an older match', async () => {
    const { t, owner, accountId } = await setup();
    const saved = await t.mutation(internal.searchProviderData._upsertSearchHits, {
      accountId,
      hits: [hit],
    });
    const email = (await t.run((ctx) => ctx.db.get(saved.emailIds[0])))!;
    await t.run((ctx) => ctx.db.patch(email.threadId, { isArchived: true }));
    await t.mutation(internal.searchProviderData._upsertSearchHits, {
      accountId,
      hits: [{ ...hit, providerMessageId: 'older', receivedAt: hit.receivedAt - 1000 }],
    });
    const row = (
      await owner.query(api.searchProviderData.results, { emailIds: saved.emailIds })
    )[0];
    expect(row).toMatchObject({ isArchived: true, lastMessageAt: hit.receivedAt, messageCount: 2 });
  });
});

it('does not inflate an already-known provider conversation count', async () => {
  const { t, owner, accountId } = await setup();
  const saved = await t.mutation(internal.searchProviderData._upsertSearchHits, {
    accountId,
    hits: [hit],
  });
  const email = (await t.run((ctx) => ctx.db.get(saved.emailIds[0])))!;
  await t.run((ctx) => ctx.db.patch(email.threadId, { messageCount: 20 }));
  await t.mutation(internal.searchProviderData._upsertSearchHits, {
    accountId,
    hits: [{ ...hit, providerMessageId: 'missing-reply' }],
  });
  expect(
    (await owner.query(api.searchProviderData.results, { emailIds: saved.emailIds }))[0]
      .messageCount,
  ).toBe(20);
});

it('does not mark a draft as sent mail merely because it is from the owner', async () => {
  const { t, owner, accountId } = await setup();
  const saved = await t.mutation(internal.searchProviderData._upsertSearchHits, {
    accountId,
    hits: [{ ...hit, fromAddress: 'owner@example.com', isDraft: true, labels: ['DRAFT'] }],
  });
  expect(
    (await owner.query(api.searchProviderData.results, { emailIds: saved.emailIds }))[0],
  ).toMatchObject({ hasSentMail: false, hasDraft: true });
});
