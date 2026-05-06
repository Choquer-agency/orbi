import { useState } from 'react';
import { ArrowLeft, Mail, Building2, Briefcase, Phone, ChevronDown } from 'lucide-react';
import * as Avatar from '@radix-ui/react-avatar';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import { usePerson, usePersonThreads } from '../../hooks/usePersons';
import { useContact, useContactThreads } from '../../hooks/useContacts';
import { useUiStore } from '../../stores/uiStore';
import { cn, formatRelativeTime, getInitials } from '../../lib/utils';
import { getAvatarColor } from '../../lib/constants';

export function ContactDetailView() {
  const { selectedPersonId, selectedPersonName, selectedContactId, selectedContactName, setSelectedPerson, setSelectedContact, setSelectedThread } = useUiStore();
  const [emailsExpanded, setEmailsExpanded] = useState(false);

  // Use person-level data if available, fallback to contact-level
  const isPersonView = !!selectedPersonId;
  const { data: personRes } = usePerson(selectedPersonId);
  const { data: personThreadsRes, isLoading: personThreadsLoading } = usePersonThreads(selectedPersonId);
  const { data: contactRes } = useContact(isPersonView ? null : selectedContactId);
  const { data: contactThreadsRes, isLoading: contactThreadsLoading } = useContactThreads(isPersonView ? null : selectedContactId);

  const person = personRes?.data;
  const contact = contactRes?.data;
  const threads = isPersonView ? (personThreadsRes?.data ?? []) : (contactThreadsRes?.data ?? []);
  const isLoading = isPersonView ? personThreadsLoading : contactThreadsLoading;

  const displayName = isPersonView
    ? (person?.displayName || selectedPersonName || '')
    : (selectedContactName || '');
  const avatarColor = getAvatarColor(displayName);
  const contacts = person?.contacts || [];
  const primaryContact = contacts[0] || contact;

  const handleBack = () => {
    if (isPersonView) setSelectedPerson(null);
    else setSelectedContact(null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-5 pb-3 pt-[30px]">
        <div className="flex h-7 items-center gap-3">
          <button
            onClick={handleBack}
            className="rounded-lg p-1 text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <Avatar.Root className="h-6 w-6 shrink-0 overflow-hidden rounded-full">
            <Avatar.Fallback
              className={cn(
                'flex h-full w-full items-center justify-center text-[9px] font-bold',
                avatarColor.bg,
                avatarColor.text,
              )}
            >
              {getInitials(displayName)}
            </Avatar.Fallback>
          </Avatar.Root>
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">
            {displayName}
          </h2>
        </div>
      </div>

      {/* Contact info bar */}
      {(person || contact) && (
        <div className="border-b border-border px-5 py-2.5">
          {/* Email addresses */}
          {isPersonView && contacts.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 mb-1">
              {/* Show primary email always */}
              <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                <Mail className="h-3 w-3 text-text-tertiary" />
                {contacts[0].email}
              </div>
              {contacts.length > 1 && (
                <>
                  {emailsExpanded ? (
                    contacts.slice(1).map((c: any) => (
                      <div key={c.id} className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                        <Mail className="h-3 w-3 text-text-tertiary" />
                        {c.email}
                      </div>
                    ))
                  ) : null}
                  <button
                    onClick={() => setEmailsExpanded(!emailsExpanded)}
                    className="flex items-center gap-0.5 text-[11px] text-primary hover:text-primary/80 transition-colors"
                  >
                    {emailsExpanded ? 'Show less' : `+${contacts.length - 1} more`}
                    <ChevronDown className={cn('h-3 w-3 transition-transform', emailsExpanded && 'rotate-180')} />
                  </button>
                </>
              )}
            </div>
          ) : primaryContact ? (
            <div className="flex items-center gap-1.5 text-[11px] text-text-secondary mb-1">
              <Mail className="h-3 w-3 text-text-tertiary" />
              {primaryContact.email}
            </div>
          ) : null}

          {/* Company / Title / Phone */}
          <div className="flex flex-wrap items-center gap-4">
            {(person?.company || primaryContact?.company) && (
              <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                <Building2 className="h-3 w-3 text-text-tertiary" />
                {person?.company || primaryContact?.company}
              </div>
            )}
            {(person?.title || primaryContact?.title) && (
              <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                <Briefcase className="h-3 w-3 text-text-tertiary" />
                {person?.title || primaryContact?.title}
              </div>
            )}
            {(person?.phone || primaryContact?.phone) && (
              <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                <Phone className="h-3 w-3 text-text-tertiary" />
                {person?.phone || primaryContact?.phone}
              </div>
            )}
            <span className="text-[11px] text-text-tertiary">
              {threads.length} thread{threads.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      )}

      {/* Thread list */}
      <ScrollArea.Root className="min-h-0 flex-1">
        <ScrollArea.Viewport className="h-full w-full">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
            </div>
          ) : threads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Mail className="h-8 w-8 text-text-tertiary" />
              <p className="mt-3 text-sm text-text-tertiary">No threads found with this contact</p>
            </div>
          ) : (
            <div>
              {threads.map((thread: any) => {
                const latestEmail = thread.emails?.[0];
                return (
                  <button
                    key={thread.id}
                    onClick={() => setSelectedThread(thread.id)}
                    className="flex w-full items-start gap-3 border-b border-border/50 px-5 py-3 text-left transition-colors hover:bg-surface/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className={cn(
                          'min-w-0 truncate text-[13px]',
                          !thread.isRead ? 'font-semibold text-text-primary' : 'font-medium text-text-primary',
                        )}>
                          {thread.subject || '(no subject)'}
                        </p>
                        <span className="shrink-0 text-[10px] text-text-tertiary">
                          {formatRelativeTime(thread.lastMessageAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-text-tertiary">
                        {latestEmail?.snippet || ''}
                      </p>
                    </div>
                    {thread.messageCount > 1 && (
                      <span className="mt-0.5 shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-tertiary">
                        {thread.messageCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical" className="flex w-2 touch-none select-none p-0.5">
          <ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  );
}
