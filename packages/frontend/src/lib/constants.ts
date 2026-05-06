import {
  Inbox,
  Send,
  FileText,
  Archive,
  Trash2,
  Star,
  Clock,
  Users,
  Sparkles,
  LayoutDashboard,
  CalendarClock,
  BellRing,
  UserCheck,
  ContactIcon,
  Megaphone,
  Bell,
  ShieldAlert,
  AlarmClock,
} from 'lucide-react';

export const DASHBOARD_ITEM = { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard } as const;

export const FOLDERS = [
  { id: 'inbox', label: 'Primary', icon: Inbox },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'drafts', label: 'Drafts', icon: FileText },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'trash', label: 'Trash', icon: Trash2 },
] as const;

export const SMART_FOLDERS = [
  { id: 'needs_response', label: 'Needs Response', icon: Clock },
  { id: 'shared', label: 'Shared With Me', icon: Users },
  { id: 'snoozed', label: 'Snoozed', icon: AlarmClock },
  { id: 'scheduled', label: 'Scheduled', icon: CalendarClock },
  { id: 'delegated_to_me', label: 'Delegated to Me', icon: UserCheck },
  { id: 'contacts', label: 'Contacts', icon: ContactIcon },
] as const;

export const TRIAGE_FOLDERS = [
  { id: 'marketing', label: 'Marketing', icon: Megaphone },
  { id: 'spam', label: 'Spam', icon: ShieldAlert },
] as const;

/** Default account color palette — users can override via settings. */
export const ACCOUNT_COLORS = [
  '#FF7E16', // primary orange
  '#A69FFF', // soft purple
  '#BDFFE8', // mint
  '#ACFF9E', // light green
  '#FBBDFF', // pink
  '#FFF09E', // light yellow
  '#FFA69E', // salmon
  '#B1D0FF', // soft blue
  '#14B8A6', // teal
] as const;

/** Get a deterministic account color by index. */
export function getAccountColor(index: number): string {
  return ACCOUNT_COLORS[index % ACCOUNT_COLORS.length];
}

export const PROVIDER_COLORS: Record<string, string> = {
  GMAIL: 'bg-[var(--color-gmail)]',
  MICROSOFT: 'bg-[var(--color-microsoft)]',
  APPLE_IMAP: 'bg-[var(--color-imap)]',
};

/**
 * Pastel avatar colors — fun, distinct backgrounds with matching text.
 * Deterministically assigned by hashing the name string.
 */
export const AVATAR_PASTELS = [
  { bg: 'bg-rose-100', text: 'text-rose-600' },
  { bg: 'bg-sky-100', text: 'text-sky-600' },
  { bg: 'bg-amber-100', text: 'text-amber-600' },
  { bg: 'bg-emerald-100', text: 'text-emerald-600' },
  { bg: 'bg-violet-100', text: 'text-violet-600' },
  { bg: 'bg-fuchsia-100', text: 'text-fuchsia-600' },
  { bg: 'bg-cyan-100', text: 'text-cyan-600' },
  { bg: 'bg-orange-100', text: 'text-orange-600' },
  { bg: 'bg-teal-100', text: 'text-teal-600' },
  { bg: 'bg-indigo-100', text: 'text-indigo-600' },
] as const;

/** Get a deterministic pastel color pair from a name string. */
export function getAvatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_PASTELS[Math.abs(hash) % AVATAR_PASTELS.length];
}
