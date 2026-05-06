import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface NotificationPreferencesData {
  id: string;
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

export function useNotificationPreferences() {
  return useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api.get<{ data: NotificationPreferencesData }>('/settings/notification-preferences'),
    select: (res) => res.data,
  });
}

export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<NotificationPreferencesData>) =>
      api.put('/settings/notification-preferences', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
    },
  });
}
