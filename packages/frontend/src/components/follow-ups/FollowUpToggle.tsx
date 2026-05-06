import { useState } from 'react';
import { BellRing, BellOff, Loader2 } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useCreateFollowUp, useCancelFollowUp } from '../../hooks/useFollowUps';

interface FollowUpToggleProps {
  threadId: string;
  emailId: string;
  contactEmail: string;
  activeWatchId?: string;
}

export function FollowUpToggle({ threadId, emailId, contactEmail, activeWatchId }: FollowUpToggleProps) {
  const createMutation = useCreateFollowUp();
  const cancelMutation = useCancelFollowUp();
  const isActive = !!activeWatchId;
  const isLoading = createMutation.isPending || cancelMutation.isPending;

  const handleToggle = () => {
    if (isActive && activeWatchId) {
      cancelMutation.mutate(activeWatchId);
    } else {
      createMutation.mutate({ threadId, emailId, contactEmail });
    }
  };

  return (
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            onClick={handleToggle}
            disabled={isLoading}
            className={`rounded-lg p-1.5 transition-colors ${
              isActive
                ? 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                : 'text-text-tertiary hover:bg-surface hover:text-text-primary'
            } disabled:opacity-50`}
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isActive ? (
              <BellRing className="h-3.5 w-3.5" />
            ) : (
              <BellOff className="h-3.5 w-3.5" />
            )}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Content
          side="top"
          className="rounded-lg bg-gray-900 px-2.5 py-1 text-xs text-white shadow-lg"
        >
          {isActive ? 'Watching for reply' : 'Watch for reply'}
          <Tooltip.Arrow className="fill-gray-900" />
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
