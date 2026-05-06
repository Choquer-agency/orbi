import { Calendar, Check, X, Loader2 } from 'lucide-react';
import { useAcceptMeeting, useDeclineMeeting } from '../../hooks/useMeetingDetection';

interface MeetingCardProps {
  detection: {
    id: string;
    status: string;
    requestedTimes: any;
    summary: string | null;
    attendees: string[];
  };
}

export function MeetingCard({ detection }: MeetingCardProps) {
  const acceptMutation = useAcceptMeeting();
  const declineMutation = useDeclineMeeting();

  if (detection.status !== 'DETECTED') {
    return (
      <div className="rounded-lg border border-border bg-teal-50/50 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-teal-700">
          <Calendar className="h-4 w-4" />
          <span className="font-medium">
            Meeting {detection.status === 'ACCEPTED' ? 'accepted' : 'declined'}
          </span>
        </div>
      </div>
    );
  }

  const times = Array.isArray(detection.requestedTimes) ? detection.requestedTimes : [];

  return (
    <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4">
      <div className="flex items-center gap-2">
        <Calendar className="h-4 w-4 text-teal-600" />
        <span className="text-sm font-semibold text-teal-800">Meeting Request Detected</span>
      </div>

      {detection.summary && (
        <p className="mt-1.5 text-xs text-teal-700">{detection.summary}</p>
      )}

      {times.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {times.map((time: any, i: number) => (
            <div
              key={i}
              className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm"
            >
              <span className="text-text-primary">{time.description}</span>
              <span className="text-xs text-text-tertiary">{time.flexibility}</span>
            </div>
          ))}
        </div>
      )}

      {detection.attendees.length > 0 && (
        <div className="mt-2 text-xs text-teal-600">
          Attendees: {detection.attendees.join(', ')}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => acceptMutation.mutate({ id: detection.id, selectedTime: new Date().toISOString() })}
          disabled={acceptMutation.isPending}
          className="flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {acceptMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Accept
        </button>
        <button
          onClick={() => declineMutation.mutate(detection.id)}
          disabled={declineMutation.isPending}
          className="flex items-center gap-1 rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface disabled:opacity-50"
        >
          {declineMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          Decline
        </button>
      </div>
    </div>
  );
}
