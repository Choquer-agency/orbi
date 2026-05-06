import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

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
  return useQuery({
    queryKey: ['tracking', emailId],
    queryFn: () => api.get<{ data: TrackingData }>(`/emails/${emailId}/tracking`),
    select: (res) => res.data,
    enabled: !!emailId,
    retry: false,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}
