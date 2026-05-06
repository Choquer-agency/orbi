import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { CalendarClock, Sun, Cloud, ChevronLeft } from 'lucide-react';
import { DateTimePicker } from '../ui/DateTimePicker';

interface ScheduleSendMenuProps {
  onSchedule: (sendAt: Date) => void;
  disabled?: boolean;
}

function getNextBusinessDay(fromDate: Date): Date {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function getNextMonday(fromDate: Date): Date {
  const d = new Date(fromDate);
  const day = d.getDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + daysUntilMonday);
  return d;
}

function setTime(date: Date, hours: number, minutes: number): Date {
  const d = new Date(date);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function formatPresetDate(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function ScheduleSendMenu({ onSchedule, disabled }: ScheduleSendMenuProps) {
  const [view, setView] = useState<'presets' | 'custom'>('presets');
  const [customDate, setCustomDate] = useState<Date | null>(null);

  const now = new Date();
  const nextDay = getNextBusinessDay(now);
  const nextMonday = getNextMonday(now);

  const tomorrowMorning = setTime(nextDay, 8, 0);
  const tomorrowAfternoon = setTime(nextDay, 13, 0);
  const mondayMorning = setTime(nextMonday, 8, 0);

  const showMonday = nextDay.getDay() !== nextMonday.getDay();

  const handleCustomSchedule = () => {
    if (customDate && customDate > new Date()) {
      onSchedule(customDate);
      setView('presets');
      setCustomDate(null);
    }
  };

  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (!open) setView('presets'); }}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          className="rounded-lg p-1.5 text-amber-500 transition-colors hover:bg-amber-50 hover:text-amber-600 disabled:opacity-50"
          title="Schedule send"
        >
          <CalendarClock className="h-4 w-4" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 rounded-lg border border-border bg-white p-1.5 shadow-xl animate-in fade-in slide-in-from-top-1"
        >
          {view === 'presets' ? (
            <>
              <div className="px-2.5 py-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                  Schedule Send
                </span>
              </div>

              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-text-primary outline-none data-[highlighted]:bg-amber-50"
                onSelect={() => onSchedule(tomorrowMorning)}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50">
                  <Sun className="h-4 w-4 text-amber-500" />
                </div>
                <div className="flex-1">
                  <div className="text-[13px] font-medium">Tomorrow morning</div>
                  <div className="text-[11px] text-text-tertiary">
                    {formatPresetDate(tomorrowMorning)}, 8:00 AM
                  </div>
                </div>
              </DropdownMenu.Item>

              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-text-primary outline-none data-[highlighted]:bg-blue-50"
                onSelect={() => onSchedule(tomorrowAfternoon)}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50">
                  <Cloud className="h-4 w-4 text-blue-500" />
                </div>
                <div className="flex-1">
                  <div className="text-[13px] font-medium">Tomorrow afternoon</div>
                  <div className="text-[11px] text-text-tertiary">
                    {formatPresetDate(tomorrowAfternoon)}, 1:00 PM
                  </div>
                </div>
              </DropdownMenu.Item>

              {showMonday && (
                <DropdownMenu.Item
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-text-primary outline-none data-[highlighted]:bg-violet-50"
                  onSelect={() => onSchedule(mondayMorning)}
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50">
                    <CalendarClock className="h-4 w-4 text-violet-500" />
                  </div>
                  <div className="flex-1">
                    <div className="text-[13px] font-medium">Monday morning</div>
                    <div className="text-[11px] text-text-tertiary">
                      {formatPresetDate(mondayMorning)}, 8:00 AM
                    </div>
                  </div>
                </DropdownMenu.Item>
              )}

              <DropdownMenu.Separator className="my-1 h-px bg-border" />

              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-text-primary outline-none data-[highlighted]:bg-surface"
                onSelect={(e) => {
                  e.preventDefault();
                  setView('custom');
                }}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface">
                  <CalendarClock className="h-4 w-4 text-text-tertiary" />
                </div>
                <span className="text-[13px] font-medium">Pick a date & time...</span>
              </DropdownMenu.Item>
            </>
          ) : (
            <div className="p-2">
              {/* Back + header */}
              <div className="mb-2 flex items-center gap-2">
                <button
                  onClick={() => setView('presets')}
                  className="rounded-lg p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                  Pick Date & Time
                </span>
              </div>

              <DateTimePicker
                minDate={new Date()}
                onChange={(date) => setCustomDate(date)}
              />

              {/* Schedule button */}
              <button
                onClick={handleCustomSchedule}
                disabled={!customDate || customDate <= new Date()}
                className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
              >
                {customDate
                  ? `Schedule for ${customDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${customDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                  : 'Select a date first'}
              </button>
            </div>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
