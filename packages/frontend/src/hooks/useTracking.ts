// Open/click tracking metadata for sent emails. Backed by
// emails.getEmailTracking — reactive, so new opens/clicks appear live while
// the thread is on screen.
import { useQuery } from 'convex/react';
import { api as convexApi } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

interface EmailOpen {
  id: string;
  openedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
  city: string | null;
}

interface LinkClick {
  id: string;
  originalUrl: string;
  clickedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
  city: string | null;
}

interface TrackingData {
  id: string;
  trackingId: string;
  isEnabled: boolean;
  openCount: number;
  lastOpenedAt: string | null;
  opens: EmailOpen[];
  clicks: LinkClick[];
}

const toIso = (ms: number | undefined | null): string | null =>
  typeof ms === 'number' ? new Date(ms).toISOString() : null;

export function useTracking(emailId: string | undefined) {
  const result = useQuery(
    convexApi.emails.getEmailTracking,
    emailId ? { emailId: emailId as Id<'emails'> } : 'skip',
  );

  const raw = result?.data ?? null;
  const data: TrackingData | undefined = raw
    ? {
        id: raw.id as string,
        trackingId: raw.trackingId,
        isEnabled: raw.isEnabled,
        openCount: raw.openCount,
        lastOpenedAt: toIso(raw.lastOpenedAt),
        opens: (raw.opens ?? []).map((o: any) => ({
          id: o.id as string,
          openedAt: toIso(o.openedAt)!,
          ipAddress: o.ipAddress ?? null,
          userAgent: o.userAgent ?? null,
          country: o.country ?? null,
          city: o.city ?? null,
        })),
        clicks: (raw.clicks ?? []).map((c: any) => ({
          id: c.id as string,
          originalUrl: c.originalUrl,
          clickedAt: toIso(c.clickedAt)!,
          ipAddress: c.ipAddress ?? null,
          userAgent: c.userAgent ?? null,
          country: c.country ?? null,
          city: c.city ?? null,
        })),
      }
    : undefined;

  return {
    data,
    isLoading: emailId !== undefined && result === undefined,
    isError: false,
  };
}
