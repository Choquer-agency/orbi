import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface MeetingDetection {
  id: string;
  emailId: string;
  threadId: string;
  status: string;
  requestedTimes: any;
  selectedTime: string | null;
  calendarEventId: string | null;
  summary: string | null;
  attendees: string[];
  createdAt: string;
}

export function useMeetingDetections(threadId: string | undefined) {
  return useQuery({
    queryKey: ['meeting-detections', threadId],
    queryFn: () => api.get<{ data: MeetingDetection[] }>(`/threads/${threadId}/meeting-detection`),
    select: (res) => res.data,
    enabled: !!threadId,
  });
}

export function useAcceptMeeting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, selectedTime }: { id: string; selectedTime: string }) =>
      api.post(`/meetings/${id}/accept`, { selectedTime }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meeting-detections'] });
    },
  });
}

export function useDeclineMeeting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.post(`/meetings/${id}/decline`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meeting-detections'] });
    },
  });
}
