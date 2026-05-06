import { Bell, Monitor, Volume2, Smartphone, Eye, Moon, Clock } from 'lucide-react';
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from '../../hooks/useNotificationPreferences';
import { cn } from '../../lib/utils';
import { isNative } from '../../lib/platform';

function Toggle({
  enabled,
  onChange,
  label,
  description,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface/50 p-3">
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-text-primary">{label}</p>
        {description && (
          <p className="mt-0.5 text-[11px] text-text-tertiary leading-relaxed">{description}</p>
        )}
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          enabled ? 'bg-primary' : 'bg-gray-300',
        )}
      >
        <span
          className={cn(
            'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
            enabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
          )}
        />
      </button>
    </div>
  );
}

export function NotificationSettings() {
  const { data: prefs } = useNotificationPreferences();
  const updatePrefs = useUpdateNotificationPreferences();

  const update = (key: string, value: boolean) => {
    updatePrefs.mutate({ [key]: value });
  };

  const requestDesktopPermission = async () => {
    if (!('Notification' in window)) return;
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      update('desktopEnabled', true);
    }
  };

  if (!prefs) return null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Bell className="h-4 w-4 text-text-secondary" />
        <h3 className="text-[13px] font-semibold text-text-primary">Notifications</h3>
      </div>

      <p className="text-[11px] text-text-tertiary leading-relaxed">
        Choose which events trigger in-app notifications. Disabled types will be silently skipped.
      </p>

      {/* Delivery methods */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Delivery</p>

        {/* Push notifications — iOS only */}
        {isNative() && (
          <>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface/50 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Smartphone className="h-3.5 w-3.5 text-text-secondary" />
                  <p className="text-[12px] font-semibold text-text-primary">Push notifications</p>
                </div>
                <p className="mt-0.5 text-[11px] text-text-tertiary leading-relaxed">
                  Receive notifications when the app is closed
                </p>
              </div>
              <button
                onClick={() => update('pushEnabled', !prefs.pushEnabled)}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                  prefs.pushEnabled ? 'bg-primary' : 'bg-gray-300',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
                    prefs.pushEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
                  )}
                />
              </button>
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface/50 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Eye className="h-3.5 w-3.5 text-text-secondary" />
                  <p className="text-[12px] font-semibold text-text-primary">Show content on lock screen</p>
                </div>
                <p className="mt-0.5 text-[11px] text-text-tertiary leading-relaxed">
                  Display sender and subject on lock screen notifications
                </p>
              </div>
              <button
                onClick={() => update('showPreviewOnLock', !prefs.showPreviewOnLock)}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                  prefs.showPreviewOnLock ? 'bg-primary' : 'bg-gray-300',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
                    prefs.showPreviewOnLock ? 'translate-x-[18px]' : 'translate-x-[3px]',
                  )}
                />
              </button>
            </div>

            <div className="rounded-lg border border-border bg-surface/50 p-3 space-y-2">
              <div className="flex items-center gap-1.5">
                <Moon className="h-3.5 w-3.5 text-text-secondary" />
                <p className="text-[12px] font-semibold text-text-primary">Quiet hours</p>
              </div>
              <p className="text-[11px] text-text-tertiary leading-relaxed">
                Pause push notifications during specified hours
              </p>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3 text-text-tertiary" />
                  <span className="text-[11px] text-text-secondary">From</span>
                  <input
                    type="time"
                    value={prefs.quietHoursStart || ''}
                    onChange={(e) => {
                      updatePrefs.mutate({
                        quietHoursStart: e.target.value || null,
                        quietHoursTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                      } as any);
                    }}
                    className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text-primary"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-text-secondary">To</span>
                  <input
                    type="time"
                    value={prefs.quietHoursEnd || ''}
                    onChange={(e) => {
                      updatePrefs.mutate({
                        quietHoursEnd: e.target.value || null,
                        quietHoursTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                      } as any);
                    }}
                    className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text-primary"
                  />
                </div>
              </div>
            </div>
          </>
        )}

        <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface/50 p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Monitor className="h-3.5 w-3.5 text-text-secondary" />
              <p className="text-[12px] font-semibold text-text-primary">Desktop notifications</p>
            </div>
            <p className="mt-0.5 text-[11px] text-text-tertiary leading-relaxed">
              Show browser/OS notifications for new activity
            </p>
          </div>
          <button
            onClick={() => {
              if (!prefs.desktopEnabled) {
                requestDesktopPermission();
              } else {
                update('desktopEnabled', false);
              }
            }}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
              prefs.desktopEnabled ? 'bg-primary' : 'bg-gray-300',
            )}
          >
            <span
              className={cn(
                'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
                prefs.desktopEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
              )}
            />
          </button>
        </div>

        <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface/50 p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Volume2 className="h-3.5 w-3.5 text-text-secondary" />
              <p className="text-[12px] font-semibold text-text-primary">Sound</p>
            </div>
            <p className="mt-0.5 text-[11px] text-text-tertiary leading-relaxed">
              Play a sound when new notifications arrive
            </p>
          </div>
          <button
            onClick={() => update('soundEnabled', !prefs.soundEnabled)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
              prefs.soundEnabled ? 'bg-primary' : 'bg-gray-300',
            )}
          >
            <span
              className={cn(
                'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
                prefs.soundEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
              )}
            />
          </button>
        </div>
      </div>

      {/* Notification types */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Event Types</p>
        <Toggle
          enabled={prefs.enableNewEmail}
          onChange={(v) => update('enableNewEmail', v)}
          label="New emails"
          description="Notify when new emails arrive in your inbox"
        />
        <Toggle
          enabled={prefs.enableMention}
          onChange={(v) => update('enableMention', v)}
          label="Mentions"
          description="Notify when someone @mentions you in a comment"
        />
        <Toggle
          enabled={prefs.enableComment}
          onChange={(v) => update('enableComment', v)}
          label="Comments"
          description="Notify when new comments are posted on your threads"
        />
        <Toggle
          enabled={prefs.enableAssignment}
          onChange={(v) => update('enableAssignment', v)}
          label="Assignments"
          description="Notify when threads are assigned or delegated to you"
        />
        <Toggle
          enabled={prefs.enableSlaWarning}
          onChange={(v) => update('enableSlaWarning', v)}
          label="SLA warnings"
          description="Notify when response time thresholds are approaching"
        />
        <Toggle
          enabled={prefs.enableSlaBreach}
          onChange={(v) => update('enableSlaBreach', v)}
          label="SLA breaches"
          description="Notify when response time thresholds have been exceeded"
        />
        <Toggle
          enabled={prefs.enableSnoozeReminder}
          onChange={(v) => update('enableSnoozeReminder', v)}
          label="Snooze reminders"
          description="Notify when a snoozed thread comes back"
        />
      </div>
    </div>
  );
}
