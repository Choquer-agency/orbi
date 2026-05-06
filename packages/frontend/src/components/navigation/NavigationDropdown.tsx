import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ChevronDown,
  Mail,
  Plus,
  Settings,
  Menu,
  RefreshCw,
  Trash2,
  Download,
  Check,
  Loader2,
  X,
} from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useAccounts, useStartOAuth, useDeleteAccount, useSyncAccount } from '../../hooks/useAccounts';
import { useHistoricalSyncStatus, useStartHistoricalSync } from '../../hooks/useHistoricalSync';
import { useDraftCount } from '../../hooks/useDrafts';
import { DASHBOARD_ITEM, FOLDERS, SMART_FOLDERS, TRIAGE_FOLDERS, getAccountColor } from '../../lib/constants';
import { cn } from '../../lib/utils';
import toast from 'react-hot-toast';

function AccountItem({
  account,
  index,
  isSelected,
  onSelect,
}: {
  account: any;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const syncAccount = useSyncAccount();
  const deleteAccount = useDeleteAccount();
  const startHistoricalSync = useStartHistoricalSync();
  const { data: syncStatusData } = useHistoricalSyncStatus(account.id);
  const syncStatus = syncStatusData?.data;
  const isImporting = syncStatus?.historicalSyncStatus === 'IN_PROGRESS';
  const isCompleted = syncStatus?.historicalSyncStatus === 'COMPLETED';
  const progress = syncStatus?.historicalSyncProgress;

  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        'group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors',
        isSelected
          ? 'bg-selected text-primary font-medium'
          : 'text-text-primary hover:bg-surface',
      )}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: getAccountColor(index) }}
      />
      <div className="flex-1 min-w-0">
        <span className="block truncate">{account.email}</span>
        {isImporting && progress && (
          <span className="flex items-center gap-1 text-[11px] text-text-tertiary">
            <Loader2 className="h-3 w-3 animate-spin" />
            Syncing {progress.syncedThreads.toLocaleString()} / ~{progress.totalThreads.toLocaleString()}
          </span>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
        {!isImporting && !isCompleted && (account.provider === 'GMAIL' || account.provider === 'MICROSOFT') && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              startHistoricalSync.mutate(account.id, {
                onSuccess: () => toast.success('Importing all email...'),
                onError: () => toast.error('Import failed to start'),
              });
            }}
            className="rounded p-0.5 hover:bg-surface"
            title="Import all email"
            aria-label="Import all email"
          >
            <Download className="h-3 w-3 text-text-tertiary" />
          </button>
        )}
        {isCompleted && (
          <span title="All email synced">
            <Check className="h-3 w-3 text-green-500" />
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            syncAccount.mutate(account.id, {
              onSuccess: () => toast.success('Sync started'),
              onError: () => toast.error('Sync failed'),
            });
          }}
          className="rounded p-0.5 hover:bg-surface"
          title="Sync now"
          aria-label="Sync now"
        >
          <RefreshCw className="h-3 w-3 text-text-tertiary" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm('Remove this account?')) {
              deleteAccount.mutate(account.id);
            }
          }}
          className="rounded p-0.5 hover:bg-surface"
          title="Remove account"
          aria-label="Remove account"
        >
          <Trash2 className="h-3 w-3 text-text-tertiary" />
        </button>
      </span>
    </DropdownMenu.Item>
  );
}

