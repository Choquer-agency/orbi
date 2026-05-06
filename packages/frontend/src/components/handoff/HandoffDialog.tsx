import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRightLeft, X, Loader2 } from 'lucide-react';
import { useCreateHandoff } from '../../hooks/useHandoffs';

interface HandoffDialogProps {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamMembers: { id: string; name: string; email: string }[];
}

export function HandoffDialog({ threadId, open, onOpenChange, teamMembers }: HandoffDialogProps) {
  const [selectedUserId, setSelectedUserId] = useState('');
  const [note, setNote] = useState('');
  const [transferFollowUps, setTransferFollowUps] = useState(true);
  const createMutation = useCreateHandoff();

  const handleSubmit = () => {
    if (!selectedUserId) return;
    createMutation.mutate(
      { threadId, toUserId: selectedUserId, note: note || undefined, transferFollowUps },
      {
        onSuccess: () => {
          onOpenChange(false);
          setSelectedUserId('');
          setNote('');
        },
      },
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 animate-in fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface p-6 shadow-xl animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-primary" />
            <Dialog.Title className="text-lg font-semibold text-text-primary">
              Hand Off Thread
            </Dialog.Title>
          </div>

          <div className="mt-4 space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">
                Transfer to
              </label>
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">Select a team member...</option>
                {teamMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name} ({member.email})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">
                Handoff note (optional)
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Any context the recipient should know..."
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                rows={3}
              />
            </div>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={transferFollowUps}
                onChange={(e) => setTransferFollowUps(e.target.checked)}
                className="rounded border-border text-primary focus:ring-primary"
              />
              <span className="text-sm text-text-secondary">Transfer active follow-up watches</span>
            </label>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={handleSubmit}
              disabled={!selectedUserId || createMutation.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Hand Off
            </button>
          </div>

          <Dialog.Close asChild>
            <button className="absolute right-4 top-4 rounded-lg p-1 text-text-tertiary hover:bg-surface">
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
