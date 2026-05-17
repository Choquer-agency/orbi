import { useState, useRef, useEffect } from 'react';
import { usePersonAutocomplete } from '../../hooks/usePersons';
import { useAnyHistoricalSyncInProgress } from '../../hooks/useHistoricalSync';
import { getAvatarColor } from '../../lib/constants';
import { cn, getInitials } from '../../lib/utils';

interface RecipientInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function RecipientInput({ value, onChange, placeholder }: RecipientInputProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [expandedPersonId, setExpandedPersonId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // The current "segment" being typed (after the last comma)
  const parts = value.split(',');
  const currentSegment = parts[parts.length - 1]?.trim() || '';

  const { data } = usePersonAutocomplete(currentSegment);
  const suggestions = data?.data ?? [];
  const importStatus = useAnyHistoricalSyncInProgress();
  // Show the "still indexing" hint when the user is typing but we don't yet
  // have a match and an import (or contact backfill) is mid-flight — the
  // contact they're looking for may simply not be indexed yet.
  const showIndexingHint =
    currentSegment.length >= 1 &&
    suggestions.length === 0 &&
    (importStatus.inProgress || importStatus.contactBackfillInProgress);

  // Build flat list for keyboard navigation: persons + their expanded emails
  const flatItems: { type: 'person' | 'email'; person: any; contact?: any; index: number }[] = [];
  let idx = 0;
  for (const person of suggestions) {
    flatItems.push({ type: 'person', person, index: idx++ });
    if (expandedPersonId === person.id && person.contacts?.length > 1) {
      for (const contact of person.contacts) {
        flatItems.push({ type: 'email', person, contact, index: idx++ });
      }
    }
  }

  useEffect(() => {
    setShowDropdown(
      currentSegment.length >= 1 && (suggestions.length > 0 || showIndexingHint),
    );
    setActiveIndex(0);
    setExpandedPersonId(null);
  }, [currentSegment, suggestions.length, showIndexingHint]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
        setExpandedPersonId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectEmail = (email: string) => {
    const prefix = parts.slice(0, -1).join(', ');
    const newValue = prefix ? `${prefix}, ${email}, ` : `${email}, `;
    onChange(newValue);
    setShowDropdown(false);
    setExpandedPersonId(null);
    inputRef.current?.focus();
  };

  const handlePersonClick = (person: any) => {
    if (person.contacts?.length === 1) {
      // Single email — select directly
      selectEmail(person.contacts[0].email);
    } else if (person.contacts?.length > 1) {
      // Multiple emails — expand to show sub-options
      setExpandedPersonId((prev) => (prev === person.id ? null : person.id));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown || flatItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const item = flatItems[activeIndex];
      if (item) {
        e.preventDefault();
        if (item.type === 'email' && item.contact) {
          selectEmail(item.contact.email);
        } else if (item.type === 'person') {
          if (item.person.contacts?.length === 1) {
            selectEmail(item.person.contacts[0].email);
          } else {
            // Expand the person on Enter
            setExpandedPersonId((prev) => (prev === item.person.id ? null : item.person.id));
          }
        }
      }
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
      setExpandedPersonId(null);
    }
  };

  return (
    <div className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (currentSegment.length >= 1 && (suggestions.length > 0 || showIndexingHint)) {
            setShowDropdown(true);
          }
        }}
        className="w-full text-sm text-text-primary outline-none placeholder:text-text-tertiary"
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-form-type="other"
        data-lpignore="true"
      />

      {showDropdown && (flatItems.length > 0 || showIndexingHint) && (
        <div
          ref={dropdownRef}
          className="absolute left-0 top-full z-50 mt-1 w-[360px] max-h-[300px] overflow-y-auto rounded-lg border border-border bg-white py-1 shadow-lg"
        >
          {flatItems.map((item) => {
            if (item.type === 'person') {
              const person = item.person;
              const avatarColor = getAvatarColor(person.displayName || person.contacts?.[0]?.email || '');
              const hasMultiple = person.contacts?.length > 1;
              const isExpanded = expandedPersonId === person.id;

              return (
                <button
                  key={`person-${person.id}`}
                  onClick={() => handlePersonClick(person)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                    item.index === activeIndex ? 'bg-selected' : 'hover:bg-surface',
                  )}
                >
                  <div
                    className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold', avatarColor.bg, avatarColor.text)}
                  >
                    {getInitials(person.displayName || person.contacts?.[0]?.email || '')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {person.displayName || person.contacts?.[0]?.email}
                    </p>
                    <p className="truncate text-[11px] text-text-tertiary">
                      {hasMultiple
                        ? `${person.contacts.length} emails`
                        : person.contacts?.[0]?.email}
                      {person.company && ` · ${person.company}`}
                    </p>
                  </div>
                  {hasMultiple && (
                    <span className={cn(
                      'shrink-0 text-[10px] text-text-tertiary transition-transform',
                      isExpanded && 'rotate-180',
                    )}>
                      ▾
                    </span>
                  )}
                </button>
              );
            }

            // Email sub-item
            const { contact } = item;
            return (
              <button
                key={`email-${contact.id}`}
                onClick={() => selectEmail(contact.email)}
                className={cn(
                  'flex w-full items-center gap-2.5 pl-12 pr-3 py-1.5 text-left transition-colors',
                  item.index === activeIndex ? 'bg-selected' : 'hover:bg-surface',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-text-primary">
                    {contact.email}
                  </p>
                  {contact.company && (
                    <p className="truncate text-[10px] text-text-tertiary">{contact.company}</p>
                  )}
                </div>
                <span className="shrink-0 text-[10px] text-text-tertiary tabular-nums">
                  {contact.emailCount || 0}
                </span>
              </button>
            );
          })}
          {showIndexingHint && (
            <div className="border-t border-border px-3 py-2 text-[11px] text-text-tertiary">
              Still indexing your contacts — more matches will appear as your
              email finishes importing. You can type the address directly to
              keep going.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
