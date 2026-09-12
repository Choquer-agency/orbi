// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { TicketWorkflow } from './TicketWorkflow';
import { useUiStore } from '../../stores/uiStore';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), extract: vi.fn(), create: vi.fn() }));
vi.mock('convex/react', () => ({
  useAction: (ref: Parameters<typeof getFunctionName>[0]) => ({ 'clientWorkflow:prepare': mocks.prepare, 'clientWorkflow:extract': mocks.extract, 'clientWorkflow:createTickets': mocks.create }[getFunctionName(ref)] ?? vi.fn()),
  useQuery: vi.fn(),
}));
vi.mock('../../hooks/useAccounts', () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
const context = { threadId: 'thread123', sourceEmailId: 'source123', sourceKey: '<source@example.com>', subject: 'Two website requests', sender: 'steve@abc.test', senderName: 'Steve', clientId: 'abc', attachments: [], contextTruncated: false };
const proposal = { key: '1', title: 'Create services page', description: 'Create the new services page.', assigneeId: 'alex', dueDate: '2026-09-18', priority: 'normal', attachmentIds: [] };
const created = { id: 't1', number: 'CHQ-001', title: proposal.title, dueDate: proposal.dueDate, url: 'https://choquer.app/admin/tickets?ticket=t1' };
beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ ticketChatPrompt: null });
  mocks.prepare.mockResolvedValue({ directory: { clients: [{ id: 'abc', name: 'ABC' }], team: [{ id: 'alex', name: 'Alex', role: 'Developer' }, { id: 'sam', name: 'Sam', role: 'Designer' }] }, context, tickets: [] });
  mocks.extract.mockResolvedValue({ summary: 'Two independent requests.', items: [proposal, { ...proposal, key: '2', title: 'Update homepage' }], warnings: [] });
  mocks.create.mockResolvedValue({ tickets: [created] });
});
afterEach(cleanup);
describe('review tickets before creating', () => {
  it('sends only approved tickets, preserves edits, and hands confirmed results to an editable chat prompt', async () => {
    render(<TicketWorkflow threadId="thread123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create tickets' }));
    await screen.findByDisplayValue('Update homepage');
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.change(screen.getByLabelText('Ticket 1 title'), { target: { value: 'Create new services page' } });
    fireEvent.change(screen.getAllByLabelText('Assign to')[0], { target: { value: 'sam' } });
    fireEvent.change(screen.getAllByLabelText('Planned completion')[0], { target: { value: '2026-09-21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create 1 ticket & prepare reply' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ sourceEmailId: 'source123', clientId: 'abc', items: [{ title: 'Create new services page', assigneeId: 'sam', dueDate: '2026-09-21' }] });
    expect(mocks.create.mock.calls[0][0].items).toHaveLength(1);
    await waitFor(() => expect(useUiStore.getState().ticketChatPrompt?.text).toContain('CHQ-001'));
    expect(useUiStore.getState().ticketChatPrompt?.text).toContain('Additional notes:');
    expect(useUiStore.getState().ticketChatPrompt?.text).not.toContain('Update homepage');
  });
  it('shows prior tickets without extracting or creating them again', async () => {
    mocks.prepare.mockResolvedValue({ directory: { clients: [], team: [] }, context, tickets: [created] });
    render(<TicketWorkflow threadId="thread123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create tickets' }));
    await screen.findByText('Tickets already created');
    expect(mocks.extract).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare reply in Orbi' }));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(useUiStore.getState().ticketChatPrompt?.text).toContain('CHQ-001');
  });
  it('preserves the review after a failed creation and never claims tickets were created', async () => {
    mocks.create.mockRejectedValue(new Error('ERP temporarily unavailable'));
    render(<TicketWorkflow threadId="thread123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create tickets' }));
    await screen.findByDisplayValue('Update homepage');
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 tickets & prepare reply' }));
    await screen.findByRole('alert');
    expect(screen.getByDisplayValue('Update homepage')).toBeTruthy();
    expect(useUiStore.getState().ticketChatPrompt).toBeNull();
  });
  it('requires a client choice before analyzing an unknown sender', async () => {
    const data = await mocks.prepare();
    mocks.prepare.mockResolvedValue({ ...data, context: { ...context, clientId: null } });
    render(<TicketWorkflow threadId="thread123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create tickets' }));
    const button = await screen.findByRole('button', { name: 'Find requests in this email' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.extract).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'abc' } });
    await act(async () => fireEvent.click(button));
    expect(mocks.extract).toHaveBeenCalledWith({ threadId: 'thread123', sourceEmailId: 'source123', clientId: 'abc' });
  });
});
