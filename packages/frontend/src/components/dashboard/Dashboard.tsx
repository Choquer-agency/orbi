import { NavigationDropdown } from '../navigation/NavigationDropdown';
import { ResponseTimeCard } from './ResponseTimeCard';
import { NeedsReplyList } from './NeedsReplyList';
import { TaskList } from './TaskList';
import { PendingMessages } from './PendingMessages';

export function Dashboard() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-10 pb-3 pt-[30px]">
        <NavigationDropdown />
        <div className="flex-1" />
        <span className="text-[12px] text-text-tertiary">{today}</span>
      </div>

      {/* Two-column layout */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex gap-6 px-8 py-8">
          {/* Left column */}
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <ResponseTimeCard />
            <NeedsReplyList />
            <PendingMessages />
          </div>

          {/* Right column */}
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <TaskList />
          </div>
        </div>
      </div>
    </div>
  );
}