export function NavigationDropdown() {
  const {
    selectedFolder,
    selectedAccountId,
    navDropdownOpen,
    setSelectedFolder,
    setSelectedAccount,
    setNavDropdownOpen,
  } = useUiStore();
  const { data: accountsData } = useAccounts();
  const accounts = accountsData?.data ?? [];
  const startOAuth = useStartOAuth();
  const { data: draftCountData } = useDraftCount();
  const draftCount = draftCountData?.data?.count ?? 0;
  const [addAccountOpen, setAddAccountOpen] = useState(false);

  const currentFolder = selectedFolder === 'dashboard' ? DASHBOARD_ITEM :
    FOLDERS.find((f) => f.id === selectedFolder) ??
    SMART_FOLDERS.find((f) => f.id === selectedFolder) ??
    TRIAGE_FOLDERS.find((f) => f.id === selectedFolder);
  const currentLabel = currentFolder?.label ?? 'Inbox';

  return (
    <DropdownMenu.Root open={navDropdownOpen} onOpenChange={setNavDropdownOpen}>
      <DropdownMenu.Trigger asChild>
        <button className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface">
          <Menu className="h-4 w-4 text-text-secondary" />
          <span className="text-sm font-semibold text-text-primary">{currentLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 text-text-tertiary" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-50 my-3 max-h-[calc(100vh-10rem)] w-[280px] overflow-y-auto rounded-lg border border-border bg-white p-2 shadow-lg"
          sideOffset={8}
          align="start"
          avoidCollisions
        >
          {/* Dashboard */}
          <DropdownMenu.Item
            onSelect={() => {
              setSelectedFolder('dashboard');
              setSelectedAccount(null);
            }}
            className={cn(
              'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors',
              selectedFolder === 'dashboard'
                ? 'bg-selected text-primary font-medium'
                : 'text-text-primary hover:bg-surface',
            )}
          >
            <DASHBOARD_ITEM.icon className="h-4 w-4" />
            <span>{DASHBOARD_ITEM.label}</span>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="my-2 h-px bg-border" />

          {/* Standard folders */}
          <DropdownMenu.Group>
            <DropdownMenu.Label className="mb-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
              Folders
            </DropdownMenu.Label>
            {FOLDERS.map((folder) => (
              <DropdownMenu.Item
                key={folder.id}
                onSelect={() => {
                  setSelectedFolder(folder.id);
                  setSelectedAccount(null);
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors',
                  selectedFolder === folder.id && !selectedAccountId
                    ? 'bg-selected text-primary font-medium'
                    : 'text-text-primary hover:bg-surface',
                )}
              >
                <folder.icon className="h-4 w-4" />
                <span className="flex-1">{folder.label}</span>
                {folder.id === 'drafts' && draftCount > 0 && (
                  <span className="ml-auto text-[11px] text-text-tertiary">{draftCount}</span>
                )}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>

          <DropdownMenu.Separator className="my-2 h-px bg-border" />

          {/* Triage folders */}
          <DropdownMenu.Group>
            <DropdownMenu.Label className="mb-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
              Triage
            </DropdownMenu.Label>
            {TRIAGE_FOLDERS.map((folder) => (
              <DropdownMenu.Item
                key={folder.id}
                onSelect={() => {
                  setSelectedFolder(folder.id);
                  setSelectedAccount(null);
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors',
                  selectedFolder === folder.id && !selectedAccountId
                    ? 'bg-selected text-primary font-medium'
                    : 'text-text-primary hover:bg-surface',
                )}
              >
                <folder.icon className="h-4 w-4" />
                <span>{folder.label}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>

          <DropdownMenu.Separator className="my-2 h-px bg-border" />

          {/* Smart folders */}
          <DropdownMenu.Group>
            <DropdownMenu.Label className="mb-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
              Smart
            </DropdownMenu.Label>
            {SMART_FOLDERS.map((folder) => (
              <DropdownMenu.Item
                key={folder.id}
                onSelect={() => {
                  setSelectedFolder(folder.id);
                  setSelectedAccount(null);
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors',
                  selectedFolder === folder.id && !selectedAccountId
                    ? 'bg-selected text-primary font-medium'
                    : 'text-text-primary hover:bg-surface',
                )}
              >
                <folder.icon className="h-4 w-4" />
                <span>{folder.label}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>

          <DropdownMenu.Separator className="my-2 h-px bg-border" />

          {/* Accounts */}
          <DropdownMenu.Group>
            <DropdownMenu.Label className="mb-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
              Accounts
            </DropdownMenu.Label>

            {/* All accounts */}
            <DropdownMenu.Item
              onSelect={() => setSelectedAccount(null)}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors',
                !selectedAccountId
                  ? 'bg-selected text-primary font-medium'
                  : 'text-text-primary hover:bg-surface',
              )}
            >
              <Mail className="h-4 w-4" />
              <span>All Accounts</span>
            </DropdownMenu.Item>

            {accounts.map((account: any, i: number) => (
              <AccountItem
                key={account.id}
                account={account}
                index={i}
                isSelected={selectedAccountId === account.id}
                onSelect={() => setSelectedAccount(account.id)}
              />
            ))}

            {/* Add account — opens a modal */}
            <DropdownMenu.Item
              onSelect={(e) => {
                e.preventDefault();
                setNavDropdownOpen(false);
                setAddAccountOpen(true);
              }}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-surface hover:text-text-primary"
            >
              <Plus className="h-4 w-4" />
              <span>Add Account</span>
            </DropdownMenu.Item>
          </DropdownMenu.Group>

        </DropdownMenu.Content>
      </DropdownMenu.Portal>

      {/* Add Account Dialog */}
      <Dialog.Root open={addAccountOpen} onOpenChange={setAddAccountOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-white p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
            <div className="flex items-center justify-between mb-5">
              <Dialog.Title className="text-base font-semibold text-text-primary">
                Add Account
              </Dialog.Title>
              <Dialog.Close className="rounded-md p-1 text-text-tertiary hover:bg-surface hover:text-text-primary" aria-label="Close dialog">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <p className="text-sm text-text-secondary mb-4">
              Choose a provider to connect your email account.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  setAddAccountOpen(false);
                  startOAuth.mutate('gmail');
                }}
                className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none">
                  <path d="M22 6L12 13L2 6V4L12 11L22 4V6Z" fill="#EA4335"/>
                  <path d="M22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6L12 13L22 6Z" fill="#FBBC05" fillOpacity="0.3"/>
                </svg>
                Gmail
              </button>
              <button
                onClick={() => {
                  setAddAccountOpen(false);
                  startOAuth.mutate('microsoft');
                }}
                className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none">
                  <rect x="2" y="2" width="9.5" height="9.5" fill="#F25022"/>
                  <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7FBA00"/>
                  <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00A4EF"/>
                  <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#FFB900"/>
                </svg>
                Office 365
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </DropdownMenu.Root>
  );
}
