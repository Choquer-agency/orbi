import { X, FolderInput, Pen, Bell, Filter, Columns3, ShieldBan, Plane, TextQuote, UserCircle, Shield, Mail, Trash2, Inbox } from 'lucide-react';
import { SignatureIcon } from '../icons/SignatureIcon';
import { useUiStore } from '../../stores/uiStore';
import { WritingPreferences } from './WritingPreferences';
import { GeneralSettings } from './GeneralSettings';
import { SignatureSettings } from './SignatureSettings';
import { NotificationSettings } from './NotificationSettings';
import { SecuritySettings } from './SecuritySettings';
import { BlockedSendersSettings } from './BlockedSendersSettings';
import { InboxSplitSettings } from './InboxSplitSettings';
import { AiFilterSettings } from './AiFilterSettings';
import { VacationResponderSettings } from './VacationResponderSettings';
import { SnippetSettings } from './SnippetSettings';
import { AccountsSettings } from './AccountsSettings';
import { ProfileSettings } from './ProfileSettings';
import { RetentionSettings } from './RetentionSettings';
import { NeedsResponseSettings } from './NeedsResponseSettings';
import { cn } from '../../lib/utils';

interface SettingsPanelProps {
  onClose: () => void;
}

const SECTIONS = [
  { id: 'profile', label: 'Profile', icon: UserCircle },
  { id: 'accounts', label: 'Accounts', icon: Mail },
  { id: 'general', label: 'General', icon: FolderInput },
  { id: 'writing', label: 'Writing Style', icon: Pen },
  { id: 'signatures', label: 'Signatures', icon: SignatureIcon },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'filters', label: 'AI Filters', icon: Filter },
  { id: 'splits', label: 'Inbox Splits', icon: Columns3 },
  { id: 'needs-response', label: 'Needs Response', icon: Inbox },
  { id: 'blocked', label: 'Blocked Senders', icon: ShieldBan },
  { id: 'retention', label: 'Auto-Delete', icon: Trash2 },
  { id: 'vacation', label: 'Vacation Responder', icon: Plane },
  { id: 'snippets', label: 'Snippets', icon: TextQuote },
] as const;

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const settingsSection = useUiStore((s) => s.settingsSection);
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);

  const renderContent = () => {
    switch (settingsSection) {
      case 'profile':
        return <ProfileSettings />;
      case 'accounts':
        return <AccountsSettings />;
      case 'general':
        return <GeneralSettings />;
      case 'writing':
        return <WritingPreferences />;
      case 'signatures':
        return <SignatureSettings />;
      case 'notifications':
        return <NotificationSettings />;
      case 'security':
        return <SecuritySettings />;
      case 'filters':
        return <AiFilterSettings />;
      case 'splits':
        return <InboxSplitSettings />;
      case 'needs-response':
        return <NeedsResponseSettings />;
      case 'blocked':
        return <BlockedSendersSettings />;
      case 'retention':
        return <RetentionSettings />;
      case 'vacation':
        return <VacationResponderSettings />;
      case 'snippets':
        return <SnippetSettings />;
      default:
        return <GeneralSettings />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="relative flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-border bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-[14px] font-semibold text-text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          <nav className="w-48 shrink-0 overflow-y-auto border-r border-border bg-surface/30 py-2">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const isActive = settingsSection === section.id;
              return (
                <button
                  key={section.id}
                  onClick={() => setSettingsSection(section.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-4 py-2 text-left text-[12px] transition-colors',
                    isActive
                      ? 'bg-primary/8 font-semibold text-primary'
                      : 'text-text-secondary hover:bg-surface hover:text-text-primary',
                  )}
                >
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', isActive ? 'text-primary' : 'text-text-tertiary')} />
                  {section.label}
                </button>
              );
            })}
          </nav>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
