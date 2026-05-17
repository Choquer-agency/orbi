import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import { Search, Check, Plus, X, Archive, Star, Trash2, Loader2, Mail, MailOpen, User, Inbox, Calendar, Paperclip, Tag, RefreshCw } from 'lucide-react';
import { useThreads, useUpdateThread } from '../../hooks/useThreads';
import { useAccounts } from '../../hooks/useAccounts';
import { useContactAutocomplete } from '../../hooks/useContacts';
import { useInboxSplits } from '../../hooks/useInboxSplits';
import { useAnyHistoricalSyncInProgress } from '../../hooks/useHistoricalSync';
import { useUiStore } from '../../stores/uiStore';
import { cn, groupByDate } from '../../lib/utils';
import { getAccountColor } from '../../lib/constants';
import { useIsMobile } from '../../hooks/useIsMobile';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { NavigationDropdown } from '../navigation/NavigationDropdown';
import { ThreadItem } from './ThreadItem';
import { ScheduledEmailList } from '../scheduled/ScheduledEmailList';
import { NeedsResponseList } from './NeedsResponseList';

const FILTER_TABS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'starred', label: 'Starred' },
] as const;

export function ThreadList() {
  const { selectedAccountId, selectedThreadId, selectedFolder, threadListFilter, setSelectedThread, setThreadListFilter, composingNew, setComposingNew, selectedThreadIds, toggleThreadSelection, selectThreadRange, clearSelection, inboxFilterMode, contactSearchEmail, setContactSearchEmail } =
    useUiStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchFrom, setSearchFrom] = useState<string | undefined>(undefined);
  const [searchPills, setSearchPills] = useState<{ operator: string; value: string }[]>([]);
  const [activeOperator, setActiveOperator] = useState<string | null>(null); // operator being filled in (e.g. "from:")
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [activeSplitCategory, setActiveSplitCategory] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileSplitMenuOpen, setMobileSplitMenuOpen] = useState(false);
  const isMobile = useIsMobile();
  const selectedSuggestionRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const { data: inboxSplits } = useInboxSplits();
  const enabledSplits = useMemo(() => inboxSplits?.filter((s) => s.isEnabled) ?? [], [inboxSplits]);

  // Contact autocomplete for suggestions dropdown
  const { data: autocompleteData } = useContactAutocomplete(searchQuery);
  const suggestions = autocompleteData?.data ?? [];

  // Suggestions are visible as long as there's input, matches exist, and user hasn't dismissed
  const showSuggestions = searchQuery.length >= 1 && suggestions.length > 0 && !suggestionsDismissed;

  // Reset suggestion index when results change — start at -1 (nothing highlighted)
  useEffect(() => {
    setSuggestionIndex(-1);
  }, [searchQuery, suggestions.length]);

  // Re-enable suggestions when query changes (user is typing again)
  useEffect(() => {
    if (selectedSuggestionRef.current) {
      selectedSuggestionRef.current = false;
      return;
    }
    setSuggestionsDismissed(false);
    setSearchFrom(undefined);
  }, [searchQuery]);

  // Clear searchFrom when from: pill is removed
  useEffect(() => {
    if (searchFrom && !searchPills.some((p) => p.operator === 'from:')) {
      setSearchFrom(undefined);
    }
  }, [searchPills, searchFrom]);

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node) &&
        searchInputRef.current && !searchInputRef.current.contains(e.target as Node)
      ) {
        setSuggestionsDismissed(true);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Build full search string from pills + free text
  const buildSearchString = useCallback(() => {
    const parts = searchPills.map((p) => `${p.operator}${p.value}`);
    if (searchQuery.trim()) parts.push(searchQuery.trim());
    return parts.join(' ');
  }, [searchPills, searchQuery]);

  // Debounce search input by 300ms (react to query text or pill changes)
  useEffect(() => {
    const full = buildSearchString();
    const timer = setTimeout(() => setDebouncedSearch(full), 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchPills, buildSearchString]);

  // Clear search when folder changes
  useEffect(() => {
    setSearchQuery('');
    setDebouncedSearch('');
    setSearchFrom(undefined);
    setSearchPills([]);
    setActiveOperator(null);
  }, [selectedFolder]);

  // Pick up contact search from contacts page navigation
  useEffect(() => {
    if (contactSearchEmail) {
      setSearchQuery(contactSearchEmail);
      setDebouncedSearch(contactSearchEmail);
      setSearchFrom(contactSearchEmail);
      setSearchOpen(true);
      setSuggestionsDismissed(true);
      setContactSearchEmail(null);
    }
  }, [contactSearchEmail, setContactSearchEmail]);

  const isSearching = debouncedSearch.length > 0 || !!searchFrom || searchPills.length > 0;

  const selectSuggestion = (type: 'name' | 'email', contact: any) => {
    const displayValue = type === 'name' ? (contact.name || contact.email) : contact.email;
    selectedSuggestionRef.current = true;
    // Add as a from: pill instead of raw text
    setSearchPills((prev) => {
      // Replace any existing from: pill
      const without = prev.filter((p) => p.operator !== 'from:');
      return [...without, { operator: 'from:', value: displayValue }];
    });
    setSearchQuery('');
    setSearchFrom(contact.email);
    setActiveOperator(null);
    setSuggestionsDismissed(true);
  };

  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useThreads({
    accountId: selectedAccountId ?? undefined,
    folder: isSearching ? undefined : (selectedFolder !== 'dashboard' ? selectedFolder : 'inbox'),
    search: searchFrom ? undefined : (debouncedSearch || undefined),
    from: searchFrom,
    category: (selectedFolder === 'inbox' && activeSplitCategory) ? activeSplitCategory : undefined,
  });
  const { data: accountsData } = useAccounts();
  const updateThread = useUpdateThread();
  const importStatus = useAnyHistoricalSyncInProgress();

  // Infinite scroll: observe last element
  const observer = useRef<IntersectionObserver | null>(null);
  const lastThreadRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (isFetchingNextPage) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasNextPage) {
          fetchNextPage();
        }
      });
      if (node) observer.current.observe(node);
    },
    [isFetchingNextPage, hasNextPage, fetchNextPage],
  );

  // Build accountId → color map. Prefer the user-chosen `color` saved on the
  // account; fall back to a deterministic palette index so brand-new accounts
  // still get a distinct ring before the user picks one.
  // useAccounts() returns { data: <array> }, so `accountsData` IS the array —
  // `accountsData?.data` would access .data on an array (always undefined)
  // and quietly leave the map empty (which is why the rings weren't showing).
  const accountColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const accounts = (accountsData ?? []) as Array<{ id: string; color?: string | null }>;
    accounts.forEach((acc, i) => {
      map.set(acc.id, acc.color ?? getAccountColor(i));
    });
    return map;
  }, [accountsData]);

  // Flatten pages into a single thread list
  let threads = useMemo(
    () => data?.pages.flatMap((page) => page.data) ?? [],
    [data],
  );
  const totalCount = data?.pages[0]?.total ?? 0;

  // Client-side filtering
  if (threadListFilter === 'unread') {
    threads = threads.filter((t: any) => !t.isRead);
  } else if (threadListFilter === 'starred') {
    threads = threads.filter((t: any) => t.isStarred);
  }

  const dateGroups = groupByDate(threads);
  const allThreadIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of dateGroups) {
      for (const thread of group.items) {
        ids.push((thread as any).id);
      }
    }
    return ids;
  }, [dateGroups]);

  const selectionCount = selectedThreadIds.size;

  // Toggle target for the read/unread bulk action: if every selected thread is
  // already read, the next action is "Mark as unread"; otherwise we mark them
  // all read (covers all-unread + mixed selections in one click).
  const selectedThreadsRead = useMemo(() => {
    if (selectionCount === 0) return true;
    for (const group of dateGroups) {
      for (const t of group.items as any[]) {
        if (selectedThreadIds.has(t.id) && !t.isRead) return false;
      }
    }
    return true;
  }, [dateGroups, selectedThreadIds, selectionCount]);

  // Pull-to-refresh on mobile
  const { scrollRef: pullToRefreshRef, pullDistance, isRefreshing } = usePullToRefresh({
    onRefresh: () => refetch(),
    enabled: isMobile && selectionCount === 0,
  });

  // Track which date group header is currently stuck at top on mobile
  const [visibleDateGroup, setVisibleDateGroup] = useState<string | null>(null);
  const dateGroupRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Intersection observer to detect which group header is "stuck" at the top
  useEffect(() => {
    if (!isMobile || dateGroups.length === 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const containerTop = container.getBoundingClientRect().top;
      let current: string | null = null;
      for (const [label, el] of dateGroupRefs.current) {
        const rect = el.getBoundingClientRect();
        // The header is at or above the container top — it's the "current" one
        if (rect.top <= containerTop + 2) {
          current = label;
        }
      }
      setVisibleDateGroup(current);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
  }, [isMobile, dateGroups]);

  const handleBulkDelete = () => {
    selectedThreadIds.forEach((id) => updateThread.mutate({ id, isTrashed: true }));
    clearSelection();
  };
  const handleBulkArchive = () => {
    selectedThreadIds.forEach((id) => updateThread.mutate({ id, isArchived: true }));
    clearSelection();
  };
  const handleBulkStar = () => {
    selectedThreadIds.forEach((id) => updateThread.mutate({ id, isStarred: true }));
    clearSelection();
  };
  const handleBulkMarkUnread = () => {
    selectedThreadIds.forEach((id) => updateThread.mutate({ id, isRead: false }));
    clearSelection();
  };
  const handleBulkMarkRead = () => {
    selectedThreadIds.forEach((id) => updateThread.mutate({ id, isRead: true }));
    clearSelection();
  };
  const handleBulkMoveToInbox = () => {
    selectedThreadIds.forEach((id) => updateThread.mutate({ id, isArchived: false, isTrashed: false }));
    clearSelection();
  };

  const handleThreadSelect = (id: string) => {
    clearSelection();
    setSelectedThread(id);
  };

  return (
    <div className="relative flex h-full flex-col bg-surface">
      {/* Global import progress strip — visible across mobile + desktop while
          historical sync (or contact backfill) is running. Disappears on its
          own once the user's accounts are fully caught up. */}
      {(importStatus.inProgress || importStatus.contactBackfillInProgress) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/5 px-3 py-1.5 text-[11px] text-text-secondary">
          <Loader2 className="h-3 w-3 animate-spin text-primary" />
          {importStatus.inProgress ? (
            <span className="truncate">
              Importing email
              {importStatus.totalThreads > 0
                ? ` — ${importStatus.syncedThreads.toLocaleString()} of ~${importStatus.totalThreads.toLocaleString()}`
                : importStatus.syncedThreads > 0
                  ? ` — ${importStatus.syncedThreads.toLocaleString()} so far`
                  : '…'}
              {importStatus.accountEmail ? ` · ${importStatus.accountEmail}` : ''}
            </span>
          ) : (
            <span className="truncate">Indexing contacts so they show up in compose…</span>
          )}
        </div>
      )}

      {/* Header */}
      {isMobile ? (
        /* Mobile: "Primary" dropdown left, filter menu icon right */
        <>
          <div className="flex items-center justify-between border-b border-border px-3 pb-2.5 pt-1" style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 0.25rem)' }}>
            <NavigationDropdown />
            {enabledSplits.length > 1 && (
              <button
                onClick={() => setMobileSplitMenuOpen((v) => !v)}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
                  mobileSplitMenuOpen || activeSplitCategory
                    ? 'bg-primary/10 text-primary'
                    : 'text-text-tertiary',
                )}
              >
                <Tag className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* Expandable category filter row */}
          <AnimatePresence>
            {mobileSplitMenuOpen && enabledSplits.length > 1 && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className="overflow-hidden border-b border-border"
              >
                <div className="flex items-center gap-1 overflow-x-auto px-3 py-2 scrollbar-none">
                  {enabledSplits.map((split) => {
                    const isActive = split.category === 'all'
                      ? !activeSplitCategory
                      : activeSplitCategory === split.category;
                    return (
                      <button
                        key={split.id}
                        onClick={() => {
                          setActiveSplitCategory(split.category === 'all' ? null : split.category);
                          setMobileSplitMenuOpen(false);
                        }}
                        className={cn(
                          'shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                          isActive
                            ? 'bg-primary/10 text-primary'
                            : 'text-text-tertiary',
                        )}
                      >
                        {split.label}
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ) : (
        <div className="flex items-center gap-2 border-b border-border px-3 pb-2 pt-[30px]">
          <NavigationDropdown />
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setComposingNew(true)}
              className={cn(
                'flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors',
                composingNew
                  ? 'bg-primary text-white'
                  : 'bg-primary/10 text-primary hover:bg-primary/20',
              )}
              title="Compose new email"
            >
              <Plus className="h-3 w-3" />
              Compose
            </button>
            <button
              onClick={() => { setSearchOpen(true); }}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
                searchOpen || isSearching
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-tertiary hover:bg-surface hover:text-text-primary',
              )}
            >
              <Search className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Expanding search bar */}
      <AnimatePresence>
        {searchOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            style={{ overflow: showSuggestions ? 'visible' : 'hidden' }}
            className="border-b border-border"
          >
            <div className="relative px-3 py-2">
              <motion.div
                initial={{ y: -8, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.05 }}
                className="relative flex items-center gap-1.5 rounded-lg border border-border bg-surface/50 px-2.5 backdrop-blur-sm focus-within:border-primary focus-within:bg-white focus-within:ring-1 focus-within:ring-primary"
              >
                <Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                {/* Committed operator pills */}
                {searchPills.map((pill, i) => (
                  <span
                    key={`${pill.operator}-${i}`}
                    className="flex shrink-0 items-center gap-0.5 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
                  >
                    <span className="text-primary/60">{pill.operator}</span>
                    {pill.value}
                    <button
                      type="button"
                      onClick={() => {
                        setSearchPills((prev) => prev.filter((_, j) => j !== i));
                        searchInputRef.current?.focus();
                      }}
                      className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
                {/* Active operator being filled — shows as a pill label before the input */}
                {activeOperator && (
                  <span className="flex shrink-0 items-center rounded-md rounded-r-none bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                    {activeOperator}
                  </span>
                )}
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (activeOperator) {
                      // Typing inside an active operator — space commits the value
                      if (val.endsWith(' ') && val.trim().length > 0) {
                        const value = val.trim();
                        setSearchPills((prev) => [
                          ...prev.filter((p) => p.operator !== activeOperator),
                          { operator: activeOperator, value },
                        ]);
                        setSearchQuery('');
                        setActiveOperator(null);
                        return;
                      }
                      setSearchQuery(val);
                      return;
                    }
                    // Detect if user manually typed an operator prefix
                    const operatorMatch = val.match(/^(from:|to:|before:|after:|has:|is:|label:)(\S*)\s?$/);
                    if (operatorMatch) {
                      const [, op, value] = operatorMatch;
                      if (value && val.endsWith(' ')) {
                        // Full operator typed with value and space — commit as pill (replacing existing)
                        setSearchPills((prev) => [
                          ...prev.filter((p) => p.operator !== op),
                          { operator: op, value },
                        ]);
                        setSearchQuery('');
                      } else if (!value) {
                        // Just the operator prefix typed — activate it as a pill label
                        setActiveOperator(op);
                        setSearchQuery('');
                      } else {
                        setSearchQuery(val);
                      }
                      return;
                    }
                    setSearchQuery(val);
                  }}
                  onKeyDown={(e) => {
                    // Enter commits active operator value
                    if (e.key === 'Enter' && activeOperator && searchQuery.trim() && !showSuggestions) {
                      e.preventDefault();
                      const value = searchQuery.trim();
                      setSearchPills((prev) => [
                        ...prev.filter((p) => p.operator !== activeOperator),
                        { operator: activeOperator, value },
                      ]);
                      setSearchQuery('');
                      setActiveOperator(null);
                      return;
                    }
                    // Backspace on empty input: cancel active operator first, then remove last pill
                    if (e.key === 'Backspace' && searchQuery === '') {
                      if (activeOperator) {
                        setActiveOperator(null);
                        return;
                      }
                      if (searchPills.length > 0) {
                        setSearchPills((prev) => prev.slice(0, -1));
                        return;
                      }
                    }
                    if (e.key === 'Escape') {
                      if (activeOperator) {
                        setActiveOperator(null);
                        setSearchQuery('');
                      } else if (showSuggestions) {
                        setSuggestionsDismissed(true);
                      } else {
                        setSearchQuery('');
                        setDebouncedSearch('');
                        setSearchFrom(undefined);
                        setSearchPills([]);
                        setActiveOperator(null);
                        setSearchOpen(false);
                      }
                      return;
                    }
                    if (showSuggestions && suggestions.length > 0) {
                      const totalItems = suggestions.reduce((acc: number, c: any) => acc + (c.name ? 2 : 1), 0);
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setSuggestionIndex((i) => Math.min(i + 1, totalItems - 1));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setSuggestionIndex((i) => Math.max(i - 1, -1));
                      } else if (e.key === 'Enter') {
                        if (suggestionIndex >= 0) {
                          e.preventDefault();
                          let idx = 0;
                          for (const contact of suggestions) {
                            if (contact.name) {
                              if (idx === suggestionIndex) { selectSuggestion('name', contact); return; }
                              idx++;
                            }
                            if (idx === suggestionIndex) { selectSuggestion('email', contact); return; }
                            idx++;
                          }
                        } else {
                          setSuggestionsDismissed(true);
                        }
                      }
                    }
                  }}
                  onFocus={() => {
                    if (searchQuery.length >= 1 && suggestions.length > 0) {
                      setSuggestionsDismissed(false);
                    }
                  }}
                  onBlur={(e) => {
                    if (suggestionsRef.current?.contains(e.relatedTarget as Node)) return;
                    setSuggestionsDismissed(true);
                  }}
                  autoFocus
                  placeholder={activeOperator ? `Type ${activeOperator.replace(':', '')} value...` : searchPills.length > 0 ? '' : 'Search emails...'}
                  className={cn(
                    'flex-1 bg-transparent py-1.5 pr-2 text-xs text-text-primary outline-none placeholder:text-text-tertiary',
                    activeOperator ? 'min-w-[80px] rounded-l-none -ml-1 bg-primary/5 pl-1' : searchPills.length > 0 ? 'min-w-[20px]' : 'min-w-[80px]',
                  )}
                />
                {searchQuery && searchQuery !== debouncedSearch && !showSuggestions && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-text-tertiary" />
                )}
                <motion.button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setDebouncedSearch('');
                    setSearchFrom(undefined);
                    setSearchPills([]);
                    setActiveOperator(null);
                    setSearchOpen(false);
                  }}
                  initial={{ scale: 0, rotate: -90 }}
                  animate={{ scale: 1, rotate: 0 }}
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                  transition={{ delay: 0.1 }}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface hover:text-text-primary"
                >
                  <X className="h-3 w-3" />
                </motion.button>
              </motion.div>

              {/* Search suggestions dropdown */}
              {showSuggestions && suggestions.length > 0 ? (
                <div
                  ref={suggestionsRef}
                  className="absolute left-3 right-3 top-full z-50 mt-1 rounded-lg border border-border bg-white py-1 shadow-lg"
                >
                  {(() => {
                    let flatIdx = 0;
                    return suggestions.map((contact: any) => {
                      const rows: React.ReactNode[] = [];

                      if (contact.name) {
                        const idx = flatIdx++;
                        rows.push(
                          <button
                            key={`${contact.id}-name`}
                            onClick={() => selectSuggestion('name', contact)}
                            className={cn(
                              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors',
                              idx === suggestionIndex ? 'bg-selected' : 'hover:bg-surface',
                            )}
                          >
                            <User className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                            <span className="truncate text-xs text-text-primary">{contact.name}</span>
                          </button>,
                        );
                      }

                      {
                        const idx = flatIdx++;
                        rows.push(
                          <button
                            key={`${contact.id}-email`}
                            onClick={() => selectSuggestion('email', contact)}
                            className={cn(
                              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors',
                              idx === suggestionIndex ? 'bg-selected' : 'hover:bg-surface',
                            )}
                          >
                            <Mail className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                            <span className="truncate text-xs text-text-secondary">{contact.email}</span>
                          </button>,
                        );
                      }

                      return rows;
                    });
                  })()}
                </div>
              ) : !searchQuery && !activeOperator && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {[
                    { label: 'from:', icon: User, needsValue: true },
                    { label: 'to:', icon: Mail, needsValue: true },
                    { label: 'before:', icon: Calendar, needsValue: true },
                    { label: 'after:', icon: Calendar, needsValue: true },
                    { label: 'has:attachment', icon: Paperclip, operator: 'has:', value: 'attachment' },
                    { label: 'is:unread', icon: MailOpen, operator: 'is:', value: 'unread' },
                    { label: 'is:starred', icon: Star, operator: 'is:', value: 'starred' },
                    { label: 'label:', icon: Tag, needsValue: true },
                  ].map((op) => {
                    // Hide chips that are already active as pills
                    const alreadyActive = searchPills.some((p) =>
                      p.operator === (op.operator ?? op.label),
                    );
                    if (alreadyActive) return null;
                    return (
                      <button
                        key={op.label}
                        type="button"
                        onClick={() => {
                          if (op.needsValue) {
                            // Activate operator — shows as pill label, input captures value
                            setActiveOperator(op.label);
                            setSearchQuery('');
                            searchInputRef.current?.focus();
                          } else {
                            // Complete operator — add as a pill immediately
                            setSearchPills((prev) => [...prev, { operator: op.operator!, value: op.value! }]);
                            searchInputRef.current?.focus();
                          }
                        }}
                        className="flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[10px] text-text-tertiary transition-colors hover:bg-border hover:text-text-secondary"
                      >
                        <op.icon className="h-2.5 w-2.5" />
                        {op.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Inbox split tabs — only in smart mode, desktop only (mobile has them in header) */}
      {!isMobile && !isSearching && selectedFolder === 'inbox' && inboxFilterMode === 'smart' && enabledSplits.length > 1 && (
        <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border px-3 py-1.5 scrollbar-none">
          {enabledSplits.map((split) => {
            const isActive = split.category === 'all'
              ? !activeSplitCategory
              : activeSplitCategory === split.category;
            return (
              <button
                key={split.id}
                onClick={() => setActiveSplitCategory(split.category === 'all' ? null : split.category)}
                className={cn(
                  'shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-text-tertiary hover:bg-surface hover:text-text-secondary',
                )}
              >
                {split.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Filter tabs — standard mode: All/Unread/Starred; smart mode: just + New (desktop only) */}
      {!isMobile && (
        isSearching ? (
          <div className="flex items-center border-b border-border px-3 py-2">
            <span className="text-xs text-text-tertiary">Searching all mail</span>
          </div>
        ) : (
          <div className="flex items-center gap-1 border-b border-border px-3 py-2">
            {inboxFilterMode === 'standard' && FILTER_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setThreadListFilter(tab.id as any); setComposingNew(false); }}
                className={cn(
                  'rounded-lg px-3 py-1 text-xs font-medium transition-colors',
                  threadListFilter === tab.id && !composingNew
                    ? 'bg-selected text-primary'
                    : 'text-text-secondary hover:bg-surface hover:text-text-primary',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )
      )}

      {/* Scheduled emails folder */}
      {selectedFolder === 'scheduled' ? (
        <ScheduledEmailList />
      ) : selectedFolder === 'needs_response' ? (
        <NeedsResponseList />
      ) : /* Thread list */
      isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
        </div>
      ) : isError ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
            <X className="h-6 w-6 text-red-400" />
          </div>
          <p className="mt-3 text-sm font-medium text-text-primary">Failed to load threads</p>
          <p className="mt-1 text-xs text-text-tertiary">Check your connection and try again</p>
          <button
            onClick={() => refetch()}
            className="mt-3 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      ) : threads.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          {isSearching ? (
            <>
              <Search className="h-8 w-8 text-text-tertiary" />
              <p className="mt-3 text-sm font-medium text-text-primary">No results found</p>
              <p className="mt-1 text-xs text-text-tertiary">
                No threads match &ldquo;{debouncedSearch}&rdquo;
              </p>
            </>
          ) : (
            <>
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-50">
                <Check className="h-6 w-6 text-green-500" />
              </div>
              <p className="mt-3 text-sm font-medium text-text-primary">You're all caught up</p>
              <p className="mt-1 text-xs text-text-tertiary">
                {threadListFilter === 'all'
                  ? 'No emails yet. Connect an account to get started.'
                  : `No ${threadListFilter} emails.`}
              </p>
            </>
          )}
        </div>
      ) : isMobile ? (
          /* Mobile: plain scroll container with pull-to-refresh */
          <div className="relative min-h-0 flex-1">
            {/* Pull-to-refresh indicator */}
            {(pullDistance > 0 || isRefreshing) && (
              <div
                className="absolute inset-x-0 top-0 z-20 flex items-center justify-center"
                style={{ height: isRefreshing ? 40 : pullDistance }}
              >
                <RefreshCw
                  className={cn(
                    'h-5 w-5 text-text-tertiary transition-transform',
                    isRefreshing && 'animate-spin',
                  )}
                  style={{ transform: isRefreshing ? undefined : `rotate(${Math.min(pullDistance / 80, 1) * 360}deg)` }}
                />
              </div>
            )}
            <div
              ref={(el) => {
                // Wire up both refs
                (pullToRefreshRef as any).current = el;
                scrollContainerRef.current = el;
              }}
              data-scroll-to-top
              className="h-full overflow-y-auto"
              style={{ transform: pullDistance > 0 || isRefreshing ? `translateY(${isRefreshing ? 40 : pullDistance}px)` : undefined }}
            >
              {dateGroups.map((group) => (
                <div
                  key={group.label}
                  ref={(el) => {
                    if (el) dateGroupRefs.current.set(group.label, el);
                  }}
                >
                  <div className="sticky top-0 z-10 border-b border-border/50 bg-surface/90 px-4 py-1.5 backdrop-blur-sm">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                      {group.label}
                    </span>
                  </div>
                  {group.items.map((thread: any) => (
                    <ThreadItem
                      key={thread.id}
                      thread={thread}
                      isSelected={selectedThreadId === thread.id}
                      isMultiSelected={selectedThreadIds.has(thread.id)}
                      onSelect={handleThreadSelect}
                      onShiftClick={(id) => selectThreadRange(id, allThreadIds)}
                      onCtrlClick={toggleThreadSelection}
                      accountColor={accountColorMap.get(thread.accountId)}
                    />
                  ))}
                </div>
              ))}
              {hasNextPage ? (
                <div
                  ref={lastThreadRef}
                  className="flex items-center justify-center gap-2 py-4"
                >
                  <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
                  <span className="text-xs text-text-tertiary">Loading more…</span>
                </div>
              ) : threads.length > 50 ? (
                <div className="py-3 text-center text-xs text-text-tertiary">
                  {totalCount} threads
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          /* Desktop: Radix ScrollArea with styled scrollbar */
          <ScrollArea.Root className="min-h-0 flex-1">
            <ScrollArea.Viewport className="h-full w-full">
              {dateGroups.map((group) => (
                <div key={group.label}>
                  <div className="sticky top-0 z-10 border-b border-border/50 bg-surface/90 px-4 py-1.5 backdrop-blur-sm">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                      {group.label}
                    </span>
                  </div>
                  {group.items.map((thread: any) => (
                    <ThreadItem
                      key={thread.id}
                      thread={thread}
                      isSelected={selectedThreadId === thread.id}
                      isMultiSelected={selectedThreadIds.has(thread.id)}
                      onSelect={handleThreadSelect}
                      onShiftClick={(id) => selectThreadRange(id, allThreadIds)}
                      onCtrlClick={toggleThreadSelection}
                      accountColor={accountColorMap.get(thread.accountId)}
                    />
                  ))}
                </div>
              ))}
              {hasNextPage ? (
                <div
                  ref={lastThreadRef}
                  className="flex items-center justify-center gap-2 py-4"
                >
                  <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
                  <span className="text-xs text-text-tertiary">Loading more…</span>
                </div>
              ) : threads.length > 50 ? (
                <div className="py-3 text-center text-xs text-text-tertiary">
                  {totalCount} threads
                </div>
              ) : null}
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar
              orientation="vertical"
              className="flex w-2 touch-none select-none p-0.5 transition-colors"
            >
              <ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>
        )}

      {/* Bulk action toolbar — anchored by both edges of the thread-list
          column so the pill always fits, no matter how narrow the column is
          resized. `inset-x-2` gives 8px margins each side; flex justify-center
          centres the pill, max-width caps its intrinsic size. */}
      {selectionCount > 0 && (
        <div className={cn('pointer-events-none absolute inset-x-2 z-30 flex justify-center animate-bounce-in', isMobile ? 'bottom-20' : 'bottom-4')}>
          <div className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-full bg-primary px-1.5 py-1 shadow-lg shadow-primary/25">
            <button
              onClick={clearSelection}
              className="rounded-full p-1 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title={`Clear selection (${selectionCount})`}
              aria-label={`Clear selection (${selectionCount})`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            {/* Selection count chip — tabular nums keeps widths stable. */}
            <span
              className="rounded-full bg-white/20 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white"
              aria-label={`${selectionCount} selected`}
            >
              {selectionCount}
            </span>
            <button
              onClick={handleBulkArchive}
              className="rounded-full p-1 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Archive"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleBulkStar}
              className="rounded-full p-1 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Star"
            >
              <Star className="h-3.5 w-3.5" />
            </button>
            {/* Single read/unread toggle — infers from selection so the user
                only ever sees the action that matters next. */}
            <button
              onClick={selectedThreadsRead ? handleBulkMarkUnread : handleBulkMarkRead}
              className="rounded-full p-1 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title={selectedThreadsRead ? 'Mark as unread' : 'Mark as read'}
              aria-label={selectedThreadsRead ? 'Mark as unread' : 'Mark as read'}
            >
              {selectedThreadsRead ? (
                <MailOpen className="h-3.5 w-3.5" />
              ) : (
                <Mail className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              onClick={handleBulkMoveToInbox}
              className="rounded-full p-1 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Move to inbox"
            >
              <Inbox className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleBulkDelete}
              className="rounded-full p-1 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
