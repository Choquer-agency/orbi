import { describe, expect, it } from 'vitest';
import {
  gmailSearchQuery,
  microsoftSearchQuery,
  parseSearchOperators,
  quoteSearchValue,
} from '../packages/shared/src/search';

describe('mail search grammar', () => {
  it('preserves pasted multiword sender names', () => {
    expect(parseSearchOperators('from:Mike Nunn')).toEqual({ from: 'Mike Nunn', text: '' });
    expect(gmailSearchQuery('from:Mike Nunn')).toBe('from:"Mike Nunn"');
  });
  it('keeps words after a quoted field as body search', () => {
    expect(parseSearchOperators('from:"Mike Nunn" invoice after:2026-01-01')).toEqual({
      from: 'Mike Nunn',
      text: 'invoice',
      after: Date.parse('2026-01-01'),
    });
  });
  it('keeps names intact across multiple filters', () => {
    expect(parseSearchOperators('from:Mike Nunn cc:Rick Green is:unread has:attachment')).toEqual({
      from: 'Mike Nunn',
      cc: 'Rick Green',
      isUnread: true,
      hasAttachment: true,
      text: '',
    });
  });
  it('does not lose unsupported filters or invalid dates', () => {
    expect(parseSearchOperators('before:banana is:banana hello').text).toBe(
      'before:banana is:banana hello',
    );
  });
  it('round trips escaped quotes and spaces in pills', () => {
    const value = 'Mike "MJ" Nunn';
    expect(parseSearchOperators(`from:${quoteSearchValue(value)}`).from).toBe(value);
  });
  it('searches selected people across sender, recipients and cc', () => {
    expect(gmailSearchQuery('with:mike@example.com invoice')).toBe(
      'invoice {from:mike@example.com to:mike@example.com cc:mike@example.com bcc:mike@example.com}',
    );
    expect(microsoftSearchQuery('with:mike@example.com')).toBe('participants:mike@example.com');
  });
  it('translates Gmail operators into Graph KQL', () => {
    expect(microsoftSearchQuery('from:Mike Nunn has:attachment before:2026-09-01')).toBe(
      'from:"Mike Nunn" AND received<2026-09-01 AND hasAttachments:true',
    );
  });
  it('includes recipients in a broad Outlook name search', () => {
    expect(microsoftSearchQuery('Mike Nunn')).toBe('(Mike Nunn OR participants:"Mike Nunn")');
  });
  it('allows unread and starred at the same time', () => {
    expect(parseSearchOperators('is:unread is:starred')).toEqual({
      text: '',
      isUnread: true,
      isStarred: true,
    });
  });
});

it('does not interpret operators inside a quoted phrase', () => {
  expect(parseSearchOperators('"send from:Mike tomorrow"')).toEqual({
    text: '"send from:Mike tomorrow"',
  });
  expect(parseSearchOperators('subject:"Notes from:Mike" invoice')).toEqual({
    subject: 'Notes from:Mike',
    text: 'invoice',
  });
});
