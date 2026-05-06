import { useState, useCallback } from 'react';
import { Search, User, ChevronRight, Check, Copy, ArrowUpDown, ChevronUp, ChevronDown, MoreHorizontal, ChevronDown as ExpandIcon, Merge, Unlink, Mail } from 'lucide-react';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import * as Avatar from '@radix-ui/react-avatar';
import { usePersons, useMergePersons, useUnlinkContact } from '../../hooks/usePersons';
import { useUiStore } from '../../stores/uiStore';
import { getAvatarColor } from '../../lib/constants';
import { cn, getInitials } from '../../lib/utils';
import { ContactCard } from './ContactCard';
import { NavigationDropdown } from '../navigation/NavigationDropdown';
import toast from 'react-hot-toast';

type SortField = 'name' | 'email' | 'company' | 'emailCount' | 'lastEmailed';
type SortDir = 'asc' | 'desc';

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function CopyCell({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success('Copied!', { duration: 1200, style: { fontSize: '12px', padding: '6px 12px' } });
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="group/copy inline-flex max-w-full items-center gap-1 truncate text-left hover:text-primary transition-colors"
      title={`Click to copy: ${value}`}
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-green-500" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 text-text-tertiary opacity-0 group-hover/copy:opacity-100 transition-opacity" />
      )}
    </button>
  );
}

function SortHeader({ label, field, sortField, sortDir, onSort }: {
  label: string;
  field: SortField;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
}) {
  const active = sortField === field;
  return (
    <button
      onClick={() => onSort(field)}
      className={cn(
        'inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider transition-colors',
        active ? 'text-primary' : 'text-text-tertiary hover:text-text-secondary',
      )}
    >
      {label}
      {active ? (
        sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-0 group-hover:opacity-50" />
      )}
    </button>
  );
}

