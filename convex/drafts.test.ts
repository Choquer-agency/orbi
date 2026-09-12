/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';

const modules = import.meta.glob('./**/*.ts');
async function setup(provider: 'GMAIL' | 'MICROSOFT' = 'GMAIL') {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { name: 'Owner' });
    const accountId = await ctx.db.insert('mailAccounts', {
      userId, provider, email: 'owner@example.com', accessToken: 'test',
      scopes: [], isActive: true, historicalSyncStatus: 'COMPLETED',
    });
    return { userId, accountId };
  });
  const owner = t.withIdentity({ subject: ids.userId });
  const { data } = await owner.mutation(api.drafts.create, {
    accountId: ids.accountId, mode: 'compose', subject: 'Status update',
    bodyText: 'Ready to send', toAddresses: [{ email: 'andres@example.com' }],
  });
  return { t, owner, ...ids, draftId: data.id, threadId: data.threadId };
}

describe('draft status', () => {
  it('clears the draft badge on send and ignores late autosave or discard calls', async () => {
    const { t, owner, draftId } = await setup();
    expect((await owner.query(api.threads.list, { folder: 'drafts' })).data).toHaveLength(1);
    await owner.mutation(api.drafts.sendDraft, { draftId });
    expect(await owner.mutation(api.drafts.update, { draftId, bodyText: 'Late autosave' }))
      .toMatchObject({ stale: true });
    await owner.mutation(api.drafts.discard, { draftId });
    expect(await t.run((ctx) => ctx.db.get(draftId)))
      .toMatchObject({ isDraft: false, sendStatus: 'PENDING_SEND', bodyText: 'Ready to send' });
    expect((await owner.query(api.threads.list, { folder: 'drafts' })).data).toHaveLength(0);
  });

  it('removes only the selected draft when another draft exists in the conversation', async () => {
    const { t, owner, accountId, threadId, draftId } = await setup();
    const other = await owner.mutation(api.drafts.create, {
      accountId, threadId, mode: 'reply', bodyText: 'A separate unsent reply',
    });
    await owner.mutation(api.drafts.discard, { draftId });
    expect(await t.run((ctx) => ctx.db.get(other.data.id))).toMatchObject({ isDraft: true });
    expect((await owner.query(api.threads.list, { folder: 'drafts' })).data).toHaveLength(1);
  });

  for (const provider of ['GMAIL', 'MICROSOFT'] as const) {
    for (const labels of [['DRAFT'], ['SENT']]) {
      it(`${provider} clears a stale draft flag when existing labels are ${labels[0]}`, async () => {
        const { t, owner, accountId, threadId, draftId } = await setup(provider);
        const data = provider === 'GMAIL' ? internal.sync.gmailData : internal.sync.microsoftData;
        await t.run((ctx) => ctx.db.patch(draftId, { providerMessageId: 'provider-message', labels }));
        expect(await t.query(data._getEmailFingerprint, { providerMessageId: 'provider-message' }))
          .toMatchObject({ isDraft: true });
        await t.mutation(data._upsertEmail, {
          accountId, threadId, providerMessageId: 'provider-message', references: [],
          fromAddress: 'owner@example.com', toAddresses: [{ email: 'andres@example.com' }],
          subject: 'Status update', isRead: true, isStarred: false, isDraft: false,
          labels: ['SENT'], hasAttachments: false, receivedAt: Date.now(),
        });
        expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ isDraft: false, labels: ['SENT'] });
        expect((await owner.query(api.threads.list, { folder: 'drafts' })).data).toHaveLength(0);
        expect(await t.query(data._getEmailFingerprint, { providerMessageId: 'provider-message' }))
          .toMatchObject({ isDraft: false });
      });
    }
  }
});
