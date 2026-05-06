import { useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Clock, Sun, Moon, CalendarDays, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { useSnoozeThread } from '../../hooks/useThreads';

interface SnoozePopoverProps {
  threadId: string;
  trigger: ReactNode;
}

function getLaterToday(): Date {
  const now = new Date();
  const today6pm = new Date(now);
  today6pm.setHours(18, 0, 0, 0);

  if (now >= today6pm) {
    // Past 6 PM — use tomorrow 8 AM
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    return tomorrow;
  }
  return today6pm;
}

function getTomorrowMorning(): Date {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  return tomorrow;
}

function getNextWeek(): Date {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const nextMonday = new Date(now);
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
  nextMonday.setHours(8, 0, 0, 0);
  return nextMonday;
}

function formatSnoozeLabel(date: Date): string {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (isToday) return `today at ${time}`;
  if (isTomorrow) return `tomorrow at ${time}`;
  return `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}

export function SnoozePopover({ threadId, trigger }: SnoozePopoverProps) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const snoozeThread = useSnoozeThread();

  const handleSnooze = (date: Date) => {
    snoozeThread.mutate(
      { id: threadId, snoozedUntil: date.toISOString() },
      {
        onSuccess: () => {
          toast.success(`Snoozed until ${formatSnoozeLabel(date)}`);
          setOpen(false);
          setShowCustom(false);
        },
        onError: () => toast.error('Failed to snooze thread'),
      },
    );
  };

  const handleCustomSubmit = () => {
    if (!customDate) return;
    const date = new Date(customDate);
    if (date.getTime() <= Date.now()) {
      toast.error('Pick a future date');
      return;
    }
    handleSnooze(date);
  };

  const laterToday = getLaterToday();
  const isPastEvening = new Date().getHours() >= 18;

  return (
    <Popover.Root open={open} onOpenChange={(v) => { setOpen(v); if (!v) setShowCustom(false); }}>
      <Popover.Trigger asChild>
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className="z-50 w-56 rounded-xl border border-border bg-white p-1 shadow-lg animate-in fade-in zoom-in-95"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2 py-1.5 text-xs font-medium text-text-tertiary">Snooze until</div>

          <button
            onClick={() => handleSnooze(laterToday)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-bg-secondary"
          >
            {isPastEvening ? <Sun className="h-4 w-4 text-amber-500" /> : <Moon className="h-4 w-4 text-indigo-400" />}
            <span>{isPastEvening ? 'Tomorrow morning' : 'Later today'}</span>
            <span className="ml-auto text-xs text-text-tertiary">
              {laterToday.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          </button>

          {!isPastEvening && (
            <button
              onClick={() => handleSnooze(getTomorrowMorning())}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-bg-secondary"
            >
              <Sun className="h-4 w-4 text-amber-500" />
              <span>Tomorrow morning</span>
              <span className="ml-auto text-xs text-text-tertiary">8:00 AM</span>
            </button>
          )}

          <button
            onClick={() => handleSnooze(getNextWeek())}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-bg-secondary"
          >
            <CalendarDays className="h-4 w-4 text-blue-500" />
            <span>Next week</span>
            <span className="ml-auto text-xs text-text-tertiary">Mon 8:00 AM</span>
          </button>

          <div className="my-1 border-t border-border" />

          {!showCustom ? (
            <button
              onClick={() => setShowCustom(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-bg-secondary"
            >
              <Clock className="h-4 w-4 text-text-tertiary" />
              <span>Pick date & time</span>
            </button>
          ) : (
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <input
                type="datetime-local"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                min={new Date().toISOString().slice(0, 16)}
                className="flex-1 rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand"
                autoFocus
              />
              <button
                onClick={handleCustomSubmit}
                disabled={!customDate}
                className="rounded-lg bg-brand p-1.5 text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
