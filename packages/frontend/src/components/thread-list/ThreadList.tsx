import { ClientsList } from "../clients/ClientsList";
import { useState, useMemo, useRef, useCallback, useEffect, type UIEvent } from 'react';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { AnimatePresence, motion } from 'framer-motion';
import { Search, Check, Plus, X, Archive, Star, Trash2, Loader2, Mail, MailOpen, MailSearch, User, Inbox, Calendar, Paperclip, Tag, RefreshCw } from 'lucide-react';
import { useThreads, useUpdateThread, usePrefetchAdjacentThreads, useIdleThreadPrefetch, useThreadHoverPrefetch } from '../../hooks/useThreads';
import { useMailboxSearch } from '../../hooks/useMailboxSearch';
import { quoteSearchValue, parseSearchOperators } from '../../../../../packages/shared/src/search';
import { useAccounts } from '../../hooks/useAccounts';
import { useInstantContactSearch } from '../../lib/contactDirectory';
import { useAnyHistoricalSyncInProgress } from '../../hooks/useHistoricalSync';
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
import { NeedsResponseList } from './NeedsResponseList';

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
  const { selectedAccountId, selectedThreadId, selectedFolder, threadListFilter, setSelectedThread, setThreadListFilter, composingNew, setComposingNew, selectedThreadIds, toggleThreadSelection, selectThreadRange, clearSelection, inboxFilterMode, contactSearchEmail, setContactSearchEmail, teamViewUserId } =
    useUiStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchPills, setSearchPills] = useState<{ operator: string; value: string; display?: string }[]>([]);
  const [activeOperator, setActiveOperator] = useState<string | null>(null); // operator being filled in (e.g. "from:")
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const isMobile = useIsMobile();
  const selectedSuggestionRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Contact suggestions from the in-memory directory — instant (<1ms), zero
  // server reads per keystroke. Flattened to the {email,name,emailCount}
  // shape this dropdown has always rendered.
  const { data: autocompleteData } = useInstantContactSearch(searchQuery);
  const suggestions = (autocompleteData?.data ?? []).map((g: any) => ({
    id: g.id,
    email: g.primaryEmail,
    name: g.displayName,
    company: null,
    emailCount: g.totalEmailCount,
  })).filter((c: any) => !!c.email);

  // Suggestions are visible as long as there's input, matches exist, and user hasn't dismissed
  const showSuggestions = !teamViewUserId && (!activeOperator || ['from:', 'to:', 'cc:', 'with:'].includes(activeOperator)) && searchQuery.length >= 1 && suggestions.length > 0 && !suggestionsDismissed;

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
  }, [searchQuery]);

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
    const parts = searchPills.map((p) => p.operator ? `${p.operator}${quoteSearchValue(p.value)}` : p.value);
    if (searchQuery.trim()) parts.push(activeOperator ? `${activeOperator}${quoteSearchValue(searchQuery.trim())}` : searchQuery.trim());
    return parts.join(' ');
  }, [searchPills, searchQuery, activeOperator]);

  // Debounce deep (server) search by 250ms — people suggestions above are
  // instant, so this delay only gates the full-mailbox query. A lone
  // character never hits the server: "B" would search every subject/body
  // in the mailbox for nothing useful; wait for "Be".
  useEffect(() => {
    const full = buildSearchString();
    const freeText = searchQuery.trim();
    const tooShort = searchPills.length === 0 && freeText.length > 0 && freeText.length < 2;
    const timer = setTimeout(() => setDebouncedSearch(tooShort ? '' : full), 250);
    return () => clearTimeout(timer);
  }, [searchQuery, searchPills, buildSearchString]);

  // Closing the search bar means SHOW EVERYTHING — one rule, every path.
  // (An earlier leak: a hidden from:-filter could outlive the closed bar.)
  useEffect(() => {
    if (!searchOpen) {
      setSearchQuery('');
      setDebouncedSearch('');
      setSearchPills([]);
      setActiveOperator(null);
    }
  }, [searchOpen]);

  // Clear search when folder changes
  useEffect(() => {
    setSearchQuery('');
    setDebouncedSearch('');
    setSearchPills([]);
    setActiveOperator(null);
  }, [selectedFolder]);

  // Pick up contact search from contacts page navigation
  useEffect(() => {
    if (contactSearchEmail) {
      setSearchQuery('');
      setSearchPills([{ operator: 'with:', value: contactSearchEmail }]);
      setDebouncedSearch(`with:${quoteSearchValue(contactSearchEmail)}`);
      setSearchOpen(true);
      setSuggestionsDismissed(true);
      setContactSearchEmail(null);
    }
  }, [contactSearchEmail, setContactSearchEmail]);

  const isSearching = debouncedSearch.length > 0 || searchPills.length > 0 || searchQuery.trim().length >= 2;
  const isDebouncingSearch = isSearching && buildSearchString() !== debouncedSearch;

  const selectSuggestion = (contact: typeof suggestions[number]) => {
    selectedSuggestionRef.current = true;
    const operator = activeOperator && ['from:', 'to:', 'cc:', 'with:'].includes(activeOperator) ? activeOperator : 'with:';
    setSearchPills(prev => [...prev.filter(p => p.operator !== operator), { operator, value: contact.email, display: contact.name || contact.email }]);
    setSearchQuery('');
    setActiveOperator(null);
    setSuggestionsDismissed(true);
    searchInputRef.current?.focus();
  };

  const clientsView = useUiStore(s => s.clientsView);
  const setClientsView = useUiStore(s => s.setClientsView);
  const showingClients = clientsView && !teamViewUserId && selectedFolder === 'inbox' && !isSearching;
  const clientsOpened = useRef(false);
  if (showingClients) clientsOpened.current = true;

  const providerSearch = useMailboxSearch(debouncedSearch, (selectedAccountId ?? undefined) as Id<'mailAccounts'> | undefined, !teamViewUserId);
  const localSearch = useThreads({
    enabled: !showingClients && (!isSearching || !!teamViewUserId || providerSearch.partial),
    accountId: teamViewUserId ? undefined : ((selectedAccountId ?? undefined) as Id<'mailAccounts'> | undefined),
    folder: isSearching ? undefined : (selectedFolder !== 'dashboard' ? selectedFolder : 'inbox'),
    search: debouncedSearch || undefined,
    viewAsUserId: (teamViewUserId ?? undefined) as Id<'users'> | undefined,
  });
  const searchResults = isSearching && !teamViewUserId ? providerSearch : localSearch;
  const { data, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = searchResults;
  const isLoading = searchResults.isLoading || isDebouncingSearch;
  const { data: accountsData } = useAccounts();
  const updateThread = useUpdateThread();
  const prefetchThread = useThreadHoverPrefetch();
  const markThreadNotificationsRead = useMarkThreadNotificationsRead();
  const importStatus = useAnyHistoricalSyncInProgress();

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
  if (isSearching && !teamViewUserId && providerSearch.partial) {
    const merged = new Map(threads.map((t: any) => [t.id, t]));
    for (const page of localSearch.data?.pages ?? []) for (const thread of page.data) if (!merged.has(thread.id)) merged.set(thread.id, thread);
    threads = [...merged.values()].sort((a, b) => (b.lastReceivedAt ?? b.lastMessageAt) - (a.lastReceivedAt ?? a.lastMessageAt));
  }
  const totalCount = data?.pages[0]?.total ?? 0;

  // Client-side filtering + date grouping, memoized — these rebuilt on every
  // render (each keystroke in the search box recomputed the whole grouped
  // layout for hundreds of threads).
  const filteredThreads = useMemo(() => {
    if (isSearching) return threads;
    if (threadListFilter === 'unread') return threads.filter((t: any) => !t.isRead);
    if (threadListFilter === 'starred') return threads.filter((t: any) => t.isStarred);
    return threads;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, threadListFilter, isSearching]);
  threads = filteredThreads;

  const dateGroups = useMemo(
    () =>
      groupByDate(
        !isSearching && selectedFolder === 'sent'
          ? threads.map((t: any) => ({
              ...t,
              // Sent groups/sorts by when YOU last sent.
              lastReceivedAt: t.lastSentAt ?? t.lastMessageAt,
            }))
          : threads,
      ),
    [threads, selectedFolder, isSearching],
  );
  const allThreadIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of dateGroups) {
      for (const thread of group.items) {
        ids.push((thread as any).id);
      }
    }
    return ids;
  }, [dateGroups]);

  // Publish the rendered order so removal actions (delete/archive/snooze)
  // can advance selection to the next visible thread.
  const setVisibleThreadIds = useUiStore((s) => s.setVisibleThreadIds);
  useEffect(() => {
    if (!showingClients) setVisibleThreadIds(allThreadIds);
  }, [allThreadIds, setVisibleThreadIds, showingClients]);

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
  }, [selectedFolder, selectedAccountId, threadListFilter, debouncedSearch]);

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

  // Sticky date heading for the virtualized desktop list. Header rows are
  // ordinary virtual rows, so CSS `position: sticky` can't pin them (the
  // mobile list gets that for free). Instead: derive the group the viewport
  // is currently inside from scrollTop and render one pinned copy of its
  // label above the rows. It hands over to the next group's label the moment
  // that group's own header scrolls under it (Bryce 2026-09-07).
  const desktopStickyLabel = useMemo(() => {
    let label: string | null = null;
    for (const row of desktopRowPositions) {
      if (row.type !== 'header') continue;
      if (row.start <= desktopScrollTop + 1) label = row.label;
      else break;
    }
    return label;
  }, [desktopRowPositions, desktopScrollTop]);

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
  const [, setVisibleDateGroup] = useState<string | null>(null);
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
          </div>
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
              aria-label="Open search"
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
                className="relative flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface/50 px-2.5 backdrop-blur-sm focus-within:border-primary focus-within:bg-white focus-within:ring-1 focus-within:ring-primary"
              >
                <Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                {/* Committed operator pills */}
                {searchPills.map((pill, i) => (
                  <span
                    key={`${pill.operator}-${i}`}
                    className="flex shrink-0 items-center gap-0.5 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
                  >
                    <span className="text-primary/60">{pill.operator}</span>
                    <button type="button" title={pill.value} onClick={() => { setSearchPills(prev => prev.filter((_, j) => j !== i)); setActiveOperator(pill.operator); setSearchQuery(pill.value); searchInputRef.current?.focus(); }} className="max-w-[180px] truncate">{pill.display || pill.value}</button>
                    <button
                      type="button"
                      onClick={() => {
                        setSearchPills((prev) => prev.filter((_, j) => j !== i));
                        searchInputRef.current?.focus();
                      }}
                      aria-label={`Remove ${pill.operator} ${pill.display || pill.value}`}
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
                      setSearchQuery(val);
                      return;
                    }
                    // Detect if user manually typed an operator prefix
                    const operatorMatch = val.match(/^(from:|to:|cc:|with:|subject:|before:|after:|has:|is:|label:)(\S*)\s?$/);
                    if (operatorMatch) {
                      const [, op, value] = operatorMatch;
                      if (!value) {
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
                    if (e.key === 'Enter' && activeOperator && searchQuery.trim() && suggestionIndex < 0) {
                      e.preventDefault();
                      const value = searchQuery.trim();
                      setSearchPills((prev) => [
                        ...prev.filter((p) => p.operator !== activeOperator || (activeOperator === 'is:' && p.value !== value && (p.value === 'starred' || value === 'starred'))),
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
                        setSearchPills([]);
                        setActiveOperator(null);
                        setSearchOpen(false);
                      }
                      return;
                    }
                    if (showSuggestions && suggestions.length > 0) {
                      const totalItems = suggestions.length;
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setSuggestionIndex((i) => Math.min(i + 1, totalItems - 1));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setSuggestionIndex((i) => Math.max(i - 1, -1));
                      } else if (e.key === 'Enter') {
                        if (suggestionIndex >= 0) {
                          e.preventDefault();
                          selectSuggestion(suggestions[suggestionIndex]);
                          return;
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
                  placeholder={activeOperator ? (['before:', 'after:'].includes(activeOperator) ? 'YYYY-MM-DD' : 'Name or value · Enter to apply') : searchPills.length > 0 ? 'Add words…' : 'Search people or anything in your mail…'}
                  aria-label="Search mail"
                  role="combobox"
                  aria-expanded={showSuggestions}
                  aria-controls={showSuggestions ? 'mail-search-people' : undefined}
                  aria-activedescendant={showSuggestions && suggestionIndex >= 0 ? `mail-search-person-${suggestionIndex}` : undefined}
                  autoComplete="off"
                  className={cn(
                    'flex-1 bg-transparent py-1.5 pr-2 text-xs text-text-primary outline-none placeholder:text-text-tertiary',
                    activeOperator ? 'min-w-[80px] rounded-l-none -ml-1 bg-primary/5 pl-1' : searchPills.length > 0 ? 'min-w-[20px]' : 'min-w-[80px]',
                  )}
                />
                {isSearching && (isDebouncingSearch || providerSearch.isFetching) && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-text-tertiary" />
                )}
                <motion.button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setDebouncedSearch('');
                    setSearchPills([]);
                    setActiveOperator(null);
                    setSearchOpen(false);
                  }}
                  aria-label="Close search"
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

              {showSuggestions ? (
                <div ref={suggestionsRef} id="mail-search-people" role="listbox" aria-label="People" className="absolute left-3 right-3 top-full z-50 mt-1 overflow-hidden rounded-xl border border-border bg-white py-1 shadow-lg">
                  <div className="px-3 py-2 text-[10px] font-medium text-text-tertiary">{activeOperator === 'from:' ? 'Mail from' : activeOperator === 'to:' ? 'Mail sent to' : activeOperator === 'cc:' ? 'Copied on mail' : 'Mail involving'} a person</div>
                  {suggestions.map((contact, index) => (
                    <button key={contact.id} id={`mail-search-person-${index}`} role="option" aria-selected={index === suggestionIndex} onMouseDown={e => e.preventDefault()} onClick={() => selectSuggestion(contact)} className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors', index === suggestionIndex ? 'bg-selected' : 'hover:bg-surface')}>
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><User className="h-3.5 w-3.5" /></span>
                      <span className="min-w-0"><span className="block truncate text-xs font-medium text-text-primary">{contact.name || contact.email}</span><span className="block truncate text-[11px] text-text-tertiary">{contact.email}</span></span>
                    </button>
                  ))}
                  <div className="border-t border-border px-3 py-2 text-[10px] text-text-tertiary">Press Enter to search your words · ↓ to choose a person</div>
                </div>
              ) : null}
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[10px] text-text-tertiary">{activeOperator ? 'Spaces are welcome. Enter applies the filter.' : 'Names, recipients, subjects and message text'}</span>
                <button type="button" onClick={() => setShowFilters(v => !v)} aria-expanded={showFilters} className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/5">{showFilters ? 'Hide filters' : '+ Filters'}</button>
              </div>
              {showFilters && (
                <div className="mt-2 rounded-xl border border-border/70 bg-white/70 p-2 shadow-sm">
                  <div className="mb-1.5 flex items-center justify-between px-0.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">Refine search</span>
                    <span className="text-[10px] text-text-tertiary">Pick a field, then type</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {[
                      { label: 'with:', hint: 'any participant', icon: User, needsValue: true, tone: 'bg-blue-50 text-blue-700 hover:bg-blue-100' },
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
                        p.operator === (op.operator ?? op.label) && (!op.value || p.value === op.value),
                      );
                      if (alreadyActive) return null;
                      return (
                        <button
                          key={op.label}
                          type="button"
                          onClick={() => {
                            if (op.needsValue) {
                              if (searchQuery.trim()) setSearchPills(prev => [...prev, { operator: '', value: searchQuery.trim() }]);
                              setActiveOperator(op.label);
                              setShowFilters(false);
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

      {/* Filter tabs — only render when there's actually something to show */}
      {!isMobile && isSearching && (
        <div className="flex items-center border-b border-border px-3 py-2">
          <span className="text-xs text-text-tertiary">{providerSearch.isFetching || isDebouncingSearch ? 'Searching your mailbox…' : `${threads.length}${hasNextPage ? '+' : ''} conversation${threads.length === 1 ? '' : 's'}`} · {selectedAccountId && !teamViewUserId ? 'This account' : 'All accounts'}</span>
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

      {isSearching && !teamViewUserId && (providerSearch.partial || providerSearch.capped) && (
        <div role="status" className="flex items-center justify-between gap-2 border-b border-border bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          <span>{providerSearch.capped ? 'Showing 2,000 matches. Add a person or date to narrow your search.' : 'Mailbox search is incomplete. Showing available matches.'}</span>
          {providerSearch.partial && <button type="button" onClick={() => void providerSearch.refetch()} className="shrink-0 font-semibold underline">Retry</button>}
        </div>
      )}

      {!isSearching && !teamViewUserId && selectedFolder === 'inbox' && <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <button aria-pressed={!clientsView} onClick={() => setClientsView(false)} className={cn('rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors', !clientsView ? 'bg-white text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-primary')}>Today</button>
        <button role="switch" aria-checked={clientsView} onClick={() => setClientsView(!clientsView)} className={cn('flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors', clientsView ? 'bg-primary/10 text-primary' : 'text-text-secondary hover:bg-white')}><span className={cn('flex h-3.5 w-6 items-center rounded-full p-0.5 transition-colors', clientsView ? 'bg-primary' : 'bg-gray-300')}><span className={cn('h-2.5 w-2.5 rounded-full bg-white transition-transform', clientsView && 'translate-x-2.5')} /></span>Clients</button>
      </div>}

      {/* Scheduled emails folder */}
      {clientsOpened.current && <div className={showingClients ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <ClientsList key={selectedAccountId ?? 'all'} active={showingClients} />
      </div>}
      {showingClients ? null : !isSearching && selectedFolder === 'scheduled' ? (
        <ScheduledEmailList />
      ) : !isSearching && selectedFolder === 'needs_response' ? (
        <NeedsResponseList />
      ) : /* Thread list */
      isLoading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
          {isSearching && (
            <p className="text-xs text-text-tertiary">Searching your mailbox…</p>
          )}
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
              <p className="mt-3 text-sm font-medium text-text-primary">{providerSearch.partial ? 'Search incomplete' : hasNextPage ? 'No matches on this page' : 'No results found'}</p>
              <p className="mt-1 text-xs text-text-tertiary">
                {providerSearch.partial ? 'Some accounts could not be searched. Results may be incomplete.' : `No conversations match “${debouncedSearch}”.`}
              </p>
              {hasNextPage && <button type="button" onClick={() => void fetchNextPage()} className="mt-3 text-xs font-medium text-primary">Keep searching older mail</button>}
              {parseSearchOperators(debouncedSearch).from && <button type="button" onClick={() => { const person = parseSearchOperators(debouncedSearch).from!; setSearchPills([]); setActiveOperator(null); setSearchQuery(person); }} className="mt-3 text-xs font-medium text-primary">Search this person anywhere</button>}
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
          /* Desktop: virtualized scroll container */
          <div
            ref={desktopViewportRef}
            data-scroll-to-top
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={handleDesktopScroll}
          >
            {desktopStickyLabel && (
              <div className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible">
                <div className="bg-surface px-5 pb-1 pt-3">
                  <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
                    {desktopStickyLabel}
                  </span>
                </div>
              </div>
            )}
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
                  ref={lastThreadRef}
                  className="absolute left-0 right-0 flex items-center justify-center gap-2 py-3"
                  style={{ transform: `translateY(${desktopTotalHeight}px)` }}
                >
                  <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
                  <span className="text-xs text-text-tertiary">Loading more…</span>
                </div>
              )}
              {!isFetchingNextPage && hasNextPage && (
                <div
                  ref={lastThreadRef}
                  className="absolute left-0 right-0 h-1"
                  style={{ transform: `translateY(${desktopTotalHeight}px)` }}
                />
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
