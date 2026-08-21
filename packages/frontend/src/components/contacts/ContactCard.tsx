import { useRef, useEffect, useState } from 'react';
import * as Avatar from '@radix-ui/react-avatar';
import { Mail, Building2, Briefcase, Phone, Copy, Check, X, MessageSquare, Calendar, Pencil } from 'lucide-react';
import { getAvatarColor } from '../../lib/constants';
import { cn, getInitials } from '../../lib/utils';
import { useUpdateContact } from '../../hooks/useContacts';
import toast from 'react-hot-toast';

interface ContactCardProps {
  contact: {
    id: string;
    name?: string | null;
    email: string;
    company?: string | null;
    title?: string | null;
    phone?: string | null;
    emailCount?: number;
    lastEmailed?: string | null;
  };
  onClose: () => void;
  anchorRect?: DOMRect | null;
  startEditing?: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function CopyField({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success('Copied!', { duration: 1200, style: { fontSize: '12px', padding: '6px 12px' } });
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
      <span className="text-xs text-text-tertiary w-16 shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{value}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-green-500" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </button>
  );
}

function EditField({ icon: Icon, label, value, onChange }: { icon: any; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
      <span className="text-xs text-text-tertiary w-16 shrink-0">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        className="min-w-0 flex-1 rounded border border-border bg-surface/50 px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </div>
  );
}

export function ContactCard({ contact, onClose, anchorRect, startEditing = false }: ContactCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const avatarColor = getAvatarColor(contact.name || contact.email);
  const displayName = contact.name || contact.email;
  const updateContact = useUpdateContact();

  const [editing, setEditing] = useState(startEditing);
  const [editName, setEditName] = useState(contact.name || '');
  const [editCompany, setEditCompany] = useState(contact.company || '');
  const [editTitle, setEditTitle] = useState(contact.title || '');
  const [editPhone, setEditPhone] = useState(contact.phone || '');

  // Close on click outside (only when not editing)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        if (editing) {
          setEditing(false);
        } else {
          onClose();
        }
      }
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose, editing]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editing) {
          setEditing(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, editing]);

  const handleSave = () => {
    updateContact.mutate(
      {
        id: contact.id,
        name: editName || null,
        company: editCompany || null,
        title: editTitle || null,
        phone: editPhone || null,
      },
      {
        onSuccess: () => {
          toast.success('Contact updated');
          setEditing(false);
          onClose();
        },
        onError: () => toast.error('Failed to update'),
      },
    );
  };

  const handleCancel = () => {
    setEditName(contact.name || '');
    setEditCompany(contact.company || '');
    setEditTitle(contact.title || '');
    setEditPhone(contact.phone || '');
    setEditing(false);
  };

  // Position near anchor or center
  const style: React.CSSProperties = {};
  if (anchorRect) {
    const cardWidth = 300;
    const cardHeight = 300;
    let left = anchorRect.left + anchorRect.width / 2 - cardWidth / 2;
    let top = anchorRect.bottom + 8;

    if (left < 12) left = 12;
    if (left + cardWidth > window.innerWidth - 12) left = window.innerWidth - cardWidth - 12;
    if (top + cardHeight > window.innerHeight - 12) {
      top = anchorRect.top - cardHeight - 8;
    }

    style.position = 'fixed';
    style.left = left;
    style.top = top;
  } else {
    style.position = 'fixed';
    style.left = '50%';
    style.top = '50%';
    style.transform = 'translate(-50%, -50%)';
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/10" />

      {/* Card */}
      <div
        ref={cardRef}
        className="z-50 w-[300px] rounded-xl border border-border bg-white shadow-xl animate-in fade-in zoom-in-95 duration-150"
        style={style}
      >
        {/* Identity row — compact, no banner */}
        <div className="flex items-start gap-3 px-4 pb-1 pt-4">
          <Avatar.Root className="h-10 w-10 shrink-0 overflow-hidden rounded-full">
            <Avatar.Fallback
              className={cn('flex h-full w-full items-center justify-center rounded-full text-[13px] font-bold', avatarColor.bg, avatarColor.text)}
            >
              {getInitials(editing ? editName || contact.email : displayName)}
            </Avatar.Fallback>
          </Avatar.Root>
          <div className="min-w-0 flex-1 pt-0.5">
            {editing ? (
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Name"
                className="w-full rounded border border-border bg-surface/50 px-2 py-1 text-sm font-semibold text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <>
                <h3 className="truncate text-[13px] font-semibold text-text-primary">{displayName}</h3>
                <p className="truncate text-[11px] text-text-tertiary">
                  {[contact.title, contact.company].filter(Boolean).join(' · ') || contact.email}
                </p>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {!editing && (
              <button
                onClick={() => setEditing(true)}
                className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
                title="Edit contact"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Details */}
        <div className="mt-2 border-t border-border/70 px-1 py-1.5 pb-2">

          {editing ? (
            <>
              <div className="flex items-center gap-3 px-3 py-1.5">
                <Mail className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                <span className="text-xs text-text-tertiary w-16 shrink-0">Email</span>
                <span className="text-xs text-text-primary truncate">{contact.email}</span>
              </div>
              <EditField icon={Building2} label="Company" value={editCompany} onChange={setEditCompany} />
              <EditField icon={Briefcase} label="Role" value={editTitle} onChange={setEditTitle} />
              <EditField icon={Phone} label="Phone" value={editPhone} onChange={setEditPhone} />

              <div className="mt-3 flex items-center gap-2 px-3">
                <button
                  onClick={handleSave}
                  disabled={updateContact.isPending}
                  className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {updateContact.isPending ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={handleCancel}
                  className="rounded-lg border border-border px-4 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface transition-colors"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <CopyField icon={Mail} label="Email" value={contact.email} />
              {contact.company && (
                <CopyField icon={Building2} label="Company" value={contact.company} />
              )}
              {contact.title && (
                <CopyField icon={Briefcase} label="Role" value={contact.title} />
              )}
              {contact.phone && (
                <CopyField icon={Phone} label="Phone" value={contact.phone} />
              )}
              {contact.emailCount != null && (
                <div className="flex items-center gap-3 px-3 py-2">
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                  <span className="text-xs text-text-tertiary w-16 shrink-0">Emails</span>
                  <span className="text-xs text-text-primary">{contact.emailCount.toLocaleString()}</span>
                </div>
              )}
              {contact.lastEmailed && (
                <div className="flex items-center gap-3 px-3 py-2">
                  <Calendar className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                  <span className="text-xs text-text-tertiary w-16 shrink-0">Last</span>
                  <span className="text-xs text-text-primary">{formatDate(contact.lastEmailed)}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
