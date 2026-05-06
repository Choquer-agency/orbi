import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { cn } from '../../lib/utils';

interface DateTimePickerProps {
  value?: Date;
  minDate?: Date;
  onChange: (date: Date) => void;
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isBeforeDay(a: Date, b: Date) {
  const aDay = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bDay = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return aDay < bDay;
}

export function DateTimePicker({ value, minDate, onChange }: DateTimePickerProps) {
  const now = new Date();
  const min = minDate || now;

  const [viewMonth, setViewMonth] = useState(value?.getMonth() ?? now.getMonth());
  const [viewYear, setViewYear] = useState(value?.getFullYear() ?? now.getFullYear());
  const [selectedDate, setSelectedDate] = useState<Date | null>(value || null);
  const [hour, setHour] = useState(value ? (value.getHours() % 12 || 12) : 9);
  const [minute, setMinute] = useState(value ? value.getMinutes() : 0);
  const [amPm, setAmPm] = useState<'AM' | 'PM'>(value ? (value.getHours() >= 12 ? 'PM' : 'AM') : 'AM');

  // Build calendar grid
  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

    const days: { date: Date; inMonth: boolean }[] = [];

    // Previous month trailing days
    for (let i = firstDay - 1; i >= 0; i--) {
      days.push({
        date: new Date(viewYear, viewMonth - 1, daysInPrevMonth - i),
        inMonth: false,
      });
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      days.push({
        date: new Date(viewYear, viewMonth, d),
        inMonth: true,
      });
    }

    // Next month leading days (fill to 42 = 6 rows)
    const remaining = 42 - days.length;
    for (let d = 1; d <= remaining; d++) {
      days.push({
        date: new Date(viewYear, viewMonth + 1, d),
        inMonth: false,
      });
    }

    return days;
  }, [viewMonth, viewYear]);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const canGoPrev = !(viewYear === min.getFullYear() && viewMonth <= min.getMonth());

  const selectDay = (date: Date) => {
    setSelectedDate(date);
    // Auto-emit combined date + time
    emitDate(date, hour, minute, amPm);
  };

  const emitDate = (date: Date | null, h: number, m: number, ap: 'AM' | 'PM') => {
    if (!date) return;
    const d = new Date(date);
    let hours24 = h % 12;
    if (ap === 'PM') hours24 += 12;
    d.setHours(hours24, m, 0, 0);
    onChange(d);
  };

  const handleHourChange = (h: number) => {
    setHour(h);
    emitDate(selectedDate, h, minute, amPm);
  };

  const handleMinuteChange = (m: number) => {
    setMinute(m);
    emitDate(selectedDate, hour, m, amPm);
  };

  const handleAmPmToggle = () => {
    const next = amPm === 'AM' ? 'PM' : 'AM';
    setAmPm(next);
    emitDate(selectedDate, hour, minute, next);
  };

  return (
    <div className="w-[280px] select-none">
      {/* Month/year navigation */}
      <div className="flex items-center justify-between px-1 pb-2">
        <button
          onClick={prevMonth}
          disabled={!canGoPrev}
          className="rounded-lg p-1 text-text-secondary transition-colors hover:bg-surface disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold text-text-primary">
          {MONTHS[viewMonth]} {viewYear}
        </span>
        <button
          onClick={nextMonth}
          className="rounded-lg p-1 text-text-secondary transition-colors hover:bg-surface"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-0">
        {DAYS.map((d) => (
          <div key={d} className="pb-1 text-center text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-0">
        {calendarDays.map(({ date, inMonth }, i) => {
          const isToday = isSameDay(date, now);
          const isSelected = selectedDate && isSameDay(date, selectedDate);
          const isPast = isBeforeDay(date, min);
          const disabled = isPast || !inMonth;

          return (
            <button
              key={i}
              onClick={() => !disabled && selectDay(date)}
              disabled={disabled}
              className={cn(
                'mx-auto flex h-8 w-8 items-center justify-center rounded-full text-xs transition-all',
                !inMonth && 'text-text-tertiary/40',
                inMonth && !isSelected && !isToday && !isPast && 'text-text-primary hover:bg-primary/10 hover:text-primary',
                isToday && !isSelected && 'font-bold text-primary',
                isSelected && 'bg-primary font-semibold text-white shadow-sm',
                isPast && inMonth && 'text-text-tertiary/50',
                disabled && 'cursor-default',
              )}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>

      {/* Time picker */}
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <Clock className="h-3.5 w-3.5 text-text-tertiary" />
        <span className="text-xs font-medium text-text-secondary">Time</span>
        <div className="ml-auto flex items-center gap-1">
          {/* Hour */}
          <select
            value={hour}
            onChange={(e) => handleHourChange(parseInt(e.target.value))}
            className="rounded-lg border border-border bg-white px-1.5 py-1 text-xs font-medium text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          <span className="text-xs font-bold text-text-tertiary">:</span>
          {/* Minute */}
          <select
            value={minute}
            onChange={(e) => handleMinuteChange(parseInt(e.target.value))}
            className="rounded-lg border border-border bg-white px-1.5 py-1 text-xs font-medium text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
              <option key={m} value={m}>{m.toString().padStart(2, '0')}</option>
            ))}
          </select>
          {/* AM/PM toggle */}
          <button
            onClick={handleAmPmToggle}
            className="rounded-lg border border-border bg-white px-2 py-1 text-xs font-semibold text-text-primary transition-colors hover:bg-surface"
          >
            {amPm}
          </button>
        </div>
      </div>
    </div>
  );
}
