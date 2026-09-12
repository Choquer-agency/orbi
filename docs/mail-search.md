# Mail search

Search in the thread list uses the connected Gmail / Microsoft mailbox indexes,
including mail that has not been downloaded or opened in Orbi. Provider matches
are imported as metadata, then displayed by matching email ID. They must not be
re-filtered against local snippets or body text: that discards valid body hits.
The displayed preview and date come from the matching email in the conversation.

- Typing `Mike Nunn` keeps a broad text search.
- Selecting a contact creates a visible `with:` participant filter using their
  email address. `from:`, `to:` and `cc:` explicitly narrow the relationship.
- `from:Mike Nunn` and `from:"Mike Nunn"` preserve the full name. Quote a field
  when following it with free text: `from:"Mike Nunn" invoice`.
- Spaces do not commit filters. Enter applies a filter, clicking its value edits
  it, and the remove button removes it completely.
- Search ignores the current folder and hidden Unread/Starred tabs. The selected
  account still applies, and the search status states the scope.
- Filters can combine, including `is:unread is:starred`. Outlook `label:` filters
  match categories. Unsupported/invalid filter text is preserved, not discarded.

Requests wait for typing to settle. Each provider page is bounded to 50 messages
per account and 100 messages in total. Metadata fetches use at most eight
concurrent Gmail requests per account. Further pages use provider cursors;
conversation rows are deduplicated. Each reactive hydration query reads only the
latest batch, while the client retains preceding pages. A search retains up to
2,000 matching emails and asks the user to refine it if that limit is reached.
Microsoft's message search also has its own 1,000-result limit.

If a provider fails, the UI labels the results incomplete, offers retry, and
includes available local results. The local fallback has bounded coverage;
it must not be presented as proof there are no matches in the full mailbox.
Team Hub searches retain the existing server-authorized local query; they never
search the viewer's own providers while displaying a teammate's mailbox.

Provider account access and result hydration both verify the authenticated
owner. Graph continuation URLs are restricted to the Microsoft messages endpoint
before any bearer token is sent. Historical imports preserve existing folder and
read state. They retain recipients, attachments, stars and drafts.

## Verification and rollout

Run `npm run test:search`, `npm run typecheck`, and `npm run build`.
Tests cover parsing, provider requests and pagination, partial failures, account
isolation, old conversations/replies, metadata imports, request races, and search
bar keyboard interactions. Provider HTTP responses are mocked; these tests do
not verify live account credentials or the result count in a particular mailbox.

Deploy the Convex backend and its additive sender search indexes before shipping
the frontend. Follow `docs/convex-deployment.md` and, for an app release,
`docs/electron-auto-updates.md`. No data backfill is required for the new indexes:
they index existing sender fields.

Provider references:
[Google message search](https://developers.google.com/workspace/gmail/api/guides/filtering),
[Google pagination](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[Microsoft message search and supported fields](https://learn.microsoft.com/en-us/graph/search-query-parameter).
