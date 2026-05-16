import { useState, useMemo, useRef, useCallback, useEffect, type UIEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Search, Check, Plus, X, Archive, Star, Trash2, Loader2, Mail, MailOpen, MailSearch, User, Inbox, Calendar, Paperclip, Tag, RefreshCw } from 'lucide-react';
import { useThreads, useUpdateThread, usePrefetchAdjacentThreads, useIdleThreadPrefetch, useThreadHoverPrefetch } from '../../hooks/useThreads';
import { useAccounts } from '../../hooks/useAccounts';
import { useContactAutocomplete } from '../../hooks/useContacts';
import { useInboxSplits } from '../../hooks/useInboxSplits';
import { useUiStore } from '../../stores/uiStore';
import { cn, groupByDate } from '../../lib/utils';
import { getAccountColor } from '../../lib/constants';
import { useIsMobile } from '../../hooks/useIsMobile';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { NavigationDropdown } from '../navigation/NavigationDropdown';
import { ThreadItem } from './ThreadItem';
import { ScheduledEmailList } from '../scheduled/ScheduledEmailList';
import { setVisibleThreadNavigationRows } from '../../lib/threadNavigationState';
import { useMarkThreadNotificationsRead } from '../../hooks/useNotifications';

const FILTER_TABS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'starred', label: 'Starred' },
] as const;

