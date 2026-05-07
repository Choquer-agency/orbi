import { useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';

export interface NotificationPreferencesData {
  id?: string;
  enableNewEmail: boolean;
  enableMention: boolean;
  enableComment: boolean;
  enableAssignment: boolean;
  enableSlaWarning: boolean;
  enableSlaBreach: boolean;
  enableSnoozeReminder: boolean;
  desktopEnabled: boolean;
  soundEnabled: boolean;
  pushEnabled: boolean;
  showPreviewOnLock: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string | null;
}

function shape(p: any): NotificationPreferencesData {
  return {
    id: p._id ?? p.id,
    enableNewEmail: p.enableNewEmail ?? true,
    enableMention: p.enableMention ?? true,
    enableComment: p.enableComment ?? true,
    enableAssignment: p.enableAssignment ?? true,
    enableSlaWarning: p.enableSlaWarning ?? true,
    enableSlaBreach: p.enableSlaBreach ?? true,
    enableSnoozeReminder: p.enableSnoozeReminder ?? true,
    desktopEnabled: p.desktopEnabled ?? true,
    soundEnabled: p.soundEnabled ?? true,
    pushEnabled: p.pushEnabled ?? true,
    showPreviewOnLock: p.showPreviewOnLock ?? true,
    quietHoursStart: p.quietHoursStart ?? null,
    quietHoursEnd: p.quietHoursEnd ?? null,
    quietHoursTimezone: p.quietHoursTimezone ?? null,
  };
}

export function useNotificationPreferences() {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(api.notificationPreferences.get, isAuthenticated ? {} : 'skip');
  return {
    data: data ? shape(data) : undefined,
    isLoading: data === undefined,
  };
}

export function useUpdateNotificationPreferences() {
  const fn = useMutation(api.notificationPreferences.update);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    payload: Partial<NotificationPreferencesData>,
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      // Strip `id` if present and forward the rest. quietHours* fields can be
      // `null` to clear them — Convex accepts string|null.
      const { id: _id, ...rest } = payload;
      const result = await fn(rest as any);
      opts?.onSuccess?.(result);
      return result;
    } catch (err) {
      opts?.onError?.(err);
      throw err;
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}
