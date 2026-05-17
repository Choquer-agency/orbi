import { useEffect, useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import { Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';

interface Settings {
  spamRetentionDays: number;
  trashRetentionDays: number;
  blockedSenderImmediate: boolean;
}

export function RetentionSettings() {
  const remote = useQuery(api.retention.getSettings, {});
  const update = useMutation(api.retention.updateSettings);
  const [local, setLocal] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (remote && !local) setLocal(remote);
  }, [remote, local]);

  if (!local) {
    return <div className="text-[12px] text-text-tertiary">Loading…</div>;
  }

  const isDirty =
    !!remote &&
    (remote.spamRetentionDays !== local.spamRetentionDays ||
      remote.trashRetentionDays !== local.trashRetentionDays ||
      remote.blockedSenderImmediate !== local.blockedSenderImmediate);

  const handleSave = async () => {
    setSaving(true);
    try {
      await update({
        spamRetentionDays: local.spamRetentionDays,
        trashRetentionDays: local.trashRetentionDays,
        blockedSenderImmediate: local.blockedSenderImmediate,
      });
      toast.success('Retention settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <div className="mb-1 flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-text-tertiary" />
          <h2 className="text-[14px] font-semibold text-text-primary">
            Auto-delete & retention
          </h2>
        </div>
        <p className="text-[12px] leading-relaxed text-text-secondary">
          Hard-delete old emails so the mailbox stays small. Runs once a day.
          Set to <span className="font-medium">0</span> to delete immediately on
          the next sweep, or <span className="font-medium">365</span> to
          effectively keep forever.
        </p>
      </header>

      <Field
        label="Spam"
        helper="Delete emails in the Spam folder this many days after their last activity."
        value={local.spamRetentionDays}
        onChange={(v) => setLocal({ ...local, spamRetentionDays: v })}
      />

      <Field
        label="Trash"
        helper="Delete emails in the Trash folder this many days after their last activity."
        value={local.trashRetentionDays}
        onChange={(v) => setLocal({ ...local, trashRetentionDays: v })}
      />

      <div className="space-y-2 rounded-lg border border-border bg-surface/40 p-3">
        <div>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-text-primary">
            <input
              type="checkbox"
              checked={local.blockedSenderImmediate}
              onChange={(e) =>
                setLocal({ ...local, blockedSenderImmediate: e.target.checked })
              }
              className="h-3.5 w-3.5 rounded border-border accent-primary"
            />
            Delete blocked-sender emails immediately on arrival
          </label>
        </div>
        <p className="ml-6 text-[11px] text-text-tertiary">
          When checked, mail from blocked senders is removed on sync (never
          even touches the Trash folder). When unchecked, it moves to Trash
          and falls under the Trash retention setting above.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <button
          onClick={() => remote && setLocal(remote)}
          disabled={!isDirty || saving}
          className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface disabled:opacity-40"
        >
          Reset
        </button>
        <button
          onClick={handleSave}
          disabled={!isDirty || saving}
          className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  helper,
  value,
  onChange,
}: {
  label: string;
  helper: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label className="text-[13px] font-medium text-text-primary">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={365}
            // Rendering `String(value)` instead of `value` directly strips any
            // leading zero — typing "2" should never display as "02".
            value={String(value)}
            onChange={(e) => {
              const raw = e.target.value.replace(/^0+(?=\d)/, '');
              const n = parseInt(raw, 10);
              onChange(Number.isFinite(n) ? Math.max(0, Math.min(365, n)) : 0);
            }}
            className="w-20 rounded-md border border-border bg-white px-2 py-1 text-right text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          <span className="text-[12px] text-text-tertiary">
            {value === 0 ? 'immediately' : value === 1 ? 'day' : 'days'}
          </span>
        </div>
      </div>
      <p className="text-[11px] text-text-tertiary">{helper}</p>
    </div>
  );
}
