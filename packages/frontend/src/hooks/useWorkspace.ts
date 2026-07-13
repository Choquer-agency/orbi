import { useEffect, useState } from 'react';
import { useQuery, useMutation, useConvex } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

type MyWorkspace =
  | {
      id: string;
      name: string;
      features: string[];
      ownerUserId: string;
      viewerId: string;
      viewerIsOwner: boolean;
      members: Array<{
        id: string;
        name: string | null;
        email: string | null;
        avatarUrl: string | null;
        role: string;
        managerUserId: string | null;
        canView: boolean;
        isSelf: boolean;
      }>;
    }
  | null;

// Team Hub entitlement probe. `undefined` = loading, `null` = this account
// has no team workspace (all team UI stays hidden — and the backend rejects
// the endpoints anyway; hiding is cosmetic, the server is the gate).
//
// Built on watchQuery instead of useQuery so a failure — most importantly a
// frontend that's newer than the deployed backend — degrades to `null`
// (no team UI) instead of throwing into the app's error boundary and
// taking the whole window down.
export function useMyWorkspace(): MyWorkspace | undefined {
  const convex = useConvex();
  const [value, setValue] = useState<MyWorkspace | undefined>(undefined);
  useEffect(() => {
    const watch = convex.watchQuery(api.workspaces.myWorkspace, {});
    const read = () => {
      try {
        const result = watch.localQueryResult();
        if (result !== undefined) setValue(result as MyWorkspace);
      } catch (err) {
        console.warn('[teamHub] workspace probe failed — hiding team UI', err);
        setValue(null);
      }
    };
    read();
    return watch.onUpdate(read);
  }, [convex]);
  return value;
}

export function useCommitmentsDashboard(args: {
  status: 'OPEN' | 'COMPLETED' | 'DISMISSED';
  memberUserId?: Id<'users'>;
  page?: number;
  enabled: boolean;
}) {
  const { enabled, ...rest } = args;
  return useQuery(
    api.commitments.dashboard,
    enabled
      ? {
          status: rest.status,
          ...(rest.memberUserId ? { memberUserId: rest.memberUserId } : {}),
          ...(rest.page ? { page: rest.page } : {}),
        }
      : 'skip',
  );
}

export function useTrackingAccounts(enabled: boolean) {
  return useQuery(api.workspaces.trackingAccounts, enabled ? {} : 'skip');
}

export function useSetManager() {
  return useMutation(api.workspaces.setManager);
}

export function useSetCommitmentTracking() {
  return useMutation(api.workspaces.setCommitmentTracking);
}

export function useCompleteCommitment() {
  return useMutation(api.commitments.complete);
}

export function useReopenCommitment() {
  return useMutation(api.commitments.reopen);
}

export function useDismissCommitment() {
  return useMutation(api.commitments.dismiss);
}
