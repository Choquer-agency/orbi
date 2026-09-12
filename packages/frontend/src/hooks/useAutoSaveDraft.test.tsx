// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoSaveDraft } from './useAutoSaveDraft';

const { save, discard } = vi.hoisted(() => ({ save: vi.fn(), discard: vi.fn() }));
vi.mock('./useDrafts', () => ({
  useSaveDraft: () => ({ mutateAsync: save }),
  useDeleteDraft: () => ({ mutateAsync: discard, mutate: discard }),
}));

const options = { accountId: 'account', mode: 'reply' as const, enabled: true };
const fields = { bodyText: 'The reply', toAddresses: [{ email: 'andres@example.com' }] };
function pendingCreate() {
  let resolve!: (value: { data: { id: string } }) => void;
  save.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  return () => resolve({ data: { id: 'draft-1' } });
}

beforeEach(() => {
  save.mockReset().mockResolvedValue({ data: { id: 'draft-1' } });
  discard.mockReset().mockResolvedValue({ data: { success: true } });
});
afterEach(cleanup);

describe('draft autosave and send lifecycle', () => {
  it('updates the first draft when another save arrives before creation finishes', async () => {
    const finish = pendingCreate();
    const { result } = renderHook(() => useAutoSaveDraft(options));
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => { first = result.current.saveDraft(fields); });
    await act(async () => { second = result.current.saveDraft({ ...fields, bodyText: 'Latest reply' }); });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await Promise.all([first, second]); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({ id: 'draft-1', bodyText: 'Latest reply' });
    expect(result.current.draftId).toBe('draft-1');
    expect(result.current.isSaving).toBe(false);
  });

  it('waits for an in-flight draft and blocks background saves throughout sending', async () => {
    const finish = pendingCreate();
    const { result, unmount } = renderHook(() => useAutoSaveDraft(options));
    await act(async () => { void result.current.saveDraft(fields); });
    let sending!: Promise<string | null>;
    await act(async () => {
      sending = result.current.prepareForSend();
      await result.current.saveDraft(fields);
    });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); expect(await sending).toBe('draft-1'); });
    await act(async () => {
      expect(await result.current.markSent()).toBe(true);
      await result.current.saveDraft(fields);
    });
    unmount();
    expect(discard).toHaveBeenCalledExactlyOnceWith('draft-1');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('resumes saving into the same draft after a failed send', async () => {
    const { result } = renderHook(() => useAutoSaveDraft({ ...options, existingDraftId: 'saved' }));
    await act(async () => { await result.current.prepareForSend(); });
    await act(async () => {
      result.current.resumeAfterSendFailure();
      await result.current.saveDraft(fields);
    });
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'saved' }));
    expect(discard).not.toHaveBeenCalled();
  });

  it('discards a draft whose creation finishes after Delete was clicked', async () => {
    const finish = pendingCreate();
    const { result } = renderHook(() => useAutoSaveDraft(options));
    await act(async () => { void result.current.saveDraft(fields); });
    let deleting!: Promise<void>;
    await act(async () => { deleting = result.current.deleteDraft(); });
    await act(async () => { finish(); await deleting; });
    expect(discard).toHaveBeenCalledExactlyOnceWith('draft-1');
    expect(result.current.draftId).toBeNull();
  });

  it('does not restart autosave when draft cleanup fails after a successful send', async () => {
    discard.mockRejectedValueOnce(new Error('Offline'));
    const { result } = renderHook(() => useAutoSaveDraft({ ...options, existingDraftId: 'saved' }));
    await act(async () => {
      await result.current.prepareForSend();
      expect(await result.current.markSent()).toBe(false);
      result.current.resumeAfterSendFailure();
      await result.current.saveDraft(fields);
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('preserves an existing draft when the composer closes without editing it', () => {
    const { unmount } = renderHook(() => useAutoSaveDraft({ ...options, existingDraftId: 'saved' }));
    unmount();
    expect(discard).not.toHaveBeenCalled();
  });

  it('does not create a draft merely from prefilled reply recipients', async () => {
    const { result } = renderHook(() => useAutoSaveDraft(options));
    await act(async () => { await result.current.saveDraft({ ...fields, bodyText: '' }); });
    expect(save).not.toHaveBeenCalled();
  });
});