/** Full-width person-grouped contacts table */
export function ContactsTable() {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [cardContact, setCardContact] = useState<any | null>(null);
  const [cardAnchor, setCardAnchor] = useState<DOMRect | null>(null);
  const [cardEditing, setCardEditing] = useState(false);
  const [expandedPersonIds, setExpandedPersonIds] = useState<Set<string>>(new Set());
  const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set());

  const { setSelectedPerson } = useUiStore();
  const { data, isLoading } = usePersons({ q: searchQuery, limit: 500 });
  const mergePersons = useMergePersons();
  const unlinkContact = useUnlinkContact();
  const persons = data?.data ?? [];

  const sorted = [...persons].sort((a: any, b: any) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortField) {
      case 'name': return dir * (a.displayName || '').localeCompare(b.displayName || '');
      case 'email': return dir * (a.primaryEmail || '').localeCompare(b.primaryEmail || '');
      case 'company': return dir * (a.company || '').localeCompare(b.company || '');
      case 'emailCount': return dir * ((a.totalEmailCount || 0) - (b.totalEmailCount || 0));
      case 'lastEmailed': {
        const da = a.lastEmailed ? new Date(a.lastEmailed).getTime() : 0;
        const db = b.lastEmailed ? new Date(b.lastEmailed).getTime() : 0;
        return dir * (da - db);
      }
      default: return 0;
    }
  });

  const handleSort = useCallback((field: SortField) => {
    setSortDir((prev) => (sortField === field ? (prev === 'asc' ? 'desc' : 'asc') : 'desc'));
    setSortField(field);
  }, [sortField]);

  const toggleExpand = (personId: string) => {
    setExpandedPersonIds((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  };

  const toggleMergeSelect = (personId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedForMerge((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  };

  const handleMerge = () => {
    if (selectedForMerge.size < 2) {
      toast.error('Select at least 2 contacts to merge');
      return;
    }
    mergePersons.mutate(Array.from(selectedForMerge), {
      onSuccess: () => {
        toast.success('Contacts merged');
        setSelectedForMerge(new Set());
      },
      onError: () => toast.error('Failed to merge'),
    });
  };

  const handleUnlink = (personId: string, contactId: string) => {
    unlinkContact.mutate({ personId, contactId }, {
      onSuccess: () => toast.success('Email unlinked'),
      onError: () => toast.error('Failed to unlink'),
    });
  };

  const openCard = (contact: any, e: React.MouseEvent, edit = false) => {
    setCardContact(contact);
    setCardAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
    setCardEditing(edit);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header with nav dropdown + search */}
      <div className="border-b border-border px-4 pb-3 pt-[30px]">
        <div className="flex items-center gap-3">
          <NavigationDropdown />
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, email, or company..."
              className="w-full rounded-lg border border-border bg-surface/50 py-1.5 pl-8 pr-3 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <span className="shrink-0 text-xs text-text-tertiary">{persons.length} contacts</span>
          {selectedForMerge.size >= 2 && (
            <button
              onClick={handleMerge}
              disabled={mergePersons.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Merge className="h-3.5 w-3.5" />
              Merge ({selectedForMerge.size})
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <ScrollArea.Root className="min-h-0 flex-1">
        <ScrollArea.Viewport className="h-full w-full">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
            </div>
          ) : persons.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <User className="h-10 w-10 text-text-tertiary" />
              <p className="mt-3 text-sm text-text-tertiary">
                {searchQuery ? 'No contacts match your search' : 'Contacts will appear as emails are synced'}
              </p>
            </div>
          ) : (
            <table className="w-full table-fixed">
              <colgroup>
                <col style={{ width: '3%' }} />
                <col style={{ width: '22%' }} />
                <col style={{ width: '26%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '9%' }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur-sm">
                <tr className="border-b border-border">
                  <th className="px-2 py-2.5" />
                  <th className="px-4 py-2.5 text-left">
                    <SortHeader label="Name" field="name" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-2.5 text-left">
                    <SortHeader label="Email" field="email" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-2.5 text-left">
                    <SortHeader label="Company" field="company" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-2.5 text-right">
                    <SortHeader label="#" field="emailCount" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-2.5 text-left">
                    <SortHeader label="Last Email" field="lastEmailed" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="px-2 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((person: any) => {
                  const avatarColor = getAvatarColor(person.displayName || person.primaryEmail || '');
                  const displayName = person.displayName || person.primaryEmail || 'Unknown';
                  const contacts = person.contacts || [];
                  const hasMultipleEmails = contacts.length > 1;
                  const isExpanded = expandedPersonIds.has(person.id);
                  const isSelectedForMerge = selectedForMerge.has(person.id);

                  return (
                    <>{/* Fragment for person row + expanded email rows */}
                      <tr
                        key={person.id}
                        className={cn(
                          'group border-b border-border/50 transition-colors hover:bg-surface/50',
                          isSelectedForMerge && 'bg-primary/5',
                        )}
                      >
                        {/* Expand / merge checkbox */}
                        <td className="px-2 py-2.5">
                          <div className="flex items-center gap-1">
                            {hasMultipleEmails ? (
                              <button
                                onClick={() => toggleExpand(person.id)}
                                className="rounded p-0.5 text-text-tertiary hover:text-text-primary transition-colors"
                                title={isExpanded ? 'Collapse emails' : `Show ${contacts.length} emails`}
                              >
                                <ExpandIcon className={cn('h-3.5 w-3.5 transition-transform', isExpanded && '-rotate-180')} />
                              </button>
                            ) : (
                              <input
                                type="checkbox"
                                checked={isSelectedForMerge}
                                onChange={(e) => toggleMergeSelect(person.id, e as any)}
                                className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                style={isSelectedForMerge ? { opacity: 1 } : undefined}
                                title="Select for merge"
                              />
                            )}
                          </div>
                        </td>

                        {/* Name + Avatar */}
                        <td className="px-4 py-2.5 overflow-hidden">
                          <button
                            onClick={() => setSelectedPerson(person.id, displayName)}
                            className="flex max-w-full items-center gap-3 hover:text-primary transition-colors"
                          >
                            <Avatar.Root className="h-7 w-7 shrink-0 overflow-hidden rounded-full">
                              <Avatar.Fallback
                                className={cn('flex h-full w-full items-center justify-center text-[10px] font-semibold', avatarColor.bg, avatarColor.text)}
                              >
                                {getInitials(displayName)}
                              </Avatar.Fallback>
                            </Avatar.Root>
                            <div className="min-w-0">
                              <span className="text-sm font-medium truncate block">{displayName}</span>
                              {hasMultipleEmails && (
                                <span className="text-[10px] text-text-tertiary">
                                  {contacts.length} emails
                                </span>
                              )}
                            </div>
                          </button>
                        </td>

                        {/* Primary Email */}
                        <td className="px-4 py-2.5 text-xs text-text-secondary overflow-hidden">
                          <CopyCell value={person.primaryEmail || contacts[0]?.email || ''} />
                        </td>

                        {/* Company */}
                        <td className="px-4 py-2.5 text-xs text-text-secondary overflow-hidden">
                          {person.company || contacts[0]?.company ? (
                            <CopyCell value={person.company || contacts[0]?.company} />
                          ) : (
                            <span className="text-text-tertiary">-</span>
                          )}
                        </td>

                        {/* Email count */}
                        <td className="px-4 py-2.5 text-right overflow-hidden">
                          <span className="text-xs font-medium text-text-secondary tabular-nums">
                            {formatCount(person.totalEmailCount || 0)}
                          </span>
                        </td>

                        {/* Last emailed */}
                        <td className="px-4 py-2.5 text-xs text-text-tertiary overflow-hidden">
                          {person.lastEmailed ? formatDate(person.lastEmailed) : '-'}
                        </td>

                        {/* Actions */}
                        <td className="px-2 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-1">
                            {hasMultipleEmails && (
                              <input
                                type="checkbox"
                                checked={isSelectedForMerge}
                                onChange={(e) => toggleMergeSelect(person.id, e as any)}
                                className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                style={isSelectedForMerge ? { opacity: 1 } : undefined}
                                title="Select for merge"
                              />
                            )}
                            <button
                              onClick={(e) => openCard(contacts[0] ? { ...contacts[0], name: person.displayName } : person, e, true)}
                              className="inline-flex items-center justify-center rounded-md p-1.5 text-text-tertiary opacity-0 transition-all hover:bg-surface hover:text-text-primary group-hover:opacity-100"
                              title="Edit contact"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded email rows */}
                      {isExpanded && contacts.map((contact: any) => (
                        <tr
                          key={`${person.id}-${contact.id}`}
                          className="group border-b border-border/30 bg-surface/30"
                        >
                          <td className="px-2 py-1.5" />
                          <td className="px-4 py-1.5 pl-12 overflow-hidden">
                            <div className="flex items-center gap-2 text-xs text-text-secondary">
                              <Mail className="h-3 w-3 text-text-tertiary" />
                              <span className="truncate">{contact.name || contact.email.split('@')[0]}</span>
                            </div>
                          </td>
                          <td className="px-4 py-1.5 text-xs text-text-secondary overflow-hidden">
                            <CopyCell value={contact.email} />
                          </td>
                          <td className="px-4 py-1.5 text-xs text-text-tertiary overflow-hidden">
                            {contact.company || '-'}
                          </td>
                          <td className="px-4 py-1.5 text-right">
                            <span className="text-[11px] text-text-tertiary tabular-nums">
                              {formatCount(contact.emailCount || 0)}
                            </span>
                          </td>
                          <td className="px-4 py-1.5 text-[11px] text-text-tertiary">
                            {contact.lastEmailed ? formatDate(contact.lastEmailed) : '-'}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            {contacts.length > 1 && (
                              <button
                                onClick={() => handleUnlink(person.id, contact.id)}
                                className="inline-flex items-center justify-center rounded-md p-1 text-text-tertiary opacity-0 transition-all hover:bg-surface hover:text-red-500 group-hover:opacity-100"
                                title="Unlink this email from person"
                              >
                                <Unlink className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </>
                  );
                })}
              </tbody>
            </table>
          )}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical" className="flex w-2 touch-none select-none p-0.5">
          <ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>

      {/* Contact card popover */}
      {cardContact && (
        <ContactCard
          contact={cardContact}
          anchorRect={cardAnchor}
          onClose={() => { setCardContact(null); setCardEditing(false); }}
          startEditing={cardEditing}
        />
      )}
    </div>
  );
}

/** Breadcrumb bar shown above EmailViewer when viewing a thread from contacts */
export function ContactBreadcrumb({ threadSubject }: { threadSubject?: string }) {
  const { selectedPersonName, selectedContactName, setSelectedThread, setSelectedPerson, setSelectedContact } = useUiStore();
  const displayName = selectedPersonName || selectedContactName;

  return (
    <div className="border-b border-border px-4 py-2">
      <div className="flex items-center gap-1.5 text-xs">
        <button
          onClick={() => {
            setSelectedPerson(null);
            setSelectedContact(null);
            setSelectedThread(null);
          }}
          className="text-text-tertiary hover:text-primary transition-colors"
        >
          Contacts
        </button>
        <ChevronRight className="h-3 w-3 text-text-tertiary" />
        <button
          onClick={() => setSelectedThread(null)}
          className="text-text-tertiary hover:text-primary transition-colors truncate max-w-[160px]"
        >
          {displayName}
        </button>
        {threadSubject && (
          <>
            <ChevronRight className="h-3 w-3 text-text-tertiary" />
            <span className="font-medium text-text-primary truncate">{threadSubject}</span>
          </>
        )}
      </div>
    </div>
  );
}
