import { ArrowRightLeft, Check, X, Loader2 } from 'lucide-react';
import { useRespondToHandoff } from '../../hooks/useHandoffs';

interface HandoffBannerProps {
  handoff: {
    id: string;
    note: string | null;
    status: string;
    fromUser?: { name: string };
  };
}

export function HandoffBanner({ handoff }: HandoffBannerProps) {
  const respondMutation = useRespondToHandoff();

  if (handoff.status !== 'PENDING') return null;

  return (
    <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2.5">
      <ArrowRightLeft className="h-4 w-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-amber-800">
          Handed off from {handoff.fromUser?.name || 'a teammate'}
        </p>
        {handoff.note && (
          <p className="mt-0.5 text-xs text-amber-700">{handoff.note}</p>
        )}
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={() => respondMutation.mutate({ id: handoff.id, action: 'accept' })}
          disabled={respondMutation.isPending}
          className="flex items-center gap-1 rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {respondMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Accept
        </button>
        <button
          onClick={() => respondMutation.mutate({ id: handoff.id, action: 'decline' })}
          disabled={respondMutation.isPending}
          className="flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
        >
          <X className="h-3 w-3" />
          Decline
        </button>
      </div>
    </div>
  );
}
