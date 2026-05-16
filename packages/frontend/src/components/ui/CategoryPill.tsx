import { cn } from '../../lib/utils';

const CATEGORY_STYLES: Record<string, { bg: string; text: string; ring: string; label: string }> = {
  revision_request: { bg: 'bg-orange-100', text: 'text-orange-700', ring: 'ring-orange-200', label: 'Revision Request' },
  billing: { bg: 'bg-emerald-100', text: 'text-emerald-700', ring: 'ring-emerald-200', label: 'Billing' },
  new_inquiry: { bg: 'bg-blue-100', text: 'text-blue-700', ring: 'ring-blue-200', label: 'New Inquiry' },
  project_update: { bg: 'bg-violet-100', text: 'text-violet-700', ring: 'ring-violet-200', label: 'Project Update' },
  meeting_scheduling: { bg: 'bg-teal-100', text: 'text-teal-700', ring: 'ring-teal-200', label: 'Meeting Scheduling' },
  feedback: { bg: 'bg-yellow-100', text: 'text-yellow-700', ring: 'ring-yellow-200', label: 'Feedback' },
  support_request: { bg: 'bg-red-100', text: 'text-red-700', ring: 'ring-red-200', label: 'Support Request' },
  internal: { bg: 'bg-sky-100', text: 'text-sky-700', ring: 'ring-sky-200', label: 'Internal' },
  notification: { bg: 'bg-indigo-100', text: 'text-indigo-700', ring: 'ring-indigo-200', label: 'Notification' },
  marketing: { bg: 'bg-pink-100', text: 'text-pink-700', ring: 'ring-pink-200', label: 'Marketing' },
  spam: { bg: 'bg-orange-100', text: 'text-orange-600', ring: 'ring-orange-200', label: 'Spam' },
  other: { bg: 'bg-gray-100', text: 'text-gray-600', ring: 'ring-gray-200', label: 'Other' },
};

interface CategoryPillProps {
  category: string;
  className?: string;
  onClick?: () => void;
}

export function CategoryPill({ category, className, onClick }: CategoryPillProps) {
  const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.other;

  return (
    <span
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-[1px] text-[10px] font-semibold leading-tight ring-1 ring-inset',
        style.bg,
        style.text,
        style.ring,
        onClick && 'cursor-pointer hover:opacity-80',
        className,
      )}
    >
      {style.label}
    </span>
  );
}

export function getCategoryLabel(category: string): string {
  return CATEGORY_STYLES[category]?.label || category
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