// Absolute-positioned virtualized row that reports its own height up to the
// list. This lets rows with multiple classification pills, snoozed pills,
// drafts, etc. grow naturally without overlapping the next row.
function MeasuredRow({
  rowKey,
  start,
  onMeasure,
  children,
}: {
  rowKey: string;
  start: number;
  onMeasure: (key: string, height: number) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    onMeasure(rowKey, el.offsetHeight);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Use borderBoxSize when available, fall back to contentRect.
      const box = entry.borderBoxSize?.[0];
      const height = box ? box.blockSize : entry.contentRect.height;
      onMeasure(rowKey, height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowKey, onMeasure]);
  return (
    <div
      ref={ref}
      className="absolute left-0 right-0"
      style={{ transform: `translateY(${start}px)` }}
    >
      {children}
    </div>
  );
}

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
    const operator = activeOperator && ['from:', 'to:', 'cc:'].includes(activeOperator)
      ? activeOperator
      : 'from:';
    setSearchPills((prev) => {
      const without = prev.filter((p) => p.operator !== operator);
      return [...without, { operator, value: displayValue }];
    });
    setSearchQuery('');
    setSearchFrom(operator === 'from:' ? contact.email : undefined);
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
  const prefetchThread = useThreadHoverPrefetch();
  const markThreadNotificationsRead = useMarkThreadNotificationsRead();

  // Infinite scroll: observe last element
  const observer = useRef<IntersectionObserver | null>(null);
  const lastThreadRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (isFetchingNextPage) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting && hasNextPage) {
            fetchNextPage();
          }
        },
        // Start fetching the next page ~3 screens before the user actually
        // reaches the bottom so loading feels instant.
        { rootMargin: '1500px 0px 1500px 0px' },
      );
      if (node) observer.current.observe(node);
    },
    [isFetchingNextPage, hasNextPage, fetchNextPage],
  );

  // Build accountId → color map
  const accountColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const accounts = accountsData?.data ?? [];
    accounts.forEach((acc: any, i: number) => {
      map.set(acc.id, getAccountColor(i));
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

  // Spark-style adjacency prefetch: as soon as a thread is selected, warm
  // the Convex cache for the previous and next thread so j/k navigation
  // and clicks on neighbours render synchronously.
  const { prevAdjacentId, nextAdjacentId, next2Id, next3Id } = useMemo(() => {
    if (!selectedThreadId)
      return { prevAdjacentId: null, nextAdjacentId: null, next2Id: null, next3Id: null };
    const idx = allThreadIds.indexOf(selectedThreadId);
    if (idx === -1)
      return { prevAdjacentId: null, nextAdjacentId: null, next2Id: null, next3Id: null };
    return {
      prevAdjacentId: idx > 0 ? allThreadIds[idx - 1] : null,
      nextAdjacentId: idx < allThreadIds.length - 1 ? allThreadIds[idx + 1] : null,
      next2Id: idx < allThreadIds.length - 2 ? allThreadIds[idx + 2] : null,
      next3Id: idx < allThreadIds.length - 3 ? allThreadIds[idx + 3] : null,
    };
  }, [selectedThreadId, allThreadIds]);
  usePrefetchAdjacentThreads(prevAdjacentId, nextAdjacentId, next2Id, next3Id);
  // Inbox-open warmup: kick off body prefetch for the top-of-inbox threads
  // during idle time. Makes the first several clicks (or `j` keypresses) feel instant.
  useIdleThreadPrefetch(allThreadIds, 8);

  useEffect(() => {
    setVisibleThreadNavigationRows(
      threads.map((thread: any) => ({ id: thread.id, isStarred: thread.isStarred })),
    );
  }, [threads]);

  // Per-row measured heights. Keys match the row's `key` so a row's measured
  // height survives across re-renders, virtualization unmount/remount, and
  // even ordering changes (we look up by stable key).
  const measuredHeights = useRef(new Map<string, number>());
  const [measureVersion, setMeasureVersion] = useState(0);
  const scheduleMeasureFlush = useRef<number | null>(null);
  const reportRowHeight = useCallback((key: string, height: number) => {
    const prev = measuredHeights.current.get(key);
    // Larger tolerance — ignore <2px jitter that would otherwise cause every
    // row to trigger a re-position pass on first paint. Avoids the visible
    // "settle" / glitch when switching filters or scrolling fast.
    if (prev !== undefined && Math.abs(prev - height) < 2) return;
    measuredHeights.current.set(key, height);
    if (scheduleMeasureFlush.current !== null) return;
    scheduleMeasureFlush.current = requestAnimationFrame(() => {
      scheduleMeasureFlush.current = null;
      setMeasureVersion((v) => v + 1);
    });
  }, []);
  useEffect(() => () => {
    if (scheduleMeasureFlush.current !== null) cancelAnimationFrame(scheduleMeasureFlush.current);
  }, []);

  const ESTIMATED_THREAD_ROW_HEIGHT = 72;
  const HEADER_ROW_HEIGHT = 29;

  const desktopRows = useMemo(() => {
    const rows: Array<
      | { type: 'header'; key: string; label: string; size: number }
      | { type: 'thread'; key: string; thread: any; size: number }
    > = [];
    for (const group of dateGroups) {
      const headerKey = `header-${group.label}`;
      rows.push({
        type: 'header',
        key: headerKey,
        label: group.label,
        size: measuredHeights.current.get(headerKey) ?? HEADER_ROW_HEIGHT,
      });
      for (const thread of group.items) {
        const t = thread as any;
        const key = `thread-${t.id}`;
        // Use the measured height when available so rows with multiple
        // classifications / multi-line wraps don't overlap. Falls back to a
        // sensible estimate that matches the most common (single-row) case.
        rows.push({
          type: 'thread',
          key,
          thread: t,
          size: measuredHeights.current.get(key) ?? ESTIMATED_THREAD_ROW_HEIGHT,
        });
      }
    }
    return rows;
    // measureVersion is intentionally part of the dep set
  }, [dateGroups, measureVersion]);

  // When the active filter / split / folder / account changes, reset scroll +
  // measurement state so the new list renders from the top instantly without
  // a visible "jump" as old row heights are reapplied to new threads.
  useEffect(() => {
    measuredHeights.current.clear();
    setDesktopScrollTop(0);
    const el = desktopViewportRef.current;
    if (el) el.scrollTop = 0;
  }, [activeSplitCategory, selectedFolder, selectedAccountId, threadListFilter, searchFrom, debouncedSearch]);

  const desktopRowPositions = useMemo(() => {
    let start = 0;
    return desktopRows.map((row) => {
      const positioned = { ...row, start, end: start + row.size };
      start += row.size;
      return positioned;
    });
  }, [desktopRows]);

  const desktopTotalHeight = desktopRowPositions.at(-1)?.end ?? 0;
  const desktopViewportRef = useRef<HTMLDivElement>(null);
  const [desktopScrollTop, setDesktopScrollTop] = useState(0);
  const [desktopViewportHeight, setDesktopViewportHeight] = useState(0);

  useEffect(() => {
    if (isMobile) return;
    const el = desktopViewportRef.current;
    if (!el) return;
    const updateHeight = () => setDesktopViewportHeight(el.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isMobile]);

  const desktopVisibleRows = useMemo(() => {
    // Generous overscan keeps adjacent rows mounted while the user reverses
    // scroll direction, eliminating the "blink" of rows remounting.
    const overscanPx = 1800;
    const min = Math.max(0, desktopScrollTop - overscanPx);
    const max = desktopScrollTop + desktopViewportHeight + overscanPx;
    return desktopRowPositions.filter((row) => row.end >= min && row.start <= max);
  }, [desktopRowPositions, desktopScrollTop, desktopViewportHeight]);

  const handleDesktopScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setDesktopScrollTop(el.scrollTop);
    // Eager prefetch: kick off the next page when we still have ~3 screens of
    // headroom. Combined with virtualization this hides network latency entirely
    // on normal-speed scrolls.
    const prefetchThreshold = Math.max(1500, el.clientHeight * 3);
    if (
      hasNextPage &&
      !isFetchingNextPage &&
      el.scrollHeight - (el.scrollTop + el.clientHeight) < prefetchThreshold
    ) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const selectionCount = selectedThreadIds.size;

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

  const handleThreadSelect = useCallback(
    (id: string) => {
      clearSelection();
      setSelectedThread(id);
      markThreadNotificationsRead(id).catch(console.error);
    },
    [clearSelection, setSelectedThread, markThreadNotificationsRead],
  );

  const allThreadIdsRef = useRef(allThreadIds);
  allThreadIdsRef.current = allThreadIds;
  const handleShiftClick = useCallback(
    (id: string) => selectThreadRange(id, allThreadIdsRef.current),
    [selectThreadRange],
  );

  return (
    <div className="relative flex h-full flex-col bg-surface">
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
        <div className="flex h-[78px] items-center gap-2 border-b border-border px-3 pt-[32px]">
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
                    const operatorMatch = val.match(/^(from:|to:|cc:|before:|after:|has:|is:|label:)(\S*)\s?$/);
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
                  placeholder={activeOperator ? `Type ${activeOperator.replace(':', '')} value...` : searchPills.length > 0 ? '' : 'Search sender, subject, body…'}
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
                <div className="mt-2 rounded-xl border border-border/70 bg-white/70 p-2 shadow-sm">
                  <div className="mb-1.5 flex items-center justify-between px-0.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">Refine search</span>
                    <span className="text-[10px] text-text-tertiary">Pick a field, then type</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {[
                      { label: 'from:', hint: 'sender', icon: User, needsValue: true, tone: 'bg-blue-50 text-blue-700 hover:bg-blue-100' },
                      { label: 'to:', hint: 'recipient', icon: Mail, needsValue: true, tone: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' },
                      { label: 'cc:', hint: 'copied', icon: MailSearch, needsValue: true, tone: 'bg-amber-50 text-amber-700 hover:bg-amber-100' },
                      { label: 'before:', hint: 'before date', icon: Calendar, needsValue: true, tone: 'bg-surface text-text-tertiary hover:bg-border hover:text-text-secondary' },
                      { label: 'after:', hint: 'after date', icon: Calendar, needsValue: true, tone: 'bg-surface text-text-tertiary hover:bg-border hover:text-text-secondary' },
                      { label: 'has:attachment', hint: 'files', icon: Paperclip, operator: 'has:', value: 'attachment', tone: 'bg-surface text-text-tertiary hover:bg-border hover:text-text-secondary' },
                      { label: 'is:unread', hint: 'unread', icon: MailOpen, operator: 'is:', value: 'unread', tone: 'bg-surface text-text-tertiary hover:bg-border hover:text-text-secondary' },
                      { label: 'is:starred', hint: 'starred', icon: Star, operator: 'is:', value: 'starred', tone: 'bg-surface text-text-tertiary hover:bg-border hover:text-text-secondary' },
                      { label: 'label:', hint: 'label', icon: Tag, needsValue: true, tone: 'bg-surface text-text-tertiary hover:bg-border hover:text-text-secondary' },
                    ].map((op) => {
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
                              setActiveOperator(op.label);
                              setSearchQuery('');
                              searchInputRef.current?.focus();
                            } else {
                              setSearchPills((prev) => [...prev, { operator: op.operator!, value: op.value! }]);
                              searchInputRef.current?.focus();
                            }
                          }}
                          className={cn('flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[10px] font-medium transition-colors', op.tone)}
                        >
                          <op.icon className="h-3 w-3 shrink-0" />
                          <span className="min-w-0">
                            <span className="block truncate leading-none">{op.label}</span>
                            <span className="mt-0.5 block truncate text-[9px] font-normal opacity-65">{op.hint}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
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

      {/* Filter tabs — only render when there's actually something to show */}
      {!isMobile && isSearching && (
        <div className="flex items-center border-b border-border px-3 py-2">
          <span className="text-xs text-text-tertiary">Searching all mail</span>
        </div>
      )}
      {!isMobile && !isSearching && inboxFilterMode === 'standard' && (
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          {FILTER_TABS.map((tab) => (
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
      )}

      {/* Scheduled emails folder */}
      {selectedFolder === 'scheduled' ? (
        <ScheduledEmailList />
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
                  <div className="sticky top-0 z-10 bg-surface px-5 pb-1 pt-3">
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
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
                      onShiftClick={handleShiftClick}
                      onCtrlClick={toggleThreadSelection}
                      accountColor={accountColorMap.get(thread.accountId)}
                      onPrefetch={prefetchThread}
                    />
                  ))}
                </div>
              ))}
              <div ref={lastThreadRef} className="h-1" />
              {isFetchingNextPage && (
                <div className="flex items-center justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
                  <span className="ml-2 text-xs text-text-tertiary">Loading more...</span>
                </div>
              )}
              {!hasNextPage && threads.length > 50 && (
                <div className="py-3 text-center text-xs text-text-tertiary">
                  {totalCount} threads
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Desktop: virtualized scroll container */
          <div
            ref={desktopViewportRef}
            data-scroll-to-top
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={handleDesktopScroll}
          >
            <div
              className="relative w-full"
              style={{
                height: desktopTotalHeight + (isFetchingNextPage || (!hasNextPage && threads.length > 50) ? 44 : 1),
              }}
            >
              {desktopVisibleRows.map((row) => (
                <MeasuredRow
                  key={row.key}
                  rowKey={row.key}
                  start={row.start}
                  onMeasure={reportRowHeight}
                >
                  {row.type === 'header' ? (
                    <div className="bg-surface px-5 pb-1 pt-3">
                      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
                        {row.label}
                      </span>
                    </div>
                  ) : (
                    <ThreadItem
                      thread={row.thread}
                      isSelected={selectedThreadId === row.thread.id}
                      isMultiSelected={selectedThreadIds.has(row.thread.id)}
                      onSelect={handleThreadSelect}
                      onShiftClick={handleShiftClick}
                      onCtrlClick={toggleThreadSelection}
                      accountColor={accountColorMap.get(row.thread.accountId)}
                      onPrefetch={prefetchThread}
                    />
                  )}
                </MeasuredRow>
              ))}
              {isFetchingNextPage && (
                <div
                  className="absolute left-0 right-0 flex items-center justify-center py-3"
                  style={{ transform: `translateY(${desktopTotalHeight}px)` }}
                >
                  <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
                  <span className="ml-2 text-xs text-text-tertiary">Loading more...</span>
                </div>
              )}
              {!hasNextPage && threads.length > 50 && (
                <div
                  className="absolute left-0 right-0 py-3 text-center text-xs text-text-tertiary"
                  style={{ transform: `translateY(${desktopTotalHeight}px)` }}
                >
                  {totalCount} threads
                </div>
              )}
            </div>
          </div>
        )}

      {/* Bulk action toolbar */}
      {selectionCount > 0 && (
        <div className={cn('absolute left-1/2 z-30 animate-bounce-in', isMobile ? 'bottom-20' : 'bottom-4')}>
          <div className="flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 shadow-lg shadow-primary/25">
            <button
              onClick={clearSelection}
              className="rounded-full p-1 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Clear selection"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-[3ch] px-1.5 text-center text-xs font-semibold text-white">
              {selectionCount} {selectionCount === 1 ? 'thread' : 'threads'}
            </span>
            <div className="mx-1 h-4 w-px bg-white/20" />
            <button
              onClick={handleBulkArchive}
              className="rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Archive"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleBulkStar}
              className="rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Star"
            >
              <Star className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleBulkMarkRead}
              className="rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Mark as read"
            >
              <Mail className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleBulkMarkUnread}
              className="rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Mark as unread"
            >
              <MailOpen className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleBulkMoveToInbox}
              className="rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Move to inbox"
            >
              <Inbox className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleBulkDelete}
              className="rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
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
