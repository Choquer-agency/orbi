import { CheckCircle2, Eye } from 'lucide-react';
import { useTracking } from '../../hooks/useTracking';
import { TrackingInfo } from './TrackingInfo';

interface DeliveryStatusProps {
  emailId: string;
}

export function DeliveryStatus({ emailId }: DeliveryStatusProps) {
  const { data: tracking } = useTracking(emailId);
  const hasOpens = tracking && tracking.openCount > 0;

  const formatTime = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  return (
    <div className="mt-3">
      {hasOpens ? (
        <div className="flex items-center gap-2 text-[11px] text-blue-600">
          <Eye className="h-3 w-3" />
          <span>
            Opened{tracking.openCount > 1 ? ` ${tracking.openCount}x` : ''}
            {tracking.lastOpenedAt && (
              <> &middot; {formatTime(tracking.lastOpenedAt)}</>
            )}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[11px] text-green-600">
          <CheckCircle2 className="h-3 w-3" />
          <span>Delivered</span>
        </div>
      )}
      <TrackingInfo emailId={emailId} />
    </div>
  );
}
