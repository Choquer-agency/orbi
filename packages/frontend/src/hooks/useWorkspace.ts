import { useQuery, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

// Team Hub entitlement probe. `undefined` = loading, `null` = this account
// has no team workspace (all team UI stays hidden — and the backend rejects
// the endpoints anyway; hiding is cosmetic, the server is the gate).
export function useMyWorkspace() {
  return useQuery(api.workspaces.myWorkspace, {});
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
