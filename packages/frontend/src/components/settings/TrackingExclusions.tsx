import { useState, useRef, useEffect, useCallback } from 'react';
import { EyeOff, Plus, Trash2, Mail, Globe } from 'lucide-react';
import {
  useTrackingExclusions,
  useAddTrackingExclusion,
  useDeleteTrackingExclusion,
} from '../../hooks/useTrackingExclusions';
import { api } from '../../lib/api';

const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'live.com', 'msn.com', 'protonmail.com', 'mail.com',
  'ymail.com', 'googlemail.com', 'me.com', 'mac.com',
]);

interface Suggestion {
  type: 'email' | 'domain';
  value: string;
  label: string;
  sublabel?: string;
}

export function TrackingExclusions() {
  const { data: exclusions } = useTrackingExclusions();
  const addExclusion = useAddTrackingExclusion();
  const deleteExclusion = useDeleteTrackingExclusion();
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) return;
    addExclusion.mutate(
      { emailAddress: trimmed, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setEmail('');
          setReason('');
          setSuggestions([]);
          setShowDropdown(false);
        },
      },
    );
  };

  const fetchSuggestions = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }
    try {
      const contacts = await api.get<{ id: string; email: string; name: string | null; company: string | null }[]>(
        `/contacts/autocomplete?q=${encodeURIComponent(query)}`
      );
      const items: Suggestion[] = [];
      const seenDomains = new Set<string>();

      for (const contact of contacts) {
        const domain = contact.email.split('@')[1];
        // Full email option
        items.push({
          type: 'email',
          value: contact.email,
          label: contact.email,
          sublabel: contact.name || undefined,
        });
        // Domain option (skip public providers and dedup)
        if (domain && !PUBLIC_DOMAINS.has(domain) && !seenDomains.has(domain)) {
          seenDomains.add(domain);
          items.push({
            type: 'domain',
            value: `@${domain}`,
            label: `@${domain}`,
            sublabel: `All from ${domain}`,
          });
        }
      }
      setSuggestions(items);
      setSelectedIndex(0);
      setShowDropdown(items.length > 0);
    } catch {
      setSuggestions([]);
      setShowDropdown(false);
    }
  }, []);

  const handleInputChange = (value: string) => {
    setEmail(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(value), 300);
  };

  const selectSuggestion = (suggestion: Suggestion) => {
    setEmail(suggestion.value);
    setShowDropdown(false);
    setSuggestions([]);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showDropdown && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && suggestions[selectedIndex]) {
        e.preventDefault();
        selectSuggestion(suggestions[selectedIndex]);
        return;
      } else if (e.key === 'Escape') {
        setShowDropdown(false);
        return;
      }
    }
    if (e.key === 'Enter' && !showDropdown) {
      handleAdd();
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <EyeOff className="h-4 w-4 text-text-secondary" />
        <h3 className="text-[13px] font-semibold text-text-primary">Tracking Exclusions</h3>
      </div>

      <p className="text-[11px] text-text-tertiary leading-relaxed">
        Emails from these addresses won't count toward your response time metrics
        or appear in the "needs reply" list. Use this for analytics services,
        automated notifications, or any address that doesn't need a human response.
      </p>

      {/* Add form */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1" ref={dropdownRef}>
            <input
              ref={inputRef}
              type="text"
              value={email}
              onChange={(e) => handleInputChange(e.target.value)}
              onFocus={() => suggestions.length > 0 && setShowDropdown(true)}
              onKeyDown={handleKeyDown}
              placeholder="Type to search contacts or enter an email..."
              className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            {showDropdown && suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-white shadow-lg">
                {suggestions.map((s, i) => (
                  <button
                    key={`${s.type}-${s.value}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSuggestion(s);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors ${
                      i === selectedIndex ? 'bg-primary/10' : 'hover:bg-surface'
                    }`}
                  >
                    {s.type === 'email' ? (
                      <Mail className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                    ) : (
                      <Globe className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                    )}
                    <div className="min-w-0">
                      <span className="font-medium text-text-primary">{s.label}</span>
                      {s.sublabel && (
                        <span className="ml-2 text-text-tertiary">{s.sublabel}</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={handleAdd}
            disabled={addExclusion.isPending || !email.includes('@')}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
        </div>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional): e.g., Google Analytics alerts"
          className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
      </div>

      {/* List */}
      {exclusions && exclusions.length > 0 && (
        <div className="space-y-1">
          {exclusions.map((exc) => (
            <div
              key={exc.id}
              className="flex items-center justify-between rounded-lg bg-surface/50 px-3 py-2"
            >
              <div className="min-w-0 flex items-center gap-2">
                {exc.emailAddress.startsWith('@') ? (
                  <Globe className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                ) : (
                  <Mail className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-medium text-text-primary">
                    {exc.emailAddress}
                  </p>
                  {exc.reason && (
                    <p className="truncate text-[11px] text-text-tertiary">{exc.reason}</p>
                  )}
                </div>
              </div>
              <button
                onClick={() => deleteExclusion.mutate(exc.id)}
                className="shrink-0 rounded p-1 text-text-tertiary transition-colors hover:bg-white hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {exclusions && exclusions.length === 0 && (
        <p className="text-center text-[11px] text-text-tertiary py-2">
          No excluded addresses yet
        </p>
      )}
    </div>
  );
}
