import { Suspense, lazy, useCallback, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useUiStore } from '../../stores/uiStore';
import { ThreadList } from '../thread-list/ThreadList';

import { HeaderIcons } from './Header';
import { MobileBottomNav } from './MobileBottomNav';

import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { useBiometricLock } from '../../hooks/useBiometricLock';
import { useIsMobile } from '../../hooks/useIsMobile';
import { UndoSendToast } from '../compose/UndoSendToast';
import { BiometricLockOverlay } from '../ui/BiometricLockOverlay';

import { OfflineBanner } from '../ui/OfflineBanner';
import { isIOS } from '../../lib/platform';

const AiChatPanel = lazy(() =>
  import('../ai-chat/AiChatPanel').then((module) => ({ default: module.AiChatPanel })),
);
const EmailViewer = lazy(() =>
  import('../email-viewer/EmailViewer').then((module) => ({ default: module.EmailViewer })),
);
const Dashboard = lazy(() =>
  import('../dashboard/Dashboard').then((module) => ({ default: module.Dashboard })),
);
const ContactsTable = lazy(() =>
  import('../contacts/ContactsPage').then((module) => ({ default: module.ContactsTable })),
);
const ContactDetailView = lazy(() =>
  import('../contacts/ContactDetailView').then((module) => ({ default: module.ContactDetailView })),
);
const MobileComposeSheet = lazy(() =>
  import('../compose/MobileComposeSheet').then((module) => ({ default: module.MobileComposeSheet })),
);
const SettingsPanel = lazy(() =>
  import('../settings/SettingsPanel').then((module) => ({ default: module.SettingsPanel })),
);
const MobileSettingsView = lazy(() =>
  import('../settings/MobileSettingsView').then((module) => ({ default: module.MobileSettingsView })),
);

const PanelFallback = ({ label = 'Loading…' }: { label?: string }) => (
  <div className="flex h-full items-center justify-center text-xs text-text-tertiary">
    {label}
  </div>
);

const AiChatFallback = () => <PanelFallback label="Loading AI…" />;

// iOS-style slide transitions for mobile view switching
const mobileSlideVariants = {
  enterForward: { x: '100%', opacity: 1 },
  enterBack: { x: '-30%', opacity: 1 },
  center: { x: 0, opacity: 1 },
  exitForward: { x: '-30%', opacity: 0.5 },
  exitBack: { x: '100%', opacity: 1 },
};

// Reduced-motion fallback: crossfade instead of slide
const reducedMotionVariants = {
  enterForward: { opacity: 0 },
  enterBack: { opacity: 0 },
  center: { opacity: 1 },
  exitForward: { opacity: 0 },
  exitBack: { opacity: 0 },
};

const mobileSlideTransition = { type: 'spring' as const, stiffness: 500, damping: 35, mass: 0.8 };
const reducedMotionTransition = { duration: 0.15 };

