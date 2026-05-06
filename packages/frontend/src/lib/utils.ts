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
