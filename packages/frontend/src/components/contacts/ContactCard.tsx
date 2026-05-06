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

/** Deterministic gradient + blob SVG per contact based on name/email hash */
function getCardGradient(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 40 + (Math.abs(hash >> 8) % 60)) % 360;
  const h3 = (h2 + 30 + (Math.abs(hash >> 16) % 50)) % 360;

  const blobVar = Math.abs(hash >> 4) % 4;
  const blobPaths = [
    'M44,-11C53,8,54,34,42,50C30,66,5,72,-17,65C-39,58,-57,38,-60,16C-63,-6,-51,-30,-34,-45C-17,-60,5,-66,22,-56C39,-46,35,-30,44,-11Z',
    'M39,-15C50,3,56,29,48,48C40,67,18,79,-6,76C-30,73,-56,55,-63,32C-70,9,-58,-19,-40,-37C-22,-55,2,-63,20,-56C38,-49,28,-33,39,-15Z',
    'M42,-8C51,13,53,39,41,55C29,71,3,77,-19,69C-41,61,-59,39,-62,15C-65,-9,-53,-35,-35,-49C-17,-63,7,-65,24,-54C41,-43,33,-29,42,-8Z',
    'M46,-5C55,14,57,40,45,56C33,72,7,78,-16,71C-39,64,-59,44,-63,21C-67,-2,-55,-28,-37,-44C-19,-60,5,-66,23,-57C41,-48,37,-24,46,-5Z',
  ];

  return {
    gradient: `linear-gradient(135deg, hsl(${h1}, 70%, 82%) 0%, hsl(${h2}, 65%, 78%) 50%, hsl(${h3}, 60%, 85%) 100%)`,
    blobColor1: `hsla(${h1}, 60%, 70%, 0.4)`,
    blobColor2: `hsla(${h2}, 55%, 75%, 0.35)`,
    blobPath: blobPaths[blobVar],
  };
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
  const cardStyle = getCardGradient(contact.email);
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
    const cardHeight = 420;
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
        {/* Gradient header with blobs */}
        <div
          className="relative h-20 overflow-hidden rounded-t-xl"
          style={{ background: cardStyle.gradient }}
        >
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="-80 -80 160 160"
            preserveAspectRatio="xMidYMid slice"
          >
            <path
              d={cardStyle.blobPath}
              fill={cardStyle.blobColor1}
              transform="translate(-20, -10) scale(1.1)"
            />
            <path
              d={cardStyle.blobPath}
              fill={cardStyle.blobColor2}
              transform="translate(25, 15) scale(0.8) rotate(45)"
            />
          </svg>
          <div className="absolute right-2 top-2 flex items-center gap-1">
            {!editing && (
              <button
                onClick={() => setEditing(true)}
                className="rounded-full p-1 text-white/60 hover:bg-white/20 hover:text-white transition-colors"
                title="Edit contact"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-full p-1 text-white/60 hover:bg-white/20 hover:text-white transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Avatar overlapping header */}
        <div className="relative px-4">
          <div className="-mt-9">
            <Avatar.Root className="h-[72px] w-[72px] overflow-hidden rounded-full border-[3px] border-white shadow-md">
              <Avatar.Fallback
                className={cn('flex h-full w-full items-center justify-center text-lg font-bold rounded-full', avatarColor.bg, avatarColor.text)}
              >
                {getInitials(editing ? editName || contact.email : displayName)}
              </Avatar.Fallback>
            </Avatar.Root>
          </div>

          {editing ? (
            <div className="mt-2">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Name"
                className="w-full rounded border border-border bg-surface/50 px-2 py-1 text-sm font-semibold text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          ) : (
            <div className="mt-2">
              <h3 className="text-sm font-semibold text-text-primary">{displayName}</h3>
              {contact.title && contact.company && (
                <p className="text-xs text-text-secondary">
                  {contact.title} at <span className="font-medium">{contact.company}</span>
                </p>
              )}
              {contact.title && !contact.company && (
                <p className="text-xs text-text-secondary">{contact.title}</p>
              )}
              {!contact.title && contact.company && (
                <p className="text-xs text-text-secondary">{contact.company}</p>
              )}
            </div>
          )}
        </div>

        {/* Details */}
        <div className="mt-3 border-t border-border px-1 py-2 pb-3">
          <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Details</p>

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
