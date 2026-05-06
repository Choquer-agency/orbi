import { LogOut, Settings } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAuthStore } from '../../stores/authStore';
import { useUiStore } from '../../stores/uiStore';
import { getInitials } from '../../lib/utils';
import { NotificationPopover } from './NotificationPopover';

export function HeaderIcons() {
  const { user, logout } = useAuthStore();
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  return (
    <div className="titlebar-no-drag flex items-center gap-3">
      {/* Notifications */}
      <NotificationPopover />

      {/* User avatar menu */}
      {user && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-white transition-opacity hover:opacity-80"
              aria-label="Account menu"
            >
              {getInitials(user.name)}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="z-50 w-[180px] rounded-lg border border-border bg-white p-1 shadow-lg"
              sideOffset={6}
              align="end"
            >
              <DropdownMenu.Item
                onSelect={() => setSettingsOpen(true)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors hover:bg-surface"
              >
                <Settings className="h-3.5 w-3.5 text-text-tertiary" />
                Settings
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                onSelect={logout}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-red-600 outline-none transition-colors hover:bg-red-50"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}
