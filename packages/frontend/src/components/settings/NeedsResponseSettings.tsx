import { useEffect, useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { Inbox, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAccounts } from '../../hooks/useAccounts';

// Per-user controls for the Needs Response folder:
//   - Retention window: how far back the AI looks (default 45 days).
//   - Confidence threshold: minimum AI confidence to flag an email.
//   - Per-account filter: limit the folder to specific mailboxes.
//   - "Run rescore" button: re-evaluate every open signal under the
//     current settings (useful after lowering retention or raising the
//     threshold so the list reflects the change immediately).
interface SettingsState {
  retentionDays: number;
  confidenceFloor: number;
  perAccountFilter: Array<Id<'mailAccounts'>> | null;
}

export function NeedsResponseSettings() {
  const remote = useQuery(api.needsResponse.getSettings, {});
  const update = useMutation(api.needsResponse.updateSettings);
  const rescore = useMutation(api.needsResponse.rescoreAllOpen);
  const { data: accountsData } = useAccounts();
  const [local, setLocal] = useState<SettingsState | null>(null);
  const [saving, setSaving] = useState(false);
  const [rescoring, setRescoring] = useState(false);

  useEffect(() => {
    if (remote && !local) {
      setLocal({
        retentionDays: remote.retentionDays,
        confidenceFloor: remote.confidenceFloor,
        perAccountFilter: (remote.perAccountFilter ?? null) as
          | Array<Id<'mailAccounts'>>
          | null,
      });
    }
  }, [remote, local]);

  if (!local || !remote) {
    return <div className="text-[12px] text-text-tertiary">Loading…</div>;
  }

  const accounts = accountsData ?? [];
  const filterSet = new Set((local.perAccountFilter ?? []).map((id) => id as string));
  const isDirty =
    remote.retentionDays !== local.retentionDays ||
    remote.confidenceFloor !== local.confidenceFloor ||
    !shallowEqArr(
      (remote.perAccountFilter ?? null) as Array<Id<'mailAccounts'>> | null,
      local.perAccountFilter,
    );

  const handleSave = async () => {
    setSaving(true);
    try {
      await update({
        retentionDays: local.retentionDays,
        confidenceFloor: local.confidenceFloor,
        perAccountFilter:
          local.perAccountFilter === null || local.perAccountFilter.length === 0
            ? null
            : local.perAccountFilter,
      });
      toast.success('Settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleRescore = async () => {
    setRescoring(true);
    try {
      await rescore({});
      toast.success('Re-scoring all open emails…');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rescore');
    } finally {
      setRescoring(false);
    }
  };

  const toggleAccount = (id: Id<'mailAccounts'>) => {
    const cur = local.perAccountFilter ?? [];
    const has = filterSet.has(id as string);
    let next: Array<Id<'mailAccounts'>>;
    if (has) {
      next = cur.filter((x) => (x as string) !== (id as string));
    } else {
      next = [...cur, id];
    }
    setLocal({ ...local, perAccountFilter: next.length === 0 ? null : next });
  };

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <div className="mb-1 flex items-center gap-2">
          <Inbox className="h-4 w-4 text-text-tertiary" />
          <h2 className="text-[14px] font-semibold text-text-primary">
            Needs Response
          </h2>
        </div>
        <p className="text-[12px] leading-relaxed text-text-secondary">
          Controls how the AI decides which emails owe you a reply. Changes
          take effect on incoming mail immediately; click <span className="font-medium">Rescore now</span> below to also refresh the current list.
        </p>
      </header>

      <Field
        label="Retention window"
        helper="Anything older than this is considered out of scope — never flagged. Default 45 days."
        value={local.retentionDays}
        suffix={(v) => (v === 1 ? 'day' : 'days')}
        min={7}
        max={365}
        onChange={(v) => setLocal({ ...local, retentionDays: v })}
      />

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <label className="text-[13px] font-medium text-text-primary">
            Confidence threshold
          </label>
          <span className="rounded-md bg-surface px-2 py-0.5 text-[12px] font-medium text-text-primary">
            {local.confidenceFloor}
          </span>
        </div>
        <input
          type="range"
          min={20}
          max={90}
          step={5}
          value={local.confidenceFloor}
          onChange={(e) =>
            setLocal({
              ...local,
              confidenceFloor: parseInt(e.target.value, 10),
            })
          }
          className="w-full accent-primary"
        />
        <p className="text-[11px] text-text-tertiary">
          Only flag emails the AI is at least this confident about. Higher =
          fewer false positives but more chance of missing borderline asks.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <label className="text-[13px] font-medium text-text-primary">
            Mailboxes
          </label>
          {filterSet.size > 0 && (
            <button
              onClick={() => setLocal({ ...local, perAccountFilter: null })}
              className="text-[11px] text-text-tertiary hover:text-text-primary"
            >
              Show all
            </button>
          )}
        </div>
        <p className="text-[11px] text-text-tertiary">
          Limit the folder to specific accounts. Default is all connected mailboxes.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {accounts.map((a) => {
            const id = a.id as Id<'mailAccounts'>;
            const active = filterSet.size === 0 || filterSet.has(id as string);
            return (
              <button
                key={a.id as string}
                onClick={() => toggleAccount(id)}
                className={
                  'rounded-full border px-2.5 py-1 text-[11px] transition-colors ' +
                  (active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-surface text-text-tertiary hover:text-text-primary')
                }
              >
                {a.displayName || a.email}
              </button>
            );
          })}
          {accounts.length === 0 && (
            <span className="text-[11px] text-text-tertiary">
              No mailboxes connected.
            </span>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface/40 p-3">
        <div className="mb-1 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-text-tertiary" />
          <span className="text-[12px] font-medium text-text-primary">
            Re-score the current list
          </span>
        </div>
        <p className="mb-2 text-[11px] text-text-tertiary">
          Runs the AI over every email currently in Needs Response with these
          settings. Emails that fall below the new threshold or outside the
          retention window will be removed.
        </p>
        <button
          onClick={handleRescore}
          disabled={rescoring}
          className="rounded-lg bg-surface px-3 py-1 text-[12px] font-medium text-text-primary transition-colors hover:bg-surface/70 disabled:opacity-50"
        >
          {rescoring ? 'Queued…' : 'Rescore now'}
        </button>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <button
          onClick={() =>
            remote &&
            setLocal({
              retentionDays: remote.retentionDays,
              confidenceFloor: remote.confidenceFloor,
              perAccountFilter: (remote.perAccountFilter ?? null) as
                | Array<Id<'mailAccounts'>>
                | null,
            })
          }
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

function shallowEqArr<T>(a: T[] | null, b: T[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  const sa = new Set(a as unknown as string[]);
  for (const x of b as unknown as string[]) if (!sa.has(x)) return false;
  return true;
}

function Field({
  label,
  helper,
  value,
  suffix,
  min,
  max,
  onChange,
}: {
  label: string;
  helper: string;
  value: number;
  suffix: (v: number) => string;
  min: number;
  max: number;
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
            min={min}
            max={max}
            value={String(value)}
            onChange={(e) => {
              const raw = e.target.value.replace(/^0+(?=\d)/, '');
              const n = parseInt(raw, 10);
              onChange(Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min);
            }}
            className="w-20 rounded-md border border-border bg-white px-2 py-1 text-right text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          <span className="text-[12px] text-text-tertiary">{suffix(value)}</span>
        </div>
      </div>
      <p className="text-[11px] text-text-tertiary">{helper}</p>
    </div>
  );
}
