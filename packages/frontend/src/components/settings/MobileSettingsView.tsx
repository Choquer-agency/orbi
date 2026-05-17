import { useState, type ComponentType, type SVGProps } from 'react';
import { ChevronLeft, ChevronRight, LogOut, UserCircle, FolderInput, Pen, Bell, Filter, Columns3, ShieldBan, Plane, TextQuote, Shield } from 'lucide-react';
import { SignatureIcon } from '../icons/SignatureIcon';
import { useAuthStore } from '../../stores/authStore';
import { getInitials } from '../../lib/utils';
import { ProfileSettings } from './ProfileSettings';
import { AccountsSettings } from './AccountsSettings';
import { WritingPreferences } from './WritingPreferences';
import { SignatureSettings } from './SignatureSettings';
import { NotificationSettings } from './NotificationSettings';
import { SecuritySettings } from './SecuritySettings';
import { AiFilterSettings } from './AiFilterSettings';
import { InboxSplitSettings } from './InboxSplitSettings';
import { BlockedSendersSettings } from './BlockedSendersSettings';
import { VacationResponderSettings } from './VacationResponderSettings';
import { SnippetSettings } from './SnippetSettings';
import { GeneralSettings } from './GeneralSettings';

interface SectionItem {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;
}

interface SectionGroup {
  title: string;
  items: SectionItem[];
}

const SECTION_GROUPS: SectionGroup[] = [
  {
    title: 'General',
    items: [
      { id: 'accounts', label: 'Accounts', icon: UserCircle },
      { id: 'general', label: 'Preferences', icon: FolderInput },
      { id: 'notifications', label: 'Notifications', icon: Bell },
    ],
  },
  {
    title: 'Compose',
    items: [
      { id: 'writing', label: 'Writing Style', icon: Pen },
      { id: 'signatures', label: 'Signatures', icon: SignatureIcon },
      { id: 'snippets', label: 'Snippets', icon: TextQuote },
    ],
  },
  {
    title: 'Inbox',
    items: [
      { id: 'filters', label: 'AI Filters', icon: Filter },
      { id: 'splits', label: 'Inbox Splits', icon: Columns3 },
      { id: 'blocked', label: 'Blocked Senders', icon: ShieldBan },
    ],
  },
  {
    title: 'Security & Away',
    items: [
      { id: 'security', label: 'Security', icon: Shield },
      { id: 'vacation', label: 'Vacation Responder', icon: Plane },
    ],
  },
];

interface MobileSettingsViewProps {
  onClose: () => void;
}

function renderSectionContent(section: string) {
  switch (section) {
    case 'profile': return <ProfileSettings />;
    case 'accounts': return <AccountsSettings />;
    case 'general': return <GeneralSettings />;
    case 'writing': return <WritingPreferences />;
    case 'signatures': return <SignatureSettings />;
    case 'notifications': return <NotificationSettings />;
    case 'security': return <SecuritySettings />;
    case 'filters': return <AiFilterSettings />;
    case 'splits': return <InboxSplitSettings />;
    case 'blocked': return <BlockedSendersSettings />;
    case 'vacation': return <VacationResponderSettings />;
    case 'snippets': return <SnippetSettings />;
    default: return <AccountsSettings />;
  }
}

function getSectionLabel(id: string): string {
  if (id === 'profile') return 'Profile';
  for (const group of SECTION_GROUPS) {
    const item = group.items.find((s) => s.id === id);
    if (item) return item.label;
  }
  return id;
}

export function MobileSettingsView({ onClose }: MobileSettingsViewProps) {
  const { user, logout } = useAuthStore();
  const [activeSection, setActiveSection] = useState<string | null>(null);

  // Level 2: Section detail
  if (activeSection) {
    return (
      <div className="flex h-full flex-col bg-surface">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border bg-white px-3 py-4">
          <button
            onClick={() => setActiveSection(null)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-text-secondary transition-colors active:bg-black/8"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h2 className="text-[20px] font-bold text-text-primary">
            {getSectionLabel(activeSection)}
          </h2>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-5">
          {renderSectionContent(activeSection)}
        </div>
      </div>
    );
  }

  // Level 1: Section list
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex-1 overflow-y-auto px-4 pb-8">
        <h2 className="mt-4 mb-2 px-1 text-[15px] font-bold text-text-primary">Settings</h2>
        {/* Profile card */}
        {user && (
          <button
            onClick={() => setActiveSection('profile')}
            className="flex w-full items-center gap-3.5 rounded-2xl bg-white px-4 py-4 text-left shadow-xs transition-colors active:bg-black/5"
          >
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.name}
                className="h-14 w-14 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-lg font-semibold text-primary">
                {getInitials(user.name)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-semibold text-text-primary truncate">{user.name}</p>
              <p className="text-xs text-text-tertiary truncate">{user.email}</p>
            </div>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-tertiary" />
          </button>
        )}

        {/* Grouped section list */}
        {SECTION_GROUPS.map((group) => (
          <div key={group.title} className="mt-6">
            <h3 className="mb-2 px-1 text-[15px] font-bold text-text-primary">
              {group.title}
            </h3>
            <div className="overflow-hidden rounded-2xl bg-white shadow-xs">
              {group.items.map((section, i) => {
                const Icon = section.icon;
                return (
                  <button
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                    className={`flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors active:bg-black/5 ${
                      i < group.items.length - 1 ? 'border-b border-border/40' : ''
                    }`}
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface">
                      <Icon className="h-[18px] w-[18px] text-text-secondary" />
                    </div>
                    <span className="flex-1 text-[14px] text-text-primary">{section.label}</span>
                    <ChevronRight className="h-5 w-5 shrink-0 text-text-tertiary/60" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* Sign out */}
        <div className="mt-8">
          <button
            onClick={() => { logout(); onClose(); }}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white py-3.5 text-[14px] font-medium text-red-500 shadow-xs transition-colors active:bg-red-50/80"
          >
            <LogOut className="h-4.5 w-4.5" />
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
