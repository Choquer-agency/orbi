import { cn } from '../../lib/utils';

const CATEGORY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  revision_request: { bg: 'bg-orange-50', text: 'text-orange-600', label: 'Revision' },
  billing: { bg: 'bg-emerald-50', text: 'text-emerald-600', label: 'Billing' },
  new_inquiry: { bg: 'bg-blue-50', text: 'text-blue-600', label: 'New Inquiry' },
  project_update: { bg: 'bg-violet-50', text: 'text-violet-600', label: 'Update' },
  meeting_scheduling: { bg: 'bg-teal-50', text: 'text-teal-600', label: 'Meeting' },
  feedback: { bg: 'bg-yellow-50', text: 'text-yellow-600', label: 'Feedback' },
  support_request: { bg: 'bg-red-50', text: 'text-red-600', label: 'Support' },
  internal: { bg: 'bg-sky-50', text: 'text-sky-600', label: 'Internal' },
  marketing: { bg: 'bg-pink-50', text: 'text-pink-600', label: 'Marketing' },
  spam: { bg: 'bg-orange-50', text: 'text-orange-500', label: 'Spam' },
  other: { bg: 'bg-gray-50', text: 'text-gray-500', label: 'Other' },
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
        'inline-flex items-center rounded-lg px-1.5 py-0.5 text-[10px] font-semibold leading-tight',
        style.bg,
        style.text,
        onClick && 'cursor-pointer hover:opacity-80',
        className,
      )}
    >
      {style.label}
    </span>
  );
}

export function getCategoryLabel(category: string): string {
  return CATEGORY_STYLES[category]?.label || category;
}
