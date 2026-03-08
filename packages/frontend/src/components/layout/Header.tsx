import { Search, Bell, LogOut } from 'lucide-react';
import { useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useUnreadCount } from '../../hooks/useNotifications';
import { getInitials } from '../../lib/utils';

export function Header() {
  const { user, logout } = useAuthStore();
  const { data: unreadData } = useUnreadCount();
  const unreadCount = unreadData?.data?.count ?? 0;
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <div className="titlebar-no-drag flex h-full items-center justify-between px-4">
      {/* Left spacer for traffic lights on macOS */}
      <div className="w-[70px]" />

      {/* Search */}
      <div className="relative mx-4 max-w-md flex-1">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search emails..."
          className="w-full rounded-md border border-gray-300 bg-white py-1 pl-8 pr-3 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-3">
        {/* Notifications */}
        <button className="relative rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>

        {/* User menu */}
        {user && (
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-[10px] font-medium text-white">
              {getInitials(user.name)}
            </div>
            <button
              onClick={logout}
              className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
