import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Smart time format for thread list:
 * - Today: "2:34 PM"
 * - Yesterday: "Yesterday"
 * - Within this week: "Friday"
 * - Older: "Jan 16"
 */
export function formatRelativeTime(date: string | Date): string {
  const now = new Date();
  const d = new Date(date);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today.getTime() - target.getTime()) / 86400000);

  if (diffDays === 0) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) {
    return d.toLocaleDateString('en-US', { weekday: 'long' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Exact timestamp for email viewer: "Mar 7, 2:34 PM"
 */
export function formatExactTime(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  }) + ', ' + d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Email domains where the favicon belongs to the mail provider (Gmail, etc.)
 * rather than the sender — for these we should fall back to initials instead
 * of showing a misleading provider logo.
 */
const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'fastmail.com',
  'zoho.com',
  'pm.me',
]);

/**
 * Reduce a domain to the root brand domain. Newsletter senders often use
 * marketing subdomains like `news.telus.com`, `e.intuit.com`, `mail.thestreet.com`
 * — logo services have logos for the brand root, not for every subdomain.
 *
 * Handles common multi-part TLDs (.co.uk, .com.au, etc) so we don't strip
 * `co.uk` down to just `uk`.
 */
const TWO_PART_TLDS = new Set([
  'co.uk', 'co.jp', 'co.nz', 'co.kr', 'co.in', 'co.za',
  'com.au', 'com.br', 'com.mx', 'com.sg', 'com.tr', 'com.hk',
  'org.uk', 'gov.uk', 'ac.uk',
]);

function getRootDomain(domain: string): string {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Return an ordered list of logo URLs to try for the sender's company
 * domain, or an empty array for generic mail providers.
 *
 * Newsletter and marketing email is usually sent from a subdomain
 * (`news.telus.com`, `e.intuit.com`) that logo services don't have entries
 * for — so we try both the full domain AND the root brand domain across
 * each provider. The Avatar component cycles through these on error;
 * when all fail it falls through to colored initials.
 *
 * No single free service has full coverage:
 *  - Clearbit serves clean ~128px brand logos but their coverage post-HubSpot
 *    acquisition has gotten spotty.
 *  - DuckDuckGo's ip3 endpoint returns whatever favicon the site advertises
 *    and works for almost any live domain.
 *  - Google's S2 favicon service is the broadest fallback.
 */
export function getCompanyLogoUrls(email: string | undefined | null): string[] {
  if (!email) return [];
  const fullDomain = email.split('@')[1]?.toLowerCase().trim();
  if (!fullDomain || GENERIC_EMAIL_DOMAINS.has(fullDomain)) return [];
  const root = getRootDomain(fullDomain);
  // Try the brand root first — that's where the logo usually lives — then
  // fall back to the literal sender domain in case it's a brand in its own
  // right (rare but does happen).
  const candidates = root === fullDomain ? [fullDomain] : [root, fullDomain];
  const urls: string[] = [];
  for (const d of candidates) {
    const enc = encodeURIComponent(d);
    urls.push(`https://logo.clearbit.com/${enc}`);
    urls.push(`https://icons.duckduckgo.com/ip3/${enc}.ico`);
    urls.push(`https://www.google.com/s2/favicons?domain=${enc}&sz=128`);
  }
  return urls;
}

/** @deprecated use getCompanyLogoUrls — kept for back-compat. */
export function getCompanyLogoUrl(email: string | undefined | null): string | null {
  return getCompanyLogoUrls(email)[0] ?? null;
}

export function formatDateGroup(date: string | Date): string {
  const d = new Date(date);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const sevenDaysAgo = new Date(today.getTime() - 7 * 86400000);
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (target.getTime() === today.getTime()) return 'Today';
  if (target.getTime() === yesterday.getTime()) return 'Yesterday';
  if (target >= sevenDaysAgo) return 'Last 7 Days';
  if (target >= firstOfMonth) return 'Earlier This Month';
  return d.toLocaleDateString('en-US', { month: 'long', year: target.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

export function groupByDate<T extends { lastMessageAt?: string | Date; lastReceivedAt?: string | Date | null }>(
  items: T[],
): { label: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const date = item.lastReceivedAt ?? item.lastMessageAt ?? new Date();
    const label = formatDateGroup(date);
    const group = groups.get(label);
    if (group) group.push(item);
    else groups.set(label, [item]);
  }
  return Array.from(groups, ([label, items]) => ({ label, items }));
}
