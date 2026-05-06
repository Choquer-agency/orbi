import { useState } from 'react';
import { Eye, ChevronDown, ChevronUp, MousePointerClick, ExternalLink } from 'lucide-react';
import { useTracking } from '../../hooks/useTracking';

interface TrackingInfoProps {
  emailId: string;
}

export function TrackingInfo({ emailId }: TrackingInfoProps) {
  const { data: tracking, isError } = useTracking(emailId);
  const [expanded, setExpanded] = useState(false);

  // Don't render if no tracking data or error
  if (isError || !tracking) return null;

  const hasOpens = tracking.openCount > 0;
  const hasClicks = tracking.clicks && tracking.clicks.length > 0;

  if (!hasOpens && !hasClicks) return null;

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  // Build unified timeline sorted by time
  type TimelineEvent = {
    type: 'open' | 'click';
    time: string;
    id: string;
    city?: string | null;
    country?: string | null;
    url?: string;
  };

  const timeline: TimelineEvent[] = [];

  if (tracking.opens) {
    for (const open of tracking.opens) {
      timeline.push({
        type: 'open',
        time: open.openedAt,
        id: open.id,
        city: open.city,
        country: open.country,
      });
    }
  }

  if (tracking.clicks) {
    for (const click of tracking.clicks) {
      timeline.push({
        type: 'click',
        time: click.clickedAt,
        id: click.id,
        city: click.city,
        country: click.country,
        url: click.originalUrl,
      });
    }
  }

  timeline.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  const clickCount = tracking.clicks?.length ?? 0;

  return (
    <div className="mt-2 mb-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary"
      >
        <Eye className="h-3 w-3" />
        <span>
          {hasOpens && (
            <>Opened {tracking.openCount}x</>
          )}
          {hasOpens && hasClicks && ' · '}
          {hasClicks && (
            <>{clickCount} link click{clickCount !== 1 ? 's' : ''}</>
          )}
          {tracking.lastOpenedAt && (
            <> · Last: {formatTime(tracking.lastOpenedAt)}</>
          )}
        </span>
        {timeline.length > 0 && (
          expanded
            ? <ChevronUp className="h-3 w-3" />
            : <ChevronDown className="h-3 w-3" />
        )}
      </button>

      {expanded && timeline.length > 0 && (
        <div className="ml-5 mt-1 space-y-0.5 border-l border-border pl-3">
          {timeline.map((event) => (
            <div key={event.id} className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
              {event.type === 'open' ? (
                <Eye className="h-2.5 w-2.5 shrink-0 text-blue-400" />
              ) : (
                <MousePointerClick className="h-2.5 w-2.5 shrink-0 text-green-500" />
              )}
              <span>{formatTime(event.time)}</span>
              {event.type === 'click' && event.url && (
                <span className="flex items-center gap-0.5 truncate text-green-600">
                  <ExternalLink className="h-2 w-2" />
                  {new URL(event.url).hostname}
                </span>
              )}
              {(event.city || event.country) && (
                <span className="text-text-tertiary/70">
                  — {[event.city, event.country].filter(Boolean).join(', ')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
