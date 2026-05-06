import { Inbox, Search, PenSquare, Sparkles, User } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { cn, getInitials } from '../../lib/utils';
import { haptic } from '../../lib/haptics';

export function MobileBottomNav() {
  const mobileActiveView = useUiStore((s) => s.mobileActiveView);
  const selectedFolder = useUiStore((s) => s.selectedFolder);
  const setMobileActiveView = useUiStore((s) => s.setMobileActiveView);
  const setSelectedFolder = useUiStore((s) => s.setSelectedFolder);
  const setComposingNew = useUiStore((s) => s.setComposingNew);
  const { user } = useAuthStore();

  const isInboxActive = mobileActiveView === 'list' && selectedFolder === 'inbox';
  const isChatActive = mobileActiveView === 'chat';
  const isSettingsActive = mobileActiveView === 'settings';

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <div className="flex h-12 items-center justify-around">
        {/* Inbox */}
        <button
          onClick={() => {
            haptic.light();
            setSelectedFolder('inbox');
            setMobileActiveView('list');
          }}
          className={cn(
            'flex min-h-[44px] min-w-[44px] items-center justify-center transition-colors',
            isInboxActive ? 'text-primary' : 'text-text-tertiary',
          )}
        >
          <Inbox className="h-6 w-6" />
        </button>

        {/* Search */}
        <button
          onClick={() => {
            haptic.light();
            setMobileActiveView('list');
          }}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center text-text-tertiary transition-colors"
        >
          <Search className="h-6 w-6" />
        </button>

        {/* Compose — no background, just the icon */}
        <button
          onClick={() => { haptic.light(); setComposingNew(true); }}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center text-primary transition-colors"
          aria-label="Compose new email"
        >
          <PenSquare className="h-6 w-6" />
        </button>

        {/* AI Chat */}
        <button
          onClick={() => { haptic.light(); setMobileActiveView('chat'); }}
          className={cn(
            'flex min-h-[44px] min-w-[44px] items-center justify-center transition-colors',
            isChatActive ? 'text-primary' : 'text-text-tertiary',
          )}
        >
          <Sparkles className="h-6 w-6" />
        </button>

        {/* Profile — opens full-screen settings */}
        <button
          onClick={() => { haptic.light(); setMobileActiveView('settings'); }}
          className={cn(
            'flex min-h-[44px] min-w-[44px] items-center justify-center transition-colors',
            isSettingsActive ? 'text-primary' : 'text-text-tertiary',
          )}
        >
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt={user.name} className="h-7 w-7 rounded-full object-cover" />
          ) : user ? (
            <div className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold',
              isSettingsActive ? 'bg-primary/20 text-primary' : 'bg-primary/15 text-primary',
            )}>
              {getInitials(user.name)}
            </div>
          ) : (
            <User className="h-6 w-6" />
          )}
        </button>
      </div>
    </nav>
  );
}
