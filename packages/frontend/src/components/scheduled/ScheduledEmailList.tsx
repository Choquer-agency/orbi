import * as ScrollArea from '@radix-ui/react-scroll-area';
import { CalendarClock, X, Check, Loader2 } from 'lucide-react';
import { useScheduledEmails, useCancelScheduledEmail } from '../../hooks/useScheduledEmails';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';

function formatScheduledTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  if (isToday) return `Today at ${time}`;
  if (isTomorrow) return `Tomorrow at ${time}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}

function addressListEmails(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((a: any) => a?.email).filter(Boolean).join(', ');
}

function addressListLabel(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((a: any) => a?.name || a?.email).filter(Boolean).join(', ');
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    SCHEDULED: 'bg-blue-50 text-blue-600',
    SENDING: 'bg-amber-50 text-amber-600',
    SENT: 'bg-green-50 text-green-600',
    CANCELLED: 'bg-gray-100 text-text-tertiary',
    FAILED: 'bg-red-50 text-red-600',
  };

  return (
    <span className={cn('rounded-lg px-1.5 py-0.5 text-[10px] font-semibold uppercase', styles[status] || styles.SCHEDULED)}>
      {status}
    </span>
  );
}

export function ScheduledEmailList() {
  const { data: emails, isLoading } = useScheduledEmails();
  const cancelMutation = useCancelScheduledEmail();
  const { setSelectedThread, setSelectedFolder, setPendingDraft, setScrollToScheduled } = useUiStore();

  const handleClick = (email: any) => {
    if (email.status !== 'SCHEDULED') return;

    if (email.threadId) {
      // Navigate to the thread — scroll to the scheduled email at bottom
      setSelectedThread(email.threadId);
      setSelectedFolder('inbox');
      setScrollToScheduled(true);
    } else {
      // Standalone scheduled email — open compose with its content as a pending draft
      setPendingDraft({
        body: email.bodyText || '',
        to: addressListEmails(email.toAddresses),
        subject: email.subject,
      });
      setSelectedFolder('inbox');
      setSelectedThread(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    );
  }

  const items = emails ?? [];

  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
          <CalendarClock className="h-6 w-6 text-blue-500" />
        </div>
        <p className="mt-3 text-sm font-medium text-text-primary">No scheduled emails</p>
        <p className="mt-1 text-xs text-text-tertiary">
          Schedule an email to send it later.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea.Root className="min-h-0 flex-1">
      <ScrollArea.Viewport className="h-full w-full">
        {items.map((email) => {
          const recipients = addressListLabel(email.toAddresses);

          return (
            <div
              key={email.id}
              onClick={() => handleClick(email)}
              className={cn(
                'border-b border-border px-4 py-3 transition-colors hover:bg-surface/50',
                email.status === 'SCHEDULED' && 'cursor-pointer',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {recipients}
                    </span>
                    <StatusBadge status={email.status} />
                  </div>
                  <p className="mt-0.5 truncate text-sm text-text-secondary">{email.subject}</p>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-text-tertiary">
                    <CalendarClock className="h-3 w-3" />
                    <span>{formatScheduledTime(email.sendAt)}</span>
                    {email.account && (
                      <>
                        <span className="text-border">·</span>
                        <span>{email.account.email}</span>
                      </>
                    )}
                  </div>
                </div>

                {email.status === 'SCHEDULED' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); cancelMutation.mutate(email.id); }}
                    disabled={cancelMutation.isPending}
                    className="shrink-0 rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-red-50 hover:text-red-500"
                    title="Cancel"
                  >
                    {cancelMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}

                {email.status === 'SENT' && (
                  <div className="shrink-0 rounded-full bg-green-50 p-1">
                    <Check className="h-3 w-3 text-green-500" />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none select-none p-0.5 transition-colors"
      >
        <ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
