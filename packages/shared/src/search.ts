/** One search grammar for the search bar, local matching and mail providers. */
export interface ParsedSearch {
  text: string;
  from?: string;
  to?: string;
  cc?: string;
  with?: string;
  subject?: string;
  before?: number;
  after?: number;
  hasAttachment?: boolean;
  isUnread?: boolean;
  isStarred?: boolean;
  isRead?: boolean;
  label?: string;
}

export function quoteSearchValue(value: string): string {
  return /[\s"\\]/.test(value) ? JSON.stringify(value) : value;
}

export function parseSearchOperators(raw: string): ParsedSearch {
  const result: ParsedSearch = { text: '' };
  // Quoted values end at their closing quote. Unquoted people/labels extend
  // to the next operator, so pasting `from:Mike Nunn` preserves the name.
  const fields: Array<{ start: number; valueStart: number; op: string }> = [];
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && quoted) {
      i++;
      continue;
    }
    if (raw[i] === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted || (i > 0 && !/\s/.test(raw[i - 1]))) continue;
    const field = raw.slice(i).match(/^([a-z]+):\s*/i);
    if (field)
      fields.push({ start: i, valueStart: i + field[0].length, op: field[1].toLowerCase() });
  }
  const text = [raw.slice(0, fields[0]?.start ?? raw.length)];
  fields.forEach((field, index) => {
    const end = fields[index + 1]?.start ?? raw.length;
    const whole = raw.slice(field.start, end).trim();
    const rawValue = raw.slice(field.valueStart, end);
    const keep = () => {
      text.push(whole);
    };
    const op = field.op;
    let value = rawValue.trim();
    let tail = '';
    if (value.startsWith('"')) {
      const quoted = value.match(/^"(?:\\.|[^"\\])*"/);
      if (!quoted) return keep();
      tail = value.slice(quoted[0].length).trim();
      try {
        value = JSON.parse(quoted[0]);
      } catch {
        return keep();
      }
    } else if (['before', 'after', 'has', 'is'].includes(op) || value.includes('@')) {
      const parts = value.split(/\s+/);
      value = parts.shift() ?? '';
      tail = parts.join(' ');
    }
    if (!value) return keep();
    switch (op) {
      case 'from':
      case 'to':
      case 'cc':
      case 'with':
      case 'subject':
      case 'label':
        result[op] = value;
        break;
      case 'before':
      case 'after': {
        const date = Date.parse(value);
        if (!Number.isFinite(date)) return keep();
        result[op] = date;
        break;
      }
      case 'has':
        if (value.toLowerCase() !== 'attachment') return keep();
        result.hasAttachment = true;
        break;
      case 'is':
        if (value.toLowerCase() === 'unread') result.isUnread = true;
        else if (value.toLowerCase() === 'read') result.isRead = true;
        else if (value.toLowerCase() === 'starred') result.isStarred = true;
        else return keep();
        break;
      default:
        return keep();
    }
    text.push(tail);
  });
  result.text = text.join(' ').replace(/\s+/g, ' ').trim();
  return result;
}

export function matchesSearchText(text: string | undefined, term: string): boolean {
  const tokens = term.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
  const lower = (text ?? '').toLocaleLowerCase();
  return tokens.every((token) => lower.includes(token.replace(/^"|"$/g, '').toLocaleLowerCase()));
}

export function gmailSearchQuery(raw: string): string {
  const p = parseSearchOperators(raw);
  const parts = [p.text];
  for (const field of ['from', 'to', 'cc', 'subject', 'label'] as const) {
    if (p[field]) parts.push(`${field}:${quoteSearchValue(p[field])}`);
  }
  if (p.with)
    parts.push(
      `{from:${quoteSearchValue(p.with)} to:${quoteSearchValue(p.with)} cc:${quoteSearchValue(p.with)} bcc:${quoteSearchValue(p.with)}}`,
    );
  if (p.before !== undefined) parts.push(`before:${Math.floor(p.before / 1000)}`);
  if (p.after !== undefined) parts.push(`after:${Math.floor(p.after / 1000)}`);
  if (p.hasAttachment) parts.push('has:attachment');
  if (p.isUnread) parts.push('is:unread');
  if (p.isRead) parts.push('is:read');
  if (p.isStarred) parts.push('is:starred');
  return parts.filter(Boolean).join(' ');
}

/** Graph uses KQL, not Gmail operators. Read/star/label are applied to hits. */
export function microsoftSearchQuery(raw: string): string {
  const p = parseSearchOperators(raw);
  const parts: string[] = [];
  if (p.text)
    parts.push(`(${p.text} OR participants:${quoteSearchValue(p.text.replace(/^"|"$/g, ''))})`);
  for (const field of ['from', 'to', 'cc', 'subject'] as const) {
    if (p[field]) parts.push(`${field}:${quoteSearchValue(p[field])}`);
  }
  if (p.with) parts.push(`participants:${quoteSearchValue(p.with)}`);
  if (p.before !== undefined)
    parts.push(`received<${new Date(p.before).toISOString().slice(0, 10)}`);
  if (p.after !== undefined) parts.push(`received>${new Date(p.after).toISOString().slice(0, 10)}`);
  if (p.hasAttachment) parts.push('hasAttachments:true');
  return parts.join(' AND ');
}
