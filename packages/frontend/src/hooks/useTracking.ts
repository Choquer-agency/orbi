// Tracking is read-only metadata for sent emails (open + click records).
// Agent B owns convex/emails.ts and convex/tracking/* — at the time of
// this rewrite, no public Convex query exposes tracking-by-email yet.
// We keep the hook signature stable so consumers (e.g. TrackingInfo) stay
// drop-in compatible; once a query lands, swap the body for a `useQuery`.

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
  emailId: string;
  trackingId: string;
  isEnabled: boolean;
  openCount: number;
  lastOpenedAt: string | null;
  opens: EmailOpen[];
  clicks: LinkClick[];
}

export function useTracking(emailId: string | undefined) {
  // Stable shape: undefined until a Convex query is added by Agent B.
  // Consumers tolerate `data === undefined` already.
  void emailId;
  return {
    data: undefined as TrackingData | undefined,
    isLoading: false,
  };
}
