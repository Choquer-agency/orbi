import { useState } from 'react';
import { ShieldBan, Plus, Trash2, Globe, Mail } from 'lucide-react';
import {
  useBlockedSenders,
  useBlockSender,
  useUnblockSender,
} from '../../hooks/useBlockedSenders';
import { cn } from '../../lib/utils';

export function BlockedSendersSettings() {
  const { data: blocked } = useBlockedSenders();
  const blockSender = useBlockSender();
  const unblockSender = useUnblockSender();
  const [input, setInput] = useState('');
  const [blockType, setBlockType] = useState<'email' | 'domain'>('email');
  const [reason, setReason] = useState('');

  const handleBlock = () => {
    const value = input.trim();
    if (!value) return;

    if (blockType === 'email') {
      if (!value.includes('@')) return;
      blockSender.mutate(
        { emailAddress: value, reason: reason.trim() || undefined },
        { onSuccess: () => { setInput(''); setReason(''); } },
      );
    } else {
      blockSender.mutate(
        { domain: value.replace(/^@/, ''), reason: reason.trim() || undefined },
        { onSuccess: () => { setInput(''); setReason(''); } },
      );
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldBan className="h-4 w-4 text-red-500" />
        <h3 className="text-[13px] font-semibold text-text-primary">Blocked Senders</h3>
      </div>

      <p className="text-[11px] text-text-tertiary leading-relaxed">
        Emails from blocked addresses or domains will be automatically moved to trash.
        Block an entire domain to catch all addresses from that organization.
      </p>

      {/* Block type selector */}
      <div className="flex gap-1 rounded-lg bg-surface p-0.5">
        <button
          onClick={() => setBlockType('email')}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
            blockType === 'email' ? 'bg-white text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-secondary',
          )}
        >
          <Mail className="h-3 w-3" />
          Email Address
        </button>
        <button
          onClick={() => setBlockType('domain')}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
            blockType === 'domain' ? 'bg-white text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-secondary',
          )}
        >
          <Globe className="h-3 w-3" />
          Entire Domain
        </button>
      </div>

      {/* Add form */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={blockType === 'email' ? 'spam@example.com' : 'example.com'}
            className="min-w-0 flex-1 rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
            onKeyDown={(e) => e.key === 'Enter' && handleBlock()}
          />
          <button
            onClick={handleBlock}
            disabled={blockSender.isPending || !input.trim()}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-red-500 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
          >
            <ShieldBan className="h-3.5 w-3.5" />
            Block
          </button>
        </div>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional): e.g., Cold outreach, spam"
          className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
      </div>

      {/* Blocked list */}
      {blocked && blocked.length > 0 && (
        <div className="space-y-1">
          {blocked.map((b) => (
            <div
              key={b.id}
              className="flex items-center justify-between rounded-lg bg-surface/50 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  {b.domain ? (
                    <Globe className="h-3 w-3 text-text-tertiary" />
                  ) : (
                    <Mail className="h-3 w-3 text-text-tertiary" />
                  )}
                  <p className="truncate text-[12px] font-medium text-text-primary">
                    {b.domain ? `@${b.domain}` : b.emailAddress}
                  </p>
                  <span className="rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-medium text-red-600">
                    {b.domain ? 'Domain' : 'Email'}
                  </span>
                </div>
                {b.reason && (
                  <p className="mt-0.5 truncate text-[11px] text-text-tertiary">{b.reason}</p>
                )}
              </div>
              <button
                onClick={() => unblockSender.mutate(b.id)}
                className="shrink-0 rounded px-2 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-white hover:text-primary"
              >
                Unblock
              </button>
            </div>
          ))}
        </div>
      )}

      {blocked && blocked.length === 0 && (
        <p className="text-center text-[11px] text-text-tertiary py-2">
          No blocked senders. Use "Block sender" from any email to add entries here.
        </p>
      )}
    </div>
  );
}