export function AppLayout() {
  const { threadListWidth, setThreadListWidth, aiChatWidth, selectedFolder, selectedContactId, selectedPersonId, settingsOpen, setSettingsOpen, composingNew, mobileActiveView, setMobileActiveView, mobileTransitionDirection } =
    useUiStore();
  const hasContactOrPerson = !!(selectedContactId || selectedPersonId);
  const isDragging = useRef<boolean>(false);
  const isCompact = useIsMobile();

  const prefersReducedMotion = useReducedMotion();
  useKeyboardShortcuts();
  usePushNotifications();
  const { isLocked, isAuthenticating, unlock } = useBiometricLock();


  const handleMouseDown = useCallback(() => {
    isDragging.current = true;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const pct = (e.clientX / window.innerWidth) * 100;
      setThreadListWidth(pct);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [setThreadListWidth]);

  const isDashboard = selectedFolder === 'dashboard';
  const isContacts = selectedFolder === 'contacts';
  const isFullPage = isDashboard || isContacts;

  // Mobile: use explicit view routing via mobileActiveView
  const showThreadList = isCompact
    ? !isFullPage && mobileActiveView === 'list'
    : !isFullPage;
  const showEmailViewer = isCompact
    ? !isFullPage && mobileActiveView === 'viewer'
    : !isFullPage;
  const showAiChat = isCompact
    ? mobileActiveView === 'chat'
    : true;
  const showSettings = isCompact && mobileActiveView === 'settings';

  const mobileBack = isCompact ? () => setMobileActiveView('list') : undefined;

  // Show biometric lock overlay when locked
  if (isLocked) {
    return <BiometricLockOverlay isAuthenticating={isAuthenticating} onUnlock={unlock} />;
  }

  return (
    <div className={`relative flex h-screen ${isCompact ? 'bg-surface' : 'ai-gradient-bg'}`}>
      {/* Invisible Electron drag region across the top */}
      {!isCompact && <div className="titlebar-drag absolute inset-x-0 top-0 z-10 h-[38px]" />}

      {/* Mobile: Tap status bar area to scroll to top (iOS convention) */}
      {isCompact && (
        <div
          className="absolute inset-x-0 top-0 z-50"
          style={{ height: 'env(safe-area-inset-top, 0px)', minHeight: '20px' }}
          onClick={() => {
            // Find the nearest visible scrollable container and scroll to top
            const scrollable = document.querySelector('[data-scroll-to-top]') as HTMLElement;
            scrollable?.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}

      {/* Offline indicator — fixed below titlebar */}
      <div className={`absolute inset-x-0 z-30 ${isCompact ? 'top-0' : 'top-[38px]'}`}>
        <OfflineBanner />
      </div>

      {/* Undo Send overlay */}
      <UndoSendToast />

      {/* Settings modal */}
      {settingsOpen && (
        <Suspense fallback={<PanelFallback />}>
          <SettingsPanel onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}

      {/* Mobile compose sheet */}
      {isCompact && composingNew && (
        <Suspense fallback={null}>
          <MobileComposeSheet />
        </Suspense>
      )}

      {/* Header icons — floating top-right on the gradient */}
      {!isCompact && (
        <div className="absolute right-3 top-1.5 z-20">
          <HeaderIcons />
        </div>
      )}

      {/* Mobile: AI Chat full-screen view */}
      <AnimatePresence>
        {isCompact && showAiChat && (
          <motion.div
            key="ai-chat-mobile"
            className="absolute inset-x-0 top-0 overflow-hidden bg-white ios-safe-top"
            style={{ bottom: 'calc(3rem + env(safe-area-inset-bottom, 0px))' }}
            initial={prefersReducedMotion ? { opacity: 0 } : { y: '100%' }}
            animate={prefersReducedMotion ? { opacity: 1 } : { y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { y: '100%' }}
            transition={prefersReducedMotion ? { duration: 0.15 } : { type: 'spring', stiffness: 400, damping: 30 }}
          >
            <Suspense fallback={<AiChatFallback />}>
              <AiChatPanel />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile: Settings full-screen view */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            key="settings-mobile"
            className="flex-1 overflow-hidden pb-14 ios-safe-top"
            initial={prefersReducedMotion ? reducedMotionVariants.enterForward : mobileSlideVariants.enterForward}
            animate={prefersReducedMotion ? reducedMotionVariants.center : mobileSlideVariants.center}
            exit={prefersReducedMotion ? reducedMotionVariants.exitBack : mobileSlideVariants.exitBack}
            transition={prefersReducedMotion ? reducedMotionTransition : mobileSlideTransition}
          >
            <Suspense fallback={<PanelFallback />}>
              <MobileSettingsView onClose={() => setMobileActiveView('list')} />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Columns 1+2: White panel with rounded right corners */}
      {(!isCompact || (!showAiChat && !showSettings)) && (
        <div
          className="flex shrink-0 overflow-hidden bg-surface"
          style={{
            flex: !isCompact ? 'none' : '1',
            width: !isCompact ? `${100 - aiChatWidth}%` : undefined,
            borderTopRightRadius: !isCompact ? '16px' : '0px',
            borderBottomRightRadius: !isCompact ? '16px' : '0px',
            position: isCompact ? 'relative' : undefined,
          }}
        >
          {isDashboard ? (
            <div className="min-w-0 flex-1 overflow-hidden">
              <Suspense fallback={<PanelFallback />}>
                <Dashboard />
              </Suspense>
            </div>
          ) : isContacts && !hasContactOrPerson ? (
            <div className="min-w-0 flex-1 overflow-hidden">
              <Suspense fallback={<PanelFallback />}>
                <ContactsTable />
              </Suspense>
            </div>
          ) : isContacts && hasContactOrPerson ? (
            <>
              {/* Contact thread list */}
              {(!isCompact || mobileActiveView === 'list') && (
                <div
                  style={{ width: isCompact ? '100%' : `${threadListWidth}vw` }}
                  className="shrink-0 overflow-hidden border-r border-border"
                >
                  <Suspense fallback={<PanelFallback />}>
                    <ContactDetailView />
                  </Suspense>
                </div>
              )}
              {/* Resize handle */}
              {!isCompact && (
                <div
                  className="w-[3px] shrink-0 cursor-col-resize transition-colors hover:bg-primary/20 active:bg-primary/40"
                  onMouseDown={handleMouseDown}
                />
              )}
              {/* Email viewer for selected thread */}
              {(!isCompact || mobileActiveView === 'viewer') && (
                <div className="min-w-0 flex-1">
                  <Suspense fallback={<PanelFallback />}>
                    <EmailViewer
                      onBack={mobileBack}
                    />
                  </Suspense>
                </div>
              )}
            </>
          ) : isCompact ? (
            /* Mobile: animated view transitions */
            <AnimatePresence mode="popLayout" initial={false}>
              {showThreadList && (
                <motion.div
                  key="thread-list"
                  className="absolute inset-0 overflow-hidden"
                  style={{ paddingBottom: 'calc(3rem + env(safe-area-inset-bottom, 0px))' }}
                  initial={mobileTransitionDirection === 'back' ? 'enterBack' : 'enterForward'}
                  animate="center"
                  exit={mobileTransitionDirection === 'forward' ? 'exitForward' : 'exitBack'}
                  variants={prefersReducedMotion ? reducedMotionVariants : mobileSlideVariants}
                  transition={prefersReducedMotion ? reducedMotionTransition : mobileSlideTransition}
                >
                  <ThreadList />
                </motion.div>
              )}
              {showEmailViewer && (
                <motion.div
                  key="email-viewer"
                  className="absolute inset-0 overflow-hidden"
                  style={{ paddingBottom: 'calc(3rem + env(safe-area-inset-bottom, 0px))' }}
                  initial={mobileTransitionDirection === 'back' ? 'enterBack' : 'enterForward'}
                  animate="center"
                  exit={mobileTransitionDirection === 'forward' ? 'exitForward' : 'exitBack'}
                  variants={prefersReducedMotion ? reducedMotionVariants : mobileSlideVariants}
                  transition={prefersReducedMotion ? reducedMotionTransition : mobileSlideTransition}
                >
                  <Suspense fallback={<PanelFallback />}>
                    <EmailViewer onBack={mobileBack} />
                  </Suspense>
                </motion.div>
              )}
            </AnimatePresence>
          ) : (
            <>
              {/* Desktop: Thread List */}
              {showThreadList && (
                <div
                  style={{ width: `${threadListWidth}vw` }}
                  className="shrink-0 overflow-hidden border-r border-border"
                >
                  <ThreadList />
                </div>
              )}

              {/* Resize handle */}
              <div
                className="w-[3px] shrink-0 cursor-col-resize transition-colors hover:bg-primary/20 active:bg-primary/40"
                onMouseDown={handleMouseDown}
              />

              {/* Desktop: Email Viewer */}
              {showEmailViewer && (
                <div className="min-w-0 flex-1">
                  <Suspense fallback={<PanelFallback />}>
                    <EmailViewer onBack={mobileBack} />
                  </Suspense>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Column 3: AI Chat — sits on the gradient background (desktop only) */}
      {!isCompact && (
        <div
          style={{ width: `${aiChatWidth}%` }}
          className="shrink-0 pt-10 transition-panel"
        >
          <Suspense fallback={<AiChatFallback />}>
            <AiChatPanel />
          </Suspense>
        </div>
      )}

      {/* Mobile bottom navigation */}
      {isCompact && <MobileBottomNav />}

    </div>
  );
}
