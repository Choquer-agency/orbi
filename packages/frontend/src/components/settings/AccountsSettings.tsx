import { useState, useEffect } from 'react';
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
import * as Popover from '@radix-ui/react-popover';
import { useAccounts, useStartOAuth, useDeleteAccount, useSyncAccount, useSetAccountColor, useUpdateAccount } from '../../hooks/useAccounts';
import { useHistoricalSyncStatus, useStartHistoricalSync, useStartContactBackfill } from '../../hooks/useHistoricalSync';
import { ACCOUNT_COLORS, getAccountColor } from '../../lib/constants';
import { useSignatures } from '../../hooks/useSignatures';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';
import toast from 'react-hot-toast';

const PROVIDER_INFO: Record<string, { label: string; color: string; icon: JSX.Element }> = {
  GMAIL: {
    label: 'Gmail',
    color: '#EA4335',
    icon: <img src="/icons/gmail.svg" alt="Gmail" className="h-5 w-5 object-contain" />,
  },
  MICROSOFT: {
    label: 'Outlook',
    color: '#0078D4',
    icon: <img src="/icons/outlook.svg" alt="Outlook" className="h-7 w-7 -m-1 object-contain" />,
  },
  APPLE_IMAP: {
    label: 'IMAP',
    color: '#666',
    icon: <Mail className="h-5 w-5 text-gray-500" />,
  },
};

function AccountCard({ account, accountIndex, isDefault, onSetDefault }: {
  account: any;
  accountIndex: number;
  isDefault: boolean;
  onSetDefault: () => void;
}) {
  const deleteAccount = useDeleteAccount();
  const syncAccount = useSyncAccount();
  const startHistoricalSync = useStartHistoricalSync();
  const startContactBackfill = useStartContactBackfill();
  const startOAuth = useStartOAuth();
  const setAccountColor = useSetAccountColor();
  const updateAccount = useUpdateAccount();
  const [colorOpen, setColorOpen] = useState(false);
  const [hexInput, setHexInput] = useState('');
  const [labelDraft, setLabelDraft] = useState<string>(account.displayName ?? '');
  // Resync the label draft if the saved name changes (e.g. via reactive
  // Convex update from another tab) and we're not actively editing.
  useEffect(() => {
    setLabelDraft(account.displayName ?? '');
  }, [account.displayName]);
  const commitLabel = () => {
    const next = labelDraft.trim();
    const current = (account.displayName ?? '').trim();
    if (next === current) return;
    updateAccount.mutate({
      id: account.id,
      displayName: next.length > 0 ? next : null,
    });
  };
  const { data: syncStatusData } = useHistoricalSyncStatus(account.id);
  const { data: sigData } = useSignatures();
  const effectiveColor: string = account.color ?? getAccountColor(accountIndex);
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
        {/* Provider icon wrapped in a colored ring matching this account's
            color — same visual the user gets in the thread list, so the
            picker preview matches reality. */}
        <div
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
          style={{ boxShadow: `0 0 0 2px white, 0 0 0 3.5px ${effectiveColor}` }}
        >
          {provider.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {/* Inline rename. Empty value clears the label (the navigation
                menu and thread list will fall back to the email address). */}
            <input
              type="text"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Escape') {
                  setLabelDraft(account.displayName ?? '');
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder={account.email}
              aria-label="Account label"
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-text-primary outline-none placeholder:font-normal placeholder:text-text-tertiary focus:placeholder:text-text-tertiary/60"
            />
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
        {/* Color picker — opens a small palette + hex input. */}
        <Popover.Root open={colorOpen} onOpenChange={setColorOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label="Change account color"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ring-border transition-transform hover:scale-105"
              style={{ background: effectiveColor }}
            />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              className="z-50 w-60 rounded-lg border border-border bg-white p-3 shadow-lg"
            >
              <p className="mb-2 text-[11px] font-medium text-text-secondary">
                Account color
              </p>
              <div className="grid grid-cols-5 gap-2">
                {ACCOUNT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      setAccountColor.mutate({ id: account.id, color: c });
                      setColorOpen(false);
                    }}
                    aria-label={`Use ${c}`}
                    className={cn(
                      'h-7 w-7 rounded-full ring-1 ring-border transition-transform hover:scale-110',
                      effectiveColor.toLowerCase() === c.toLowerCase() && 'ring-2 ring-text-primary',
                    )}
                    style={{ background: c }}
                  />
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-[11px] text-text-tertiary">Hex</span>
                <input
                  type="text"
                  value={hexInput}
                  onChange={(e) => setHexInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const v = hexInput.trim();
                    if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
                      toast.error('Use a 6-digit hex like #FF7E16');
                      return;
                    }
                    setAccountColor.mutate({ id: account.id, color: v });
                    setHexInput('');
                    setColorOpen(false);
                  }}
                  placeholder="#FF7E16"
                  className="flex-1 rounded-md border border-border px-2 py-1 text-[12px] outline-none focus:border-primary"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setAccountColor.mutate({ id: account.id, color: null });
                  setColorOpen(false);
                }}
                className="mt-3 w-full rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary hover:bg-surface"
              >
                Reset to default
              </button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
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
            onClick={() =>
              startContactBackfill.mutate(account.id).then(
                () => toast.success('Rebuilding contacts from your sent email...'),
                (err) => toast.error(err?.message ?? 'Rebuild failed to start'),
              )
            }
            disabled={startContactBackfill.isPending}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw className="h-3 w-3" />
            Rebuild contacts
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
  const accounts = accountsData ?? [];
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
        {accounts.map((account: any, index: number) => (
          <AccountCard
            key={account.id}
            account={account}
            accountIndex={index}
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
          <img src="/icons/gmail.svg" alt="" className="h-4 w-4 object-contain" />
          Add Gmail
        </button>
        <button
          onClick={() => startOAuth.mutate('microsoft')}
          className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-xs font-medium text-text-secondary transition-colors hover:border-text-tertiary hover:bg-surface hover:text-text-primary"
        >
          <img src="/icons/outlook.svg" alt="" className="h-6 w-6 -m-1 object-contain" />
          Add Outlook
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
