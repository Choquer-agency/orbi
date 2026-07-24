// ─────────────────────────────────────────────────────────────────────────────
// contactDirectory.ts — in-memory contact index for instant autocomplete
// (2026-07-23 speed sprint: "when I type a letter I want it to start showing
// me names").
//
// The old flow round-tripped EVERY keystroke to a server query that read the
// whole contacts table (300-500ms per letter, plus database reads per letter).
// This module loads the compact directory ONCE per session (plus a slow
// background refresh), persists it to localStorage so relaunches are instant,
// and filters it in memory — first letter to visible names in <1ms, zero
// network, zero database cost per keystroke.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react';
import { convex } from './convex';
import { api as convexApi } from '@convex/_generated/api';

export interface DirectoryContact {
  email: string;
  name?: string;
  personId?: string;
  emailCount: number;
  lastEmailed: number;
}

// Person-grouped suggestion — same shape the recipient dropdowns already
// render (from the old persons.autocomplete), so the UI swap is drop-in.
export interface DirectorySuggestion {
  id: string;
  displayName: string | null;
  company: string | null;
  primaryEmail: string | null;
  totalEmailCount: number;
  contacts: { id: string; email: string; emailCount: number }[];
}

const STORAGE_KEY = 'orbi-contact-directory-v1';
const REFRESH_MS = 30 * 60 * 1000; // background refresh cadence

let entries: DirectoryContact[] = [];
let loadedFromStorage = false;
let fetchedAt = 0;
let fetching: Promise<void> | null = null;
const listeners = new Set<() => void>();

function loadFromStorage() {
  if (loadedFromStorage) return;
  loadedFromStorage = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { fetchedAt: number; entries: DirectoryContact[] };
      if (Array.isArray(parsed.entries)) {
        entries = parsed.entries;
        fetchedAt = parsed.fetchedAt ?? 0;
      }
    }
  } catch {
    /* corrupted cache — refetch will rebuild */
  }
}

async function fetchDirectory(): Promise<void> {
  if (fetching) return fetching;
  fetching = (async () => {
    try {
      const rows = (await convex.query(convexApi.contacts.directory, {})) as DirectoryContact[];
      if (Array.isArray(rows)) {
        entries = rows;
        fetchedAt = Date.now();
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt, entries }));
        } catch {
          /* quota — in-memory copy still works this session */
        }
        listeners.forEach((l) => l());
      }
    } catch (err) {
      console.error('[contactDirectory] refresh failed', err);
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

/** Call once on app start (and it self-refreshes). Safe to call repeatedly. */
export function ensureContactDirectory() {
  loadFromStorage();
  if (Date.now() - fetchedAt > REFRESH_MS) void fetchDirectory();
}

/** Force refresh (e.g., after sending to a brand-new address). */
export function refreshContactDirectory() {
  void fetchDirectory();
}

export function subscribeContactDirectory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Ranking ──────────────────────────────────────────────────────────────────
// Tiers: word-prefix match on name / email local-part (what people expect
// from "joh") beats substring-anywhere. Within a tier: most-emailed first
// ("your johnny beats alphabetical johnnies"), recency as tiebreak.

function matchTier(c: DirectoryContact, term: string): number {
  const t = term.toLowerCase();
  const email = c.email.toLowerCase();
  const local = email.split('@')[0];
  const name = (c.name ?? '').toLowerCase();
  if (local.startsWith(t) || name.startsWith(t)) return 0;
  if (name.split(/[\s.-]+/).some((w) => w.startsWith(t))) return 0;
  if (email.includes(t) || name.includes(t)) return 1;
  return -1;
}

export function searchContactDirectory(term: string, limit = 8): DirectorySuggestion[] {
  loadFromStorage();
  const q = term.trim().toLowerCase();
  if (!q) return [];

  type Scored = { c: DirectoryContact; tier: number };
  const scored: Scored[] = [];
  for (const c of entries) {
    const tier = matchTier(c, q);
    if (tier >= 0) scored.push({ c, tier });
  }

  // Group matched contacts by person (or solo by email).
  const groups = new Map<string, { key: string; name?: string; tier: number; contacts: DirectoryContact[] }>();
  for (const { c, tier } of scored) {
    const key = c.personId ?? `solo:${c.email.toLowerCase()}`;
    const g = groups.get(key);
    if (g) {
      g.contacts.push(c);
      g.tier = Math.min(g.tier, tier);
      if (!g.name && c.name) g.name = c.name;
    } else {
      groups.set(key, { key, name: c.name, tier, contacts: [c] });
    }
  }

  const result = [...groups.values()]
    .map((g) => {
      const contacts = [...g.contacts].sort(
        (a, b) => b.emailCount - a.emailCount || b.lastEmailed - a.lastEmailed,
      );
      return {
        group: g,
        total: contacts.reduce((s, c) => s + c.emailCount, 0),
        lastEmailed: Math.max(...contacts.map((c) => c.lastEmailed)),
        contacts,
      };
    })
    .sort(
      (a, b) =>
        a.group.tier - b.group.tier ||
        b.total - a.total ||
        b.lastEmailed - a.lastEmailed,
    )
    .slice(0, limit)
    .map(({ group, total, contacts }) => ({
      id: group.key,
      displayName: group.name ?? null,
      company: null,
      primaryEmail: contacts[0]?.email ?? null,
      totalEmailCount: total,
      contacts: contacts.map((c) => ({
        id: `${group.key}:${c.email}`,
        email: c.email,
        emailCount: c.emailCount,
      })),
    }));

  return result;
}

// React hook: instant, synchronous filter over the in-memory directory.
// Return shape mirrors the old server usePersonAutocomplete so dropdowns
// swap without UI changes.
export function useInstantContactSearch(term: string): {
  data: { data: DirectorySuggestion[] } | undefined;
} {
  // Re-render when a background refresh lands.
  useSyncExternalStore(subscribeContactDirectory, () => fetchedAt);
  ensureContactDirectory();
  const q = term.trim();
  if (!q) return { data: { data: [] } };
  return { data: { data: searchContactDirectory(q) } };
}
