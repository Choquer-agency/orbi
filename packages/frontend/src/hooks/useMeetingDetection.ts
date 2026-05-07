import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

interface MeetingDetection {
  id: string;
  emailId: string;
  threadId: string;
  status: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestedTimes: any;
  selectedTime: string | null;
  calendarEventId: string | null;
  summary: string | null;
  attendees: string[];
  createdAt: string;
}

function shape(d: {
  _id: string;
  emailId: string;
  threadId: string;
  status: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestedTimes?: any;
  selectedTime?: number | null;
  calendarEventId?: string | null;
  summary?: string | null;
  attendees?: string[];
  _creationTime: number;
}): MeetingDetection {
  return {
    id: d._id,
    emailId: d.emailId,
    threadId: d.threadId,
    status: d.status,
    requestedTimes: d.requestedTimes,
    selectedTime: d.selectedTime
      ? new Date(d.selectedTime).toISOString()
      : null,
    calendarEventId: d.calendarEventId ?? null,
    summary: d.summary ?? null,
    attendees: d.attendees ?? [],
    createdAt: new Date(d._creationTime).toISOString(),
  };
}

export function useMeetingDetections(threadId: string | undefined) {
  const data = useQuery(
    api.meetings.listForThread,
    threadId ? { threadId: threadId as Id<'threads'> } : 'skip',
  );
  return {
    data: data ? data.map((d) => shape(d as never)) : undefined,
    isLoading: threadId ? data === undefined : false,
  };
}

export function useAcceptMeeting() {
  const fn = useMutation(api.meetings.accept);
  const [isPending, setIsPending] = useState(false);
  const mutate = async ({
    id,
    selectedTime,
  }: {
    id: string;
    selectedTime: string;
  }) => {
    setIsPending(true);
    try {
      return await fn({
        id: id as Id<'meetingDetections'>,
        selectedTime: new Date(selectedTime).getTime(),
      });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useDeclineMeeting() {
  const fn = useMutation(api.meetings.decline);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (id: string) => {
    setIsPending(true);
    try {
      return await fn({ id: id as Id<'meetingDetections'> });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}
