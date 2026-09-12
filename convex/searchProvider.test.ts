/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';

vi.mock('./oauth/tokenManager', () => ({
  withRefreshOn401: (_ctx: unknown, _accountId: unknown, fn: (token: string) => Promise<unknown>) =>
    fn('test-token'),
}));
const modules = import.meta.glob('./**/*.ts');
afterEach(() => {
  vi.unstubAllGlobals();
});
async function setup(provider: 'GMAIL' | 'MICROSOFT' = 'GMAIL') {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { name: 'Owner' });
    const accountId = await ctx.db.insert('mailAccounts', {
      userId,
      provider,
      email: 'owner@example.com',
      accessToken: 'test',
      scopes: [],
      isActive: true,
      historicalSyncStatus: 'COMPLETED',
    });
    return { userId, accountId };
  });
  return { ...ids, t, owner: t.withIdentity({ subject: ids.userId }) };
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const message = (id: string) => ({
  id,
  threadId: 'thread-1',
  internalDate: '1750000000000',
  snippet: 'Project update',
  labelIds: ['INBOX', 'STARRED'],
  payload: {
    headers: [
      { name: 'From', value: '"Nunn, Mike" <mike@example.com>' },
      { name: 'Cc', value: '"Green, Rick" <rick@example.com>, alex@example.com' },
      { name: 'Subject', value: 'Project' },
    ],
    parts: [{ filename: 'proposal.pdf' }],
  },
});

it('translates the name filter, follows Gmail pages and preserves recipient metadata', async () => {
  const { owner, accountId, t } = await setup();
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/messages')) {
      expect(url.searchParams.get('q')).toBe('from:"Mike Nunn"');
      return url.searchParams.has('pageToken')
        ? json({ messages: [{ id: 'two' }] })
        : json({ messages: [{ id: 'one' }], nextPageToken: 'next-page' });
    }
    return json(message(url.pathname.split('/').at(-1)!));
  });
  vi.stubGlobal('fetch', fetchMock);
  const first = await owner.action(api.searchProvider.searchViaProvider, {
    query: 'from:Mike Nunn',
  });
  expect(first.nextCursors).toEqual([{ accountId, cursor: 'next-page' }]);
  const next = await owner.action(api.searchProvider.searchViaProvider, {
    query: 'from:Mike Nunn',
    cursors: first.nextCursors,
  });
  expect(next.nextCursors).toEqual([]);
  expect(next.emailIds).toHaveLength(1);
  const email = await t.run((ctx) => ctx.db.get(first.emailIds[0]));
  expect(email).toMatchObject({
    hasAttachments: true,
    isStarred: true,
    fromName: 'Nunn, Mike',
    ccAddresses: [
      { name: 'Green, Rick', email: 'rick@example.com' },
      { email: 'alex@example.com' },
    ],
  });
});

it('reports provider errors as incomplete rather than successful zero matches', async () => {
  const { owner } = await setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({}, 503)),
  );
  const result = await owner.action(api.searchProvider.searchViaProvider, { query: 'Mike' });
  expect(result).toMatchObject({ matched: 0, failedAccounts: 1, searchedAccounts: 0 });
});

it('keeps successful accounts when another provider account fails', async () => {
  const { owner, t, userId } = await setup();
  await t.run((ctx) =>
    ctx.db.insert('mailAccounts', {
      userId,
      provider: 'MICROSOFT',
      email: 'second@example.com',
      accessToken: 'test',
      scopes: [],
      isActive: true,
      historicalSyncStatus: 'COMPLETED',
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      input.includes('graph.microsoft.com')
        ? json({}, 503)
        : input.includes('/messages?')
          ? json({ messages: [{ id: 'one' }] })
          : json(message('one')),
    ),
  );
  expect(await owner.action(api.searchProvider.searchViaProvider, { query: 'Mike' })).toMatchObject(
    { matched: 1, failedAccounts: 1, searchedAccounts: 1 },
  );
});

it('restricts provider account searches to the authenticated owner', async () => {
  const { owner, t } = await setup();
  const accountId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { name: 'Other' });
    return await ctx.db.insert('mailAccounts', {
      userId,
      provider: 'GMAIL',
      email: 'other@example.com',
      accessToken: 'secret',
      scopes: [],
      isActive: true,
      historicalSyncStatus: 'COMPLETED',
    });
  });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await owner.action(api.searchProvider.searchViaProvider, { query: 'Mike', accountId }),
  ).toMatchObject({ searchedAccounts: 0, emailIds: [] });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('searches Outlook participant fields and returns its continuation cursor', async () => {
  const { owner, accountId } = await setup('MICROSOFT');
  const fetchMock = vi.fn(async (input: string) => {
    expect(new URL(input).searchParams.get('$search')).toBe('"participants:mike@example.com"');
    return json({
      value: [
        {
          id: 'one',
          conversationId: 'one',
          subject: 'Project',
          from: { emailAddress: { name: 'Mike Nunn', address: 'mike@example.com' } },
          isRead: false,
        },
      ],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next',
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await owner.action(api.searchProvider.searchViaProvider, { query: 'with:mike@example.com' }),
  ).toMatchObject({
    matched: 1,
    nextCursors: [
      { accountId, cursor: 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next' },
    ],
  });
});

it('never forwards Microsoft bearer tokens to a client-supplied foreign URL', async () => {
  const { owner, accountId } = await setup('MICROSOFT');
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await owner.action(api.searchProvider.searchViaProvider, {
      query: 'Mike',
      cursors: [{ accountId, cursor: 'https://attacker.example/steal' }],
    }),
  ).toMatchObject({ failedAccounts: 1 });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('preserves Outlook folder membership when importing search matches', async () => {
  const { owner, t, accountId } = await setup('MICROSOFT');
  await t.run((ctx) =>
    ctx.db.patch(accountId, {
      msFolderMapCache: {
        entries: [{ folderId: 'inbox-id', labels: ['INBOX'] }],
        expiresAt: Date.now() + 60_000,
      },
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({
        value: [
          {
            id: 'one',
            conversationId: 'one',
            parentFolderId: 'inbox-id',
            from: { emailAddress: { address: 'mike@example.com' } },
            receivedDateTime: '2026-09-01T12:00:00Z',
          },
        ],
      }),
    ),
  );
  const saved = await owner.action(api.searchProvider.searchViaProvider, { query: 'Mike' });
  expect(
    (await owner.query(api.searchProviderData.results, { emailIds: saved.emailIds }))[0],
  ).toMatchObject({ isArchived: false, labels: ['INBOX'] });
});
