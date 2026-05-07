import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

interface ScheduledEmail {
  id: string;
  userId: string;
  accountId: string;
  threadId: string | null;
  parentEmailId: string | null;
  mode: string;
  toAddresses: { email: string; name?: string }[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  sendAt: string;
  status: string;
  cancelledAt: string | null;
  createdAt: string;
  account?: { email: string; displayName: string | null };
}

// ─── Helpers ──────────────────────────────────────────────────

function toIso(ts: number | string | null | undefined): string | null {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'string') return ts;
  return new Date(ts).toISOString();
}

function shapeRow(row: {
  _id: string;
  userId: string;
  accountId: string;
  threadId?: string | null;
  parentEmailId?: string | null;
  mode: string;
  toAddresses: { email: string; name?: string }[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  sendAt: number;
  status: string;
  cancelledAt?: number | null;
  _creationTime: number;
  account?: { email: string; displayName: string | null } | null;
}): ScheduledEmail {
  return {
    id: row._id,
    userId: row.userId,
    accountId: row.accountId,
    threadId: row.threadId ?? null,
    parentEmailId: row.parentEmailId ?? null,
    mode: row.mode,
    toAddresses: row.toAddresses,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    sendAt: toIso(row.sendAt) ?? '',
    status: row.status,
    cancelledAt: toIso(row.cancelledAt ?? null),
    createdAt: toIso(row._creationTime) ?? '',
    account: row.account
      ? { email: row.account.email, displayName: row.account.displayName }
      : undefined,
  };
}

// ─── Queries ──────────────────────────────────────────────────

export function useScheduledEmails(status?: string) {
  const data = useQuery(
    api.scheduledEmails.list,
    status ? { status } : {},
  );
  return {
    data: data ? data.map((r) => shapeRow(r as never)) : undefined,
    isLoading: data === undefined,
  };
}

export function useThreadScheduledEmails(threadId: string | null | undefined) {
  const { data: all } = useScheduledEmails();
  if (!threadId || !all) return [];
  return all.filter(
    (e) =>
      e.threadId === threadId &&
      (e.status === 'SCHEDULED' || e.status === 'SENDING'),
  );
}

// ─── Mutations ────────────────────────────────────────────────

export function useCreateScheduledEmail() {
  const fn = useMutation(api.scheduledEmails.create);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (data: {
    accountId: string;
    threadId?: string;
    parentEmailId?: string;
    mode?: string;
    to: { email: string; name?: string }[];
    cc?: { email: string; name?: string }[];
    bcc?: { email: string; name?: string }[];
    subject: string;
    bodyHtml: string;
    bodyText: string;
    sendAt: string;
  }) => {
    setIsPending(true);
    try {
      const result = await fn({
        accountId: data.accountId as Id<'mailAccounts'>,
        threadId: data.threadId
          ? (data.threadId as Id<'threads'>)
          : undefined,
        parentEmailId: data.parentEmailId,
        mode: data.mode,
        to: data.to,
        cc: data.cc,
        bcc: data.bcc,
        subject: data.subject,
        bodyHtml: data.bodyHtml,
        bodyText: data.bodyText,
        sendAt: new Date(data.sendAt).getTime(),
      });
      return { data: result ? shapeRow(result as never) : null };
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useCancelScheduledEmail() {
  const fn = useMutation(api.scheduledEmails.cancel);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (id: string) => {
    setIsPending(true);
    try {
      return await fn({ id: id as Id<'scheduledEmails'> });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useUpdateScheduledEmail() {
  const fn = useMutation(api.scheduledEmails.update);
  const [isPending, setIsPending] = useState(false);
  const mutate = async ({
    id,
    sendAt,
    subject,
    bodyHtml,
    bodyText,
    to,
  }: {
    id: string;
    sendAt?: string;
    subject?: string;
    bodyHtml?: string;
    bodyText?: string;
    to?: { email: string; name?: string }[];
  }) => {
    setIsPending(true);
    try {
      return await fn({
        id: id as Id<'scheduledEmails'>,
        sendAt: sendAt ? new Date(sendAt).getTime() : undefined,
        subject,
        bodyHtml,
        bodyText,
        to,
      });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

/**
 * "Send now" — patches the row's `sendAt` to ~now so the scheduler fires
 * immediately (`scheduledEmails.dispatchOne` then hands off to
 * `internal.emails.actuallySend`). Mirrors the prior REST `/send-now` shape.
 */
export function useSendScheduledNow() {
  const fn = useMutation(api.scheduledEmails.update);
  const [isPending, setIsPending] = useState(false);
  const mutate = async ({
    id,
  }: {
    id: string;
    undoWindowSeconds?: number;
  }) => {
    setIsPending(true);
    try {
      const result = await fn({
        id: id as Id<'scheduledEmails'>,
        sendAt: Date.now() + 250,
      });
      return {
        data: {
          id,
          threadId: (result?.threadId as string | undefined) ?? '',
          undoDeadlineAt: null,
        },
      };
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}
