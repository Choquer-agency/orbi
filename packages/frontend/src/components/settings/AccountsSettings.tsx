import { useState } from 'react';
import {
  Mail,
  Star,
  RefreshCw,
  Trash2,
  Download,
  Check,
  Loader2,
  ExternalLink,
  Shield,
  Clock,
  Plus,
} from 'lucide-react';
import { useAccounts, useStartOAuth, useDeleteAccount, useSyncAccount } from '../../hooks/useAccounts';
import { useHistoricalSyncStatus, useStartHistoricalSync } from '../../hooks/useHistoricalSync';
import { useSignatures } from '../../hooks/useSignatures';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';
import toast from 'react-hot-toast';

const PROVIDER_INFO: Record<string, { label: string; color: string; icon: JSX.Element }> = {
  GMAIL: {
    label: 'Gmail',
    color: '#EA4335',
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none">
        <path d="M22 6L12 13L2 6V4L12 11L22 4V6Z" fill="#EA4335" />
        <path d="M22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6L12 13L22 6Z" fill="#FBBC05" fillOpacity="0.3" />
      </svg>
    ),
  },
  MICROSOFT: {
    label: 'Office 365',
    color: '#0078D4',
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none">
        <rect x="2" y="2" width="9.5" height="9.5" fill="#F25022" />
        <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7FBA00" />
        <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00A4EF" />
        <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#FFB900" />
      </svg>
    ),
  },
  APPLE_IMAP: {
    label: 'IMAP',
    color: '#666',
    icon: <Mail className="h-5 w-5 text-gray-500" />,
  },
};

function AccountCard({ account, isDefault, onSetDefault }: {
  account: any;
  isDefault: boolean;
  onSetDefault: () => void;
}) {
  const deleteAccount = useDeleteAccount();
  const syncAccount = useSyncAccount();
  const startHistoricalSync = useStartHistoricalSync();
  const startOAuth = useStartOAuth();
  const { data: syncStatusData } = useHistoricalSyncStatus(account.id);
  const { data: sigData } = useSignatures();
  const syncStatus = syncStatusData?.data;
  const isImporting = syncStatus?.historicalSyncStatus === 'IN_PROGRESS';
  const isCompleted = syncStatus?.historicalSyncStatus === 'COMPLETED';
  const progress = syncStatus?.historicalSyncProgress;

  const provider = PROVIDER_INFO[account.provider] ?? PROVIDER_INFO.APPLE_IMAP;
  const accountSignatures = (sigData?.data ?? []).filter(
    (s: any) => s.accountIds?.includes(account.id),
  );

  const lastSynced = account.lastSyncAt
    ? new Date(account.lastSyncAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Never';

  return (
    <div className={cn(
      'rounded-lg border p-4 transition-colors',
      isDefault ? 'border-primary/40 bg-primary/3' : 'border-border',
    )}>
      {/* Header row */}
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{provider.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-text-primary truncate">
              {account.displayName || account.email}
            </p>
            {isDefault && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                Default
              </span>
            )}
          </div>
          <p className="text-xs text-text-tertiary truncate">{account.email}</p>
          <p className="mt-0.5 text-[11px] text-text-tertiary">
            {provider.label}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="mt-3 flex items-center gap-4 text-[11px] text-text-tertiary">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          Last synced: {lastSynced}
        </span>
        {isImporting && progress && (
          <span className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Importing {progress.syncedThreads?.toLocaleString() ?? progress.syncedMessages?.toLocaleString() ?? 0}
          </span>
        )}
        {isCompleted && (
          <span className="flex items-center gap-1 text-green-600">
            <Check className="h-3 w-3" />
            All email imported
          </span>
        )}
      </div>

      {/* Signatures */}
      {accountSignatures.length > 0 && (
        <div className="mt-3 rounded-md bg-surface/50 px-3 py-2">
          <p className="text-[11px] font-medium text-text-secondary">
            Signatures ({accountSignatures.length})
          </p>
          <div className="mt-1 space-y-0.5">
            {accountSignatures.map((sig: any) => (
              <p key={sig.id} className="text-[11px] text-text-tertiary truncate">
                {sig.name}{sig.isDefault ? ' (default)' : ''}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!isDefault && (
          <button
            onClick={onSetDefault}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
          >
            <Star className="h-3 w-3" />
            Set as Default
          </button>
        )}
        <button
          onClick={() =>
            syncAccount.mutate(account.id, {
              onSuccess: () => toast.success('Sync started'),
              onError: () => toast.error('Sync failed'),
            })
          }
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
        >
          <RefreshCw className="h-3 w-3" />
          Sync Now
        </button>
        {!isImporting && !isCompleted && (account.provider === 'GMAIL' || account.provider === 'MICROSOFT') && (
          <button
            onClick={() =>
              startHistoricalSync.mutate(account.id, {
                onSuccess: () => toast.success('Importing all email...'),
                onError: () => toast.error('Import failed to start'),
              })
            }
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
          >
            <Download className="h-3 w-3" />
            Import All Email
          </button>
        )}
        {(account.provider === 'GMAIL' || account.provider === 'MICROSOFT') && (
          <button
            onClick={() => startOAuth.mutate(account.provider === 'GMAIL' ? 'gmail' : 'microsoft')}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
          >
            <Shield className="h-3 w-3" />
            Reconnect
          </button>
        )}
        <button
          onClick={() => {
            if (confirm(`Remove ${account.email}? This will delete all synced emails from this account.`)) {
              deleteAccount.mutate(account.id);
            }
          }}
          className="flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-[11px] font-medium text-red-500 transition-colors hover:bg-red-50"
        >
          <Trash2 className="h-3 w-3" />
          Remove
        </button>
      </div>
    </div>
  );
}

export function AccountsSettings() {
  const { data: accountsData } = useAccounts();
  const accounts = accountsData?.data ?? [];
  const startOAuth = useStartOAuth();
  const defaultAccountId = useUiStore((s) => s.defaultAccountId);
  const setDefaultAccountId = useUiStore((s) => s.setDefaultAccountId);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  // If no default is set, treat the first account as default
  const effectiveDefault = defaultAccountId && accounts.some((a: any) => a.id === defaultAccountId)
    ? defaultAccountId
    : accounts[0]?.id ?? null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary">Connected Accounts</h3>
        <p className="mt-1 text-xs text-text-tertiary">
          Manage your email accounts. The default account is used when composing new emails.
        </p>
      </div>

      {/* Account cards */}
      <div className="space-y-3">
        {accounts.map((account: any) => (
          <AccountCard
            key={account.id}
            account={account}
            isDefault={account.id === effectiveDefault}
            onSetDefault={() => {
              setDefaultAccountId(account.id);
              toast.success(`${account.email} set as default`);
            }}
          />
        ))}
      </div>

      {/* Add account */}
      <div className="flex gap-2">
        <button
          onClick={() => startOAuth.mutate('gmail')}
          className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-xs font-medium text-text-secondary transition-colors hover:border-text-tertiary hover:bg-surface hover:text-text-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Gmail
        </button>
        <button
          onClick={() => startOAuth.mutate('microsoft')}
          className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-xs font-medium text-text-secondary transition-colors hover:border-text-tertiary hover:bg-surface hover:text-text-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Office 365
        </button>
      </div>

      {/* Tip */}
      <div className="rounded-lg bg-surface/50 px-4 py-3">
        <p className="text-[11px] text-text-tertiary">
          <strong className="text-text-secondary">Tip:</strong> When replying to an email, Orbi automatically sends from the account the email was addressed to. The default account is only used for new emails you compose.
        </p>
      </div>
    </div>
  );
}
