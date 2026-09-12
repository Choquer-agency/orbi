import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAction, useQuery } from 'convex/react';
import { ArrowRight, Check, ExternalLink, Link2, Loader2, Paperclip, Plus, Ticket, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import type { Directory, PreparedWorkflow, TicketProposal, CreatedTicket } from '../../../../../convex/clientWorkflow';
import { useUiStore } from '../../stores/uiStore';
import { useAccounts } from '../../hooks/useAccounts';
import { cn } from '../../lib/utils';

type Proposal = TicketProposal & { selected: boolean };
const field = 'w-full rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/10';
function message(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
export function ticketReplyPrompt(tickets: CreatedTicket[]) {
  return `Help me reply to this client confirming that we have created the following tickets and expect to complete them by these dates. Use the original email for context. Only include the confirmed tickets below. Describe these as planned completion dates, and do not say the work is already finished. Create a reply draft for me to review.\n\n${tickets.map(t => `• ${t.number}: ${t.title} — ${t.dueDate ? `planned completion ${t.dueDate}` : 'date to be confirmed'}`).join('\n')}\n\nAdditional notes:\n`;
}
function Shell({ title, description, children, busy }: { title: string; description: string; children: React.ReactNode; busy: boolean }) {
  return <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[100] bg-slate-950/30 backdrop-blur-sm" /><Dialog.Content onEscapeKeyDown={e => { if (busy) e.preventDefault(); }} onPointerDownOutside={e => { if (busy) e.preventDefault(); }} className="fixed left-1/2 top-1/2 z-[101] flex max-h-[88vh] w-[min(760px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-2xl">
    <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5"><div><Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-text-primary"><Ticket className="h-5 w-5 text-primary" />{title}</Dialog.Title><Dialog.Description className="mt-1.5 text-xs leading-relaxed text-text-secondary">{description}</Dialog.Description></div><Dialog.Close disabled={busy} aria-label="Close" className="rounded-lg p-1.5 text-text-tertiary hover:bg-surface disabled:opacity-30"><X className="h-4 w-4" /></Dialog.Close></div>
    {children}
  </Dialog.Content></Dialog.Portal>;
}

export function TicketWorkflow({ threadId }: { threadId: string }) {
  const prepare = useAction(api.clientWorkflow.prepare);
  const extract = useAction(api.clientWorkflow.extract);
  const create = useAction(api.clientWorkflow.createTickets);
  const download = useAction(api.emails.downloadAttachment);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'loading' | 'extracting' | 'creating' | null>(null);
  const [prepared, setPrepared] = useState<PreparedWorkflow | null>(null);
  const [clientId, setClientId] = useState('');
  const [items, setItems] = useState<Proposal[]>([]);
  const [tickets, setTickets] = useState<CreatedTicket[]>([]);
  const [summary, setSummary] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [analyzed, setAnalyzed] = useState(false);
  const generation = useRef(0);
  const start = async () => {
    const run = ++generation.current;
    setOpen(true); setBusy('loading'); setError(''); setPrepared(null); setItems([]); setTickets([]); setSummary(''); setWarnings([]); setAnalyzed(false);
    try {
      const result = await prepare({ threadId: threadId as Id<'threads'> });
      if (run !== generation.current) return;
      setPrepared(result); setClientId(result.context.clientId ?? ''); setTickets(result.tickets);
      if (!result.tickets.length && result.context.clientId) await analyze(result, result.context.clientId, run);
    } catch (e) { if (run === generation.current) setError(message(e)); }
    finally { if (run === generation.current) setBusy(null); }
  };
  const analyze = async (data: PreparedWorkflow, client: string, run = generation.current) => {
    setBusy('extracting'); setError('');
    try {
      const result = await extract({ threadId: data.context.threadId, sourceEmailId: data.context.sourceEmailId, clientId: client });
      if (run !== generation.current) return;
      if (result.tickets) { setTickets(result.tickets); return; }
      setItems((result.items ?? []).map(item => ({ ...item, selected: true })));
      setSummary(result.summary ?? ''); setWarnings(result.warnings ?? []); setAnalyzed(true);
    } catch (e) { if (run === generation.current) setError(message(e)); }
    finally { if (run === generation.current) setBusy(null); }
  };
  const update = (key: string, patch: Partial<Proposal>) => setItems(current => current.map(item => item.key === key ? { ...item, ...patch } : item));
  const handoff = (created: CreatedTicket[]) => {
    useUiStore.getState().setTicketChatPrompt({ threadId, text: ticketReplyPrompt(created) });
    setOpen(false); generation.current++;
  };
  const approve = async () => {
    if (!prepared) return;
    setBusy('creating'); setError('');
    try {
      const result = await create({ threadId: prepared.context.threadId, sourceEmailId: prepared.context.sourceEmailId, clientId,
        items: items.filter(item => item.selected).map(({ key: _key, selected: _selected, ...item }) => item) });
      setTickets(result.tickets);
      handoff(result.tickets);
      toast.success(`${result.tickets.length} ticket${result.tickets.length === 1 ? '' : 's'} created. Add your reply notes in Orbi.`);
    } catch (e) { setError(message(e)); }
    finally { setBusy(null); }
  };
  const selected = items.filter(item => item.selected);
  const valid = selected.length > 0 && selected.every(item => item.title.trim() && item.assigneeId && item.dueDate);
  return <Dialog.Root open={open} onOpenChange={value => { if (busy === 'creating') return; setOpen(value); if (!value) generation.current++; }}>
    <button onClick={() => void start()} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"><Ticket className="h-3.5 w-3.5" /><span>Create tickets</span></button>
    <Shell title={tickets.length ? 'Tickets already created' : 'Turn requests into tickets'} description="Review each request, choose who owns it, and confirm the dates. Then prepare your client reply in Orbi." busy={busy === 'creating'}>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {error && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">{error}{!prepared && <button onClick={() => void start()} className="ml-2 font-semibold underline">Retry</button>}</div>}
        {busy === 'loading' && <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-text-secondary"><Loader2 className="h-4 w-4 animate-spin text-primary" />Connecting to Choquer…</div>}
        {prepared && <>
          <div className="mb-5 rounded-xl bg-surface p-4"><p className="truncate text-xs font-semibold text-text-primary">{prepared.context.subject}</p><p className="mt-1 text-[11px] text-text-secondary">From {prepared.context.senderName || prepared.context.sender}</p>
            {prepared.context.contextTruncated && <p className="mt-2 text-xs text-amber-800">Using the latest email and 19 earlier messages. Review older messages separately for additional context.</p>}
          </div>
          {tickets.length ? <div className="space-y-2">{tickets.map(ticket => <div key={ticket.id} className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4"><Check className="mt-0.5 h-4 w-4 text-emerald-600" /><div className="flex-1"><p className="text-xs text-text-secondary">{ticket.number}</p><p className="mt-1 text-sm font-semibold text-text-primary">{ticket.title}</p><p className="mt-1 text-xs text-text-secondary">Planned completion {ticket.dueDate ?? 'to be confirmed'}</p></div></div>)}</div> : <>
            <label className="mb-1.5 block text-[11px] font-semibold text-text-secondary" htmlFor="ticket-client">Client</label>
            <select id="ticket-client" value={clientId} disabled={!!busy} onChange={e => { setClientId(e.target.value); setItems([]); setAnalyzed(false); setSummary(''); setWarnings([]); }} className={field}><option value="">Choose a client…</option>{prepared.directory.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select>
            {!analyzed && !busy && <button disabled={!clientId} onClick={() => void analyze(prepared, clientId)} className="mt-3 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">Find requests in this email</button>}
            {busy === 'extracting' && <div role="status" className="flex items-center gap-2 py-10 text-sm text-text-secondary"><Loader2 className="h-4 w-4 animate-spin text-primary" />Reading the email and images…</div>}
            {summary && <p className="mt-4 text-xs leading-relaxed text-text-secondary">{summary}</p>}
            {warnings.length > 0 && <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><p className="font-semibold">Check these attachments for extra requests</p><ul className="mt-2 space-y-1">{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
            {analyzed && <div className="mb-3 mt-6 flex items-center justify-between"><p className="text-xs font-semibold text-text-primary">{selected.length} of {items.length} requests selected</p><button onClick={() => setItems(current => current.map(item => ({ ...item, selected: selected.length !== items.length })))} className="text-xs font-medium text-primary">{selected.length === items.length ? 'Deselect all' : 'Select all'}</button></div>}
            <div className="space-y-4">{items.map((item, index) => <section key={item.key} className={cn('rounded-xl border p-4', item.selected ? 'border-primary/20 bg-white' : 'border-border bg-surface/60')}>
              <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs font-semibold text-text-secondary"><input type="checkbox" checked={item.selected} onChange={e => update(item.key, { selected: e.target.checked })} className="h-4 w-4 accent-primary" />Request {index + 1}<span className="ml-auto text-[10px] font-normal text-text-tertiary">{item.selected ? 'Will create' : 'Skipped'}</span></label>
              <div className="space-y-3"><label className="block"><span className="mb-1 block text-[11px] text-text-secondary">Title</span><input aria-label={`Ticket ${index + 1} title`} value={item.title} maxLength={250} onChange={e => update(item.key, { title: e.target.value })} className={field} /></label>
                <label className="block"><span className="mb-1 block text-[11px] text-text-secondary">Description</span><textarea value={item.description} maxLength={40000} onChange={e => update(item.key, { description: e.target.value })} rows={5} className={cn(field, 'resize-y leading-relaxed')} /></label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label><span className="mb-1 block text-[11px] text-text-secondary">Assign to</span><select value={item.assigneeId} onChange={e => update(item.key, { assigneeId: e.target.value })} className={field}><option value="">Choose a specialist…</option>{prepared.directory.team.map(member => <option key={member.id} value={member.id}>{member.name}{member.role ? ` · ${member.role}` : ''}</option>)}</select></label><label><span className="mb-1 block text-[11px] text-text-secondary">Planned completion</span><input type="date" value={item.dueDate} onChange={e => update(item.key, { dueDate: e.target.value })} className={field} /></label></div>
                {prepared.context.attachments.length > 0 && <div className="rounded-lg bg-surface p-3"><p className="mb-2 flex items-center gap-1 text-[11px] font-medium text-text-secondary"><Paperclip className="h-3 w-3" />Attachments to include</p>{prepared.context.attachments.map(file => <div key={file.id} className="flex items-center justify-between gap-2 py-1"><label className="flex min-w-0 items-center gap-2 text-[11px] text-text-secondary"><input type="checkbox" checked={item.attachmentIds.includes(file.id)} onChange={e => update(item.key, { attachmentIds: e.target.checked ? [...item.attachmentIds, file.id] : item.attachmentIds.filter(id => id !== file.id) })} className="accent-primary" /><span className="truncate">{file.filename}</span></label><button aria-label={`View ${file.filename}`} onClick={async () => { const popup = window.open('about:blank', '_blank'); try { const result = await download({ attachmentId: file.id }); if (popup) popup.location.href = result.url; else window.open(result.url, '_blank', 'noopener,noreferrer'); } catch (e) { popup?.close(); toast.error(message(e)); } }} className="rounded p-1 text-primary"><ExternalLink className="h-3 w-3" /></button></div>)}</div>}
              </div>
            </section>)}</div>
            {analyzed && items.length === 0 && <p className="py-6 text-center text-sm text-text-secondary">No actionable requests found. You can add a ticket yourself.</p>}
            {analyzed && <button disabled={items.length >= 30 || !!busy} onClick={() => setItems(current => [...current, { key: crypto.randomUUID(), title: '', description: '', assigneeId: prepared.directory.clients.find(c => c.id === clientId)?.specialistId ?? '', dueDate: '', priority: 'normal', attachmentIds: prepared.context.attachments.map(a => a.id), selected: true }])} className="mt-4 flex items-center gap-1 text-xs font-semibold text-primary"><Plus className="h-3.5 w-3.5" />Add a missed request</button>}
          </>}
        </>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface/50 px-6 py-4"><p className="max-w-xs text-[11px] leading-relaxed text-text-secondary">{tickets.length ? 'Use the confirmed tickets to prepare your reply.' : 'Dates are estimates. Check your team’s availability before approving.'}</p><button disabled={!!busy || (!tickets.length && !valid)} onClick={() => tickets.length ? handoff(tickets) : void approve()} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-40">{busy === 'creating' ? <><Loader2 className="h-4 w-4 animate-spin" />Creating tickets…</> : <>{tickets.length ? 'Prepare reply in Orbi' : `Create ${selected.length} ticket${selected.length === 1 ? '' : 's'} & prepare reply`}<ArrowRight className="h-3.5 w-3.5" /></>}</button></div>
    </Shell>
  </Dialog.Root>;
}

export function ClientTools({ threadId, emails, accountId }: { threadId: string; accountId: string; emails: Array<{ fromAddress: string; fromName?: string | null }> }) {
  const available = useQuery(api.clients.status, {});
  const { data: accounts } = useAccounts();
  const load = useAction(api.clientWorkflow.directory);
  const link = useAction(api.clientWorkflow.linkSender);
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [email, setEmail] = useState('');
  const [client, setClient] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const own = new Set((accounts ?? []).flatMap(a => [a.email.toLowerCase(), ...(a.aliases ?? []).map((s: string) => s.toLowerCase())]));
  const senders = [...new Map(emails.filter(e => !own.has(e.fromAddress.toLowerCase())).map(e => [e.fromAddress.toLowerCase(), e])).values()].reverse();
  if (!available || !(accounts ?? []).some(a => a.id === accountId)) return null;
  return <><TicketWorkflow key={threadId} threadId={threadId} /><Dialog.Root open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
    <button title="Link sender to client" aria-label="Link sender to client" onClick={async () => { setOpen(true); setEmail(senders[0]?.fromAddress ?? ''); setClient(''); setError(''); setBusy(true); try { setDirectory(await load({})); } catch (e) { setError(message(e)); } finally { setBusy(false); } }} className="rounded-lg p-2 text-text-tertiary hover:bg-primary/5 hover:text-primary"><Link2 className="h-4 w-4" /></button>
    <Shell title="Link sender to client" description="Save this person’s exact email with a client in Choquer. Everyone on the team will recognize them in Clients." busy={busy}>
      <div className="space-y-4 p-6">{error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        <label className="block"><span className="mb-1.5 block text-xs font-medium text-text-secondary">Person</span><select className={field} value={email} onChange={e => setEmail(e.target.value)}>{senders.map(s => <option key={s.fromAddress} value={s.fromAddress}>{s.fromName ? `${s.fromName} — ` : ''}{s.fromAddress}</option>)}</select></label>
        <label className="block"><span className="mb-1.5 block text-xs font-medium text-text-secondary">Client</span><select disabled={busy} className={field} value={client} onChange={e => setClient(e.target.value)}><option value="">{busy ? 'Loading…' : 'Choose a company…'}</option>{directory?.clients.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
        <button disabled={busy || !email || !client} onClick={async () => { setBusy(true); setError(''); try { await link({ email, name: senders.find(s => s.fromAddress === email)?.fromName ?? undefined, clientId: client }); setOpen(false); toast.success('Sender linked to client for your team'); } catch (e) { setError(message(e)); } finally { setBusy(false); } }} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">{busy && <Loader2 className="h-3 w-3 animate-spin" />}Save client contact</button>
      </div>
    </Shell>
  </Dialog.Root></>;
}
