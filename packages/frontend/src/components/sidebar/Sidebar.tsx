import {
  Inbox,
  Send,
  FileText,
  Archive,
  Trash2,
  Star,
  Clock,
  Users,
  Plus,
  Mail,
} from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useAccounts } from '../../hooks/useAccounts';
import { cn } from '../../lib/utils';

const FOLDERS = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'drafts', label: 'Drafts', icon: FileText },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'trash', label: 'Trash', icon: Trash2 },
];

const SMART_FOLDERS = [
  { id: 'needs_response', label: 'Needs Response', icon: Clock },
  { id: 'shared', label: 'Shared With Me', icon: Users },
];

const ACCOUNT_COLORS = ['bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-orange-500', 'bg-pink-500'];

export function Sidebar() {
  const { selectedFolder, selectedAccountId, setSelectedFolder, setSelectedAccount } = useUiStore();
  const { data: accountsData } = useAccounts();
  const accounts = accountsData?.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-gray-50 px-2 py-3">
      {/* Account switcher */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Accounts
          </span>
          <button className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* All accounts (unified view) */}
        <button
          onClick={() => setSelectedAccount(null)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
            !selectedAccountId
              ? 'bg-blue-50 text-blue-700'
              : 'text-gray-700 hover:bg-gray-100',
          )}
        >
          <Mail className="h-3.5 w-3.5" />
          <span>All Accounts</span>
        </button>

        {accounts.map((account: any, i: number) => (
          <button
            key={account.id}
            onClick={() => setSelectedAccount(account.id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
              selectedAccountId === account.id
                ? 'bg-blue-50 text-blue-700'
                : 'text-gray-700 hover:bg-gray-100',
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', ACCOUNT_COLORS[i % ACCOUNT_COLORS.length])} />
            <span className="truncate">{account.email}</span>
          </button>
        ))}
      </div>

      {/* Folders */}
      <div className="mb-4">
        <span className="mb-2 block px-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
          Folders
        </span>
        {FOLDERS.map((folder) => (
          <button
            key={folder.id}
            onClick={() => setSelectedFolder(folder.id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
              selectedFolder === folder.id
                ? 'bg-blue-50 text-blue-700'
                : 'text-gray-700 hover:bg-gray-100',
            )}
          >
            <folder.icon className="h-3.5 w-3.5" />
            <span>{folder.label}</span>
          </button>
        ))}
      </div>

      {/* Smart folders */}
      <div>
        <span className="mb-2 block px-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
          Smart Folders
        </span>
        {SMART_FOLDERS.map((folder) => (
          <button
            key={folder.id}
            onClick={() => setSelectedFolder(folder.id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
              selectedFolder === folder.id
                ? 'bg-blue-50 text-blue-700'
                : 'text-gray-700 hover:bg-gray-100',
            )}
          >
            <folder.icon className="h-3.5 w-3.5" />
            <span>{folder.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
