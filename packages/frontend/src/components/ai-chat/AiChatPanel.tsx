import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Plus,
  Send,
  ExternalLink,
  Paperclip,
  Copy,
  ThumbsUp,
  ThumbsDown,
  MessageSquareText,
  FileText,
  Mail,
  MailSearch,
  AlertCircle,
  Clock,
  CheckCircle2,
  User,
  Building2,
  CalendarClock,
  ListTodo,
} from 'lucide-react';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import { useAiChat } from '../../hooks/useAiChat';
import { useConversations } from '../../hooks/useConversations';
import { useUiStore } from '../../stores/uiStore';
import { useThread } from '../../hooks/useThreads';
import { useContactAutocomplete } from '../../hooks/useContacts';
import type {
  DraftData,
  SearchResultData,
  PriorityItem,
  TaskItem,
  ContactResult,
} from '../../stores/aiChatStore';
import { getAvatarColor } from '../../lib/constants';
import { useIsMobile } from '../../hooks/useIsMobile';


const DEFAULT_PILLS = [
  'What needs my attention?',
  "What's on my plate today?",
  'Find emails from...',
];

const THREAD_PILLS = [
  'Summarize this thread',
  'Draft a reply',
  'What are the action items?',
];

const ALL_EMAILS_PILLS = [
  'What should I respond to first?',
  'What deadlines do I have this week?',
  'Search for a topic',
];

export type AiChatScope = 'thread' | 'all';

/** Lightweight markdown → HTML for chat messages (bold, bullets, line breaks) */
function renderMarkdown(text: string): string {
  // Escape HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic (single asterisks — for progress messages)
  html = html.replace(/\*([^*]+?)\*/g, '<em>$1</em>');

  // Convert bullet lines to <li> and wrap consecutive ones in <ul>
  html = html.replace(/^• (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, (match) => {
    // Strip any trailing/inter-item newlines inside the <ul>
    const clean = match.replace(/<\/li>\n<li>/g, '</li><li>');
    return `<ul>${clean}</ul>`;
  });

  // Line breaks only outside of tags
  html = html.replace(/\n/g, '<br />');
  // Clean up any <br /> right before/after <ul> blocks
  html = html.replace(/<br \/><ul>/g, '<ul>');
  html = html.replace(/<\/ul><br \/>/g, '</ul>');

  return html;
}

export function AiChatPanel() {
  const { messages, isLoading, sendMessage, clearChat } = useAiChat();
  const { conversations, loadChat, refresh: refreshConversations } = useConversations();
  const { selectedThreadId, setSelectedThread, setPendingDraft, setHighlightText } = useUiStore();
  const { data: selectedThread } = useThread(selectedThreadId);
  const [input, setInput] = useState('');
  const [scope, setScope] = useState<AiChatScope>(selectedThreadId ? 'thread' : 'all');
  const viewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isMobile = useIsMobile();

  // Auto-switch scope: mobile always uses 'all', desktop follows thread selection
  useEffect(() => {
    if (isMobile) {
      setScope('all');
    } else if (selectedThreadId) {
      setScope('thread');
    }
  }, [selectedThreadId, isMobile]);

  const suggestionPills = useMemo(() => {
    if (scope === 'all') return selectedThreadId ? ALL_EMAILS_PILLS : DEFAULT_PILLS;
    return selectedThreadId ? THREAD_PILLS : DEFAULT_PILLS;
  }, [scope, selectedThreadId]);

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [messages.length, isLoading]);

  const handleSend = (text?: string) => {
    const msg = text ?? input;
    if (!msg.trim() || isLoading) return;
    sendMessage(msg.trim(), scope);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const stripHtml = (html: string) =>
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const handleCreateDraft = (draft: DraftData) => {
    const plainBody = stripHtml(draft.body);
    setPendingDraft({
      body: plainBody,
      bodyHtml: draft.body,
      to: draft.to,
      subject: draft.subject,
      threadId: draft.threadId,
      aiOriginal: { body: plainBody },
    });
    if (draft.threadId) {
      setSelectedThread(draft.threadId);
    }
  };

  const isEmpty = messages.length === 0;

  /** Shared message content renderer (rich cards, follow-ups, actions) */
  const renderMessageContent = (msg: typeof messages[0]) => (
    <>
      {/* Priority inbox cards */}
      {msg.priorityInbox && msg.priorityInbox.length > 0 && (
        <PriorityInboxCards
          items={msg.priorityInbox}
          onNavigate={(threadId) => {
            setSelectedThread(threadId);
            useUiStore.getState().setSelectedFolder('inbox');
          }}
        />
      )}

      {/* Task list */}
      {msg.tasks && msg.tasks.length > 0 && (
        <TaskListView
          items={msg.tasks}
          onNavigate={(threadId) => {
            setSelectedThread(threadId);
            useUiStore.getState().setSelectedFolder('inbox');
          }}
        />
      )}

      {/* Contact cards */}
      {msg.contactResults && msg.contactResults.length > 0 && (
        <ContactCards
          contacts={msg.contactResults}
          onSelectContact={(contact) => {
            handleSend(`Use ${contact.email}${contact.name ? ` (${contact.name})` : ''}`);
          }}
          onSearchContact={(email) => {
            handleSend(`Show me recent emails with ${email}`);
          }}
          onSearchAndSelect={(query) => handleSend(query)}
        />
      )}

      {/* Search result cards — filtered to relevant ones */}
      {msg.searchResults && msg.searchResults.length > 0 && (() => {
        const refIds = msg.threadReferences
          ? new Set(msg.threadReferences.map((r) => r.id))
          : null;
        const filtered = refIds && refIds.size > 0
          ? msg.searchResults.filter((r) => refIds.has(r.threadId))
          : msg.searchResults.slice(0, 3);
        if (filtered.length === 0) return null;
        return (
          <SearchResultCards
            results={filtered}
            onNavigate={(threadId, highlightSnippet) => {
              setSelectedThread(threadId);
              useUiStore.getState().setSelectedFolder('inbox');
              if (highlightSnippet) setHighlightText(highlightSnippet);
            }}
            searchTerm={(() => {
              const msgIdx = messages.indexOf(msg);
              const userMsg = msgIdx > 0 ? messages[msgIdx - 1] : null;
              return userMsg?.role === 'user' ? userMsg.content : undefined;
            })()}
          />
        );
      })()}

      {/* Thread references (fallback for non-search responses) */}
      {!msg.searchResults && msg.threadReferences && msg.threadReferences.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {msg.threadReferences.map((ref) => {
            const msgIdx = messages.indexOf(msg);
            const userMsg = msgIdx > 0 ? messages[msgIdx - 1] : null;
            const searchTerm = userMsg?.role === 'user' ? userMsg.content : null;
            return (
              <button
                key={ref.id}
                onClick={() => {
                  setSelectedThread(ref.id);
                  if (searchTerm) setHighlightText(searchTerm);
                }}
                className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-primary backdrop-blur-sm transition-colors hover:bg-white"
              >
                {ref.subject}
                <ExternalLink className="h-2.5 w-2.5" />
              </button>
            );
          })}
        </div>
      )}

      {/* Draft email preview card */}
      {msg.draft && (
        <div className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-white">
          <div className="flex items-center gap-2 border-b border-border/40 bg-surface/50 px-3 py-2">
            <FileText className="h-3.5 w-3.5 text-primary" />
            <span className="text-[11px] font-semibold text-text-primary">Draft</span>
          </div>
          <div className="px-3 py-2.5">
            {msg.draft.to && (
              <div className="mb-1 flex items-baseline gap-1.5">
                <span className="text-[11px] font-medium text-text-tertiary">To:</span>
                <span className="text-[12px] text-text-primary">{msg.draft.to}</span>
              </div>
            )}
            {msg.draft.subject && (
              <div className="mb-2 flex items-baseline gap-1.5">
                <span className="text-[11px] font-medium text-text-tertiary">Subject:</span>
                <span className="text-[12px] font-medium text-text-primary">{msg.draft.subject}</span>
              </div>
            )}
            <div
              className="prose prose-sm max-w-none text-[12px] leading-relaxed text-text-secondary [&_p]:my-1"
              dangerouslySetInnerHTML={{ __html: msg.draft.body }}
            />
          </div>
          <div className="border-t border-border/40 px-3 py-2">
            <button
              onClick={() => handleCreateDraft(msg.draft!)}
              className="w-full rounded-lg bg-primary py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-primary-hover"
            >
              Create Draft
            </button>
            {msg.draft.correctionsApplied != null && msg.draft.correctionsApplied > 0 && (
              <p className="mt-1.5 text-center text-[10px] text-text-tertiary">
                Adapted to your style ({msg.draft.correctionsApplied} {msg.draft.correctionsApplied === 1 ? 'correction' : 'corrections'} learned)
              </p>
            )}
          </div>
        </div>
      )}

      {/* Response actions */}
      <div className={`mt-2 flex items-center gap-1`}>
        <button
          onClick={() => copyToClipboard(msg.content)}
          className={`rounded-lg ${isMobile ? 'p-2' : 'p-1'} text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary`}
          title="Copy"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          className={`rounded-lg ${isMobile ? 'p-2' : 'p-1'} text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary`}
          title="Good response"
        >
          <ThumbsUp className="h-3.5 w-3.5" />
        </button>
        <button
          className={`rounded-lg ${isMobile ? 'p-2' : 'p-1'} text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary`}
          title="Bad response"
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Dynamic follow-up pills */}
      {msg.id === messages.filter((m) => m.role === 'assistant').at(-1)?.id && !isLoading && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {msg.draft && (
            <>
              <FollowUpPill label="Make it shorter" onClick={() => handleSend('Make it shorter')} />
              <FollowUpPill label="More formal" onClick={() => handleSend('More formal')} />
              <FollowUpPill label="More casual" onClick={() => handleSend('More casual')} />
            </>
          )}
          {!msg.draft && msg.content.includes('**Summary**') && (
            <>
              <FollowUpPill label="Draft a reply" onClick={() => handleSend('Draft a reply')} />
              <FollowUpPill label="What questions are unanswered?" onClick={() => handleSend('What questions are unanswered?')} />
            </>
          )}
          {!msg.draft && msg.content.includes('**Action Items**') && !msg.content.includes('**Summary**') && (
            <FollowUpPill label="Draft follow-up for overdue items" onClick={() => handleSend('Draft a follow-up email for any overdue or pending items')} />
          )}
          {msg.priorityInbox && msg.priorityInbox.length > 0 && (
            <>
              <FollowUpPill label="Draft replies for top ones" onClick={() => handleSend('Draft quick replies for the top 3 most urgent emails')} />
              <FollowUpPill label="Just show urgent" onClick={() => handleSend('Show me only the urgent ones')} />
            </>
          )}
          {msg.tasks && msg.tasks.length > 0 && (
            <>
              <FollowUpPill label="Which are overdue?" onClick={() => handleSend('Which of these are overdue?')} />
              <FollowUpPill label="Draft follow-up for pending" onClick={() => handleSend('Draft follow-up emails for pending tasks')} />
            </>
          )}
          {msg.contactResults && msg.contactResults.length > 0 && (
            <>
              <FollowUpPill label="Show recent emails" onClick={() => handleSend(`Show me recent emails from ${msg.contactResults![0].email}`)} />
              <FollowUpPill label="Draft an email" onClick={() => handleSend(`Draft an email to ${msg.contactResults![0].name || msg.contactResults![0].email}`)} />
            </>
          )}
          {msg.searchResults && msg.searchResults.length > 0 && !msg.draft && !msg.priorityInbox && (
            <>
              <FollowUpPill label="Read the first thread" onClick={() => handleSend('Read the first thread in detail and tell me what it says')} />
              <FollowUpPill label="Search something else" onClick={() => handleSend('Search for ')} />
            </>
          )}
        </div>
      )}
    </>
  );

  const loadingDots = (
    <div className="flex items-center gap-1.5 py-2">
      <div className="typing-dot h-1.5 w-1.5 rounded-full bg-secondary" />
      <div className="typing-dot h-1.5 w-1.5 rounded-full bg-secondary" />
      <div className="typing-dot h-1.5 w-1.5 rounded-full bg-secondary" />
    </div>
  );

  /* ── Mobile input bar (shared between empty & conversation views) ── */
  const mobileInputBar = (
    <div className="shrink-0 border-t border-border/40 bg-white px-3 py-2">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
          placeholder={isEmpty ? 'Ask anything...' : 'Ask a follow-up...'}
          disabled={isLoading}
          rows={1}
          className="min-h-[36px] flex-1 resize-none rounded-2xl border border-border bg-gray-50 px-4 py-2 text-[15px] leading-snug text-text-primary placeholder:text-text-tertiary outline-none disabled:opacity-50"
          style={{ fontSize: '16px' }}
        />
        <button
          onClick={() => handleSend()}
          disabled={!input.trim() || isLoading}
          className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-white transition-colors disabled:opacity-30"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  // ── MOBILE LAYOUT ──
  if (isMobile) {
    return (
      <div className="flex h-full flex-col bg-white">
        {isEmpty ? (
          <>
            {/* Centered content area */}
            <div className="flex flex-1 flex-col items-center justify-center px-5">
              <h2 className="text-[20px] font-semibold text-text-primary">
                How can I help you?
              </h2>

              {/* Suggestion pills — stacked */}
              <div className="mt-5 flex w-full flex-col gap-2 px-4">
                {suggestionPills.map((pill) => (
                  <button
                    key={pill}
                    onClick={() => handleSend(pill)}
                    className="w-full rounded-full border border-text-tertiary/30 px-4 py-2.5 text-[14px] text-text-secondary transition-colors active:bg-secondary/10 active:border-secondary/40 active:text-secondary"
                  >
                    {pill}
                  </button>
                ))}
              </div>

              {/* Recent conversations */}
              {conversations.length > 0 && (
                <div className="mt-6 w-full">
                  <p className="mb-2 text-center text-[10px] font-medium uppercase tracking-wider text-text-tertiary/60">
                    Recent
                  </p>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {conversations.slice(0, 6).map((conv) => (
                      <button
                        key={conv.id}
                        onClick={() => loadChat(conv.id)}
                        className="max-w-[180px] truncate rounded-full border border-text-tertiary/20 px-3 py-1.5 text-[12px] text-text-tertiary transition-colors active:border-text-secondary/40 active:text-text-secondary"
                        title={conv.title}
                      >
                        {conv.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Bottom input */}
            {mobileInputBar}
          </>
        ) : (
          <>
            {/* Top bar */}
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="text-[16px] font-semibold text-text-primary">Orbi AI</span>
              <button
                onClick={() => { clearChat(); refreshConversations(); }}
                className="rounded-full p-2 text-text-tertiary active:bg-surface"
              >
                <Plus className="h-5 w-5" />
              </button>
            </div>

            {/* Messages — native scroll */}
            <div ref={viewportRef} className="flex-1 overflow-y-auto overscroll-y-contain px-4 py-2">
              <div className="space-y-3">
                {messages.map((msg) => (
                  <div key={msg.id}>
                    {msg.role === 'user' ? (
                      <div className="flex justify-end">
                        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-secondary/15 px-4 py-2.5 text-[15px] leading-relaxed text-text-primary">
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="max-w-[95%]">
                        <div
                          className="prose prose-sm max-w-none text-[15px] leading-relaxed text-text-primary [&_strong]:font-semibold [&_em]:text-text-tertiary [&_em]:text-[13px] [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:pl-0.5"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                        />
                        {renderMessageContent(msg)}
                      </div>
                    )}
                  </div>
                ))}
                {isLoading && loadingDots}
              </div>
            </div>

            {/* Bottom input */}
            {mobileInputBar}
          </>
        )}
      </div>
    );
  }

  // ── DESKTOP LAYOUT (unchanged) ──
  return (
    <div className="flex h-full flex-col">
      {isEmpty ? (
        /* ── Shortwave-style empty state ── */
        <>
          <div className="h-2" />
          <div className="flex flex-1 flex-col items-center justify-center px-5">
            <h2 className="text-[17px] font-medium text-text-primary/80">
              How can I help you today?
            </h2>

            <div className="mt-5 w-full rounded-lg bg-surface p-4 shadow-sm">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleTextareaInput}
                onKeyDown={handleKeyDown}
                placeholder="Find, write, schedule, organize, ask anything..."
                rows={2}
                className="w-full resize-none bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary outline-none"
              />
              <div className="mt-2 flex items-center justify-between">
                <button className="rounded-lg p-1 text-text-tertiary transition-colors hover:text-text-secondary">
                  <Paperclip className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleSend()}
                  disabled={!input.trim() || isLoading}
                  className="flex h-7 w-7 items-center justify-center rounded-lg bg-secondary text-white transition-colors hover:bg-secondary/80 disabled:opacity-30"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Scope toggle + context indicator */}
            <div className="mt-4 flex items-center gap-1">
              <button
                onClick={() => setScope('thread')}
                title="This thread only"
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] transition-colors ${
                  scope === 'thread'
                    ? 'bg-secondary/15 text-secondary'
                    : 'bg-surface text-text-tertiary hover:text-text-secondary'
                }`}
              >
                <Mail className="h-3 w-3" />
                {scope === 'thread' && selectedThread && (
                  <span className="max-w-[120px] truncate">{selectedThread.subject}</span>
                )}
                {scope === 'thread' && !selectedThread && 'Thread'}
              </button>
              <button
                onClick={() => setScope('all')}
                title="Search all emails"
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] transition-colors ${
                  scope === 'all'
                    ? 'bg-secondary/15 text-secondary'
                    : 'bg-surface text-text-tertiary hover:text-text-secondary'
                }`}
              >
                <MailSearch className="h-3 w-3" />
                {scope === 'all' && 'All emails'}
              </button>
            </div>

            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {suggestionPills.map((pill) => (
                <button
                  key={pill}
                  onClick={() => handleSend(pill)}
                  className="rounded-full border border-text-tertiary/30 px-3.5 py-1.5 text-[12px] text-text-secondary transition-colors hover:border-secondary/40 hover:text-secondary"
                >
                  {pill}
                </button>
              ))}
            </div>

            <button className="mt-4 text-[11px] text-text-tertiary transition-colors hover:text-text-secondary">
              What can I ask?
            </button>

            {/* Recent conversations */}
            {conversations.length > 0 && (
              <div className="mt-6 w-full">
                <p className="mb-2 text-center text-[10px] font-medium uppercase tracking-wider text-text-tertiary/60">
                  Recent
                </p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {conversations.slice(0, 6).map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => loadChat(conv.id)}
                      className="max-w-[180px] truncate rounded-full border border-text-tertiary/20 px-3 py-1 text-[11px] text-text-tertiary transition-colors hover:border-text-secondary/40 hover:text-text-secondary"
                      title={conv.title}
                    >
                      {conv.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        /* ── Conversation view ── */
        <>
          {/* Top bar: history, new chat, collapse */}
          <div className="flex items-center justify-between px-3 py-2">
            <button
              onClick={() => { clearChat(); refreshConversations(); }}
              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
              title="Chat history"
            >
              <MessageSquareText className="h-4 w-4" />
            </button>
            <button
              onClick={() => { clearChat(); refreshConversations(); }}
              className="flex items-center gap-1.5 rounded-full border border-text-tertiary/30 px-3 py-1 text-[12px] font-medium text-text-secondary transition-colors hover:border-secondary/40 hover:text-secondary"
            >
              <Plus className="h-3.5 w-3.5" />
              New chat
            </button>
            <div className="w-7" />
          </div>

          {/* Messages */}
          <ScrollArea.Root className="min-h-0 flex-1">
            <ScrollArea.Viewport ref={viewportRef} className="h-full w-full">
              <div className="px-4 py-2">
                <div className="space-y-4">
                  {messages.map((msg) => (
                    <div key={msg.id}>
                      {msg.role === 'user' ? (
                        <div className="flex justify-end">
                          <div className="max-w-[90%] rounded-lg bg-surface px-4 py-2.5 text-[13px] leading-relaxed text-text-primary">
                            <p className="whitespace-pre-wrap">{msg.content}</p>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div
                            className="prose prose-sm max-w-none text-[13px] leading-relaxed text-text-primary [&_strong]:font-semibold [&_em]:text-text-tertiary [&_em]:text-[12px] [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:pl-0.5"
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                          />
                          {renderMessageContent(msg)}
                        </div>
                      )}
                    </div>
                  ))}

                  {isLoading && loadingDots}
                </div>
              </div>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar
              orientation="vertical"
              className="flex w-1.5 touch-none select-none p-0.5"
            >
              <ScrollArea.Thumb className="relative flex-1 rounded-full bg-white/40" />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>

          {/* Bottom input card */}
          <div className="px-3 pb-3 pt-1">
            <div className="rounded-lg bg-surface p-3 shadow-sm">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleTextareaInput}
                onKeyDown={handleKeyDown}
                placeholder="Ask a follow-up..."
                disabled={isLoading}
                rows={2}
                className="w-full resize-none bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary outline-none disabled:opacity-50"
              />
              <div className="mt-1 flex items-center justify-between">
                <button className="rounded-lg p-1 text-text-tertiary transition-colors hover:text-text-secondary">
                  <Paperclip className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleSend()}
                  disabled={!input.trim() || isLoading}
                  className="flex h-7 w-7 items-center justify-center rounded-lg bg-secondary text-white transition-colors hover:bg-secondary/80 disabled:opacity-30"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Priority Inbox Cards ──

function PriorityInboxCards({
  items,
  onNavigate,
}: {
  items: PriorityItem[];
  onNavigate: (threadId: string) => void;
}) {
  const urgencyConfig: Record<string, { color: string; label: string }> = {
    urgent: { color: 'bg-red-500', label: 'Urgent' },
    high: { color: 'bg-orange-400', label: 'High' },
    normal: { color: 'bg-blue-400', label: 'Normal' },
    low: { color: 'bg-gray-300', label: 'Low' },
  };

  return (
    <div className="mt-3 space-y-1.5">
      {items.map((item, i) => {
        const urg = urgencyConfig[item.urgency || 'normal'] || urgencyConfig.normal;
        const avatarColor = getAvatarColor(item.fromName);
        const initial = item.fromName.charAt(0).toUpperCase();

        return (
          <button
            key={item.emailId}
            onClick={() => onNavigate(item.threadId)}
            className="group flex w-full items-start gap-2.5 rounded-lg border border-border/60 bg-white px-3 py-2.5 text-left transition-all hover:border-primary/30 hover:shadow-sm"
          >
            {/* Rank number */}
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary/10 text-[10px] font-bold text-secondary">
              {i + 1}
            </div>

            {/* Avatar */}
            <div
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${avatarColor.bg} ${avatarColor.text}`}
            >
              {initial}
            </div>

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[12px] font-semibold text-text-primary">
                  {item.fromName}
                </span>
                {/* Urgency dot */}
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${urg.color}`} title={urg.label} />
                {/* Category pill */}
                {item.category && item.category !== 'other' && (
                  <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[9px] font-medium text-text-tertiary">
                    {item.category.replace(/_/g, ' ')}
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-text-tertiary">
                  {item.daysSinceReceived === 0
                    ? 'today'
                    : item.daysSinceReceived === 1
                      ? 'yesterday'
                      : `${item.daysSinceReceived}d ago`}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] font-medium text-text-secondary">
                {item.subject}
              </p>
              {item.classificationSummary && (
                <p className="mt-0.5 truncate text-[10px] text-text-tertiary">
                  {item.classificationSummary}
                </p>
              )}
              {/* Indicators */}
              <div className="mt-1 flex items-center gap-2">
                {item.hasOpenTasks && (
                  <span className="flex items-center gap-0.5 text-[9px] text-amber-600">
                    <ListTodo className="h-2.5 w-2.5" />
                    Tasks
                  </span>
                )}
                {item.isFollowedUp && (
                  <span className="flex items-center gap-0.5 text-[9px] text-blue-500">
                    <Clock className="h-2.5 w-2.5" />
                    Following up
                  </span>
                )}
              </div>
            </div>

            <ExternalLink className="mt-1 h-3 w-3 shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        );
      })}
    </div>
  );
}

// ── Task List View ──

function TaskListView({
  items,
  onNavigate,
}: {
  items: TaskItem[];
  onNavigate: (threadId: string) => void;
}) {
  const typeIcons: Record<string, typeof CalendarClock> = {
    DEADLINE: CalendarClock,
    PROMISE: CheckCircle2,
    ACTION_ITEM: ListTodo,
    CHANGE_REQUEST: AlertCircle,
  };

  const now = new Date();

  return (
    <div className="mt-3 space-y-1">
      {items.map((task, i) => {
        const Icon = typeIcons[task.taskType] || ListTodo;
        const deadline = task.deadline ? new Date(task.deadline) : null;
        const isOverdue = deadline && deadline < now && task.status === 'OPEN';
        const isDueSoon =
          deadline &&
          !isOverdue &&
          deadline.getTime() - now.getTime() < 3 * 24 * 60 * 60 * 1000 &&
          task.status === 'OPEN';

        return (
          <button
            key={`${task.threadId}-${i}`}
            onClick={() => onNavigate(task.threadId)}
            className="group flex w-full items-start gap-2.5 rounded-lg border border-border/60 bg-white px-3 py-2 text-left transition-all hover:border-primary/30 hover:shadow-sm"
          >
            <Icon
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                isOverdue
                  ? 'text-red-500'
                  : isDueSoon
                    ? 'text-amber-500'
                    : task.status === 'DONE'
                      ? 'text-green-500'
                      : 'text-text-tertiary'
              }`}
            />
            <div className="min-w-0 flex-1">
              <p
                className={`text-[12px] leading-snug ${
                  task.status === 'DONE'
                    ? 'text-text-tertiary line-through'
                    : 'text-text-primary'
                }`}
              >
                {task.description}
              </p>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-tertiary">
                {deadline && (
                  <span
                    className={
                      isOverdue
                        ? 'font-medium text-red-500'
                        : isDueSoon
                          ? 'font-medium text-amber-500'
                          : ''
                    }
                  >
                    {isOverdue ? 'Overdue: ' : 'Due: '}
                    {deadline.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                )}
                {task.contactName && (
                  <span>
                    {task.contactName}
                  </span>
                )}
                <span className="truncate">{task.threadSubject}</span>
              </div>
            </div>
            <span className="mt-0.5 shrink-0 rounded bg-surface px-1.5 py-0.5 text-[9px] font-medium text-text-tertiary">
              {task.taskType.replace(/_/g, ' ').toLowerCase()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Contact Cards ──

function ContactCardItem({
  contact,
  onSelect,
  onSearch,
}: {
  contact: ContactResult;
  onSelect: (contact: ContactResult) => void;
  onSearch: (email: string) => void;
}) {
  const avatarColor = getAvatarColor(contact.name || contact.email);
  const initial = (contact.name || contact.email).charAt(0).toUpperCase();

  return (
    <div className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-white px-3 py-2.5 text-left transition-all hover:border-primary/30 hover:shadow-sm">
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${avatarColor.bg} ${avatarColor.text}`}
      >
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {contact.name && (
            <span className="text-[12px] font-semibold text-text-primary">
              {contact.name}
            </span>
          )}
          {contact.title && (
            <span className="text-[10px] text-text-tertiary">
              {contact.title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-text-secondary">
          <span className="truncate">{contact.email}</span>
          {contact.company && (
            <span className="flex shrink-0 items-center gap-0.5 text-text-tertiary">
              <Building2 className="h-2.5 w-2.5" />
              {contact.company}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-[10px] text-text-tertiary">
          <span>{contact.emailCount} emails</span>
          {contact.lastEmailed && (
            <span>
              Last:{' '}
              {new Date(contact.lastEmailed).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              })}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        <button
          onClick={() => onSelect(contact)}
          className="rounded px-2 py-0.5 text-[10px] font-medium text-primary bg-primary/10 hover:bg-primary/20 transition-colors"
        >
          Use
        </button>
        <button
          onClick={() => onSearch(contact.email)}
          className="flex items-center justify-center rounded px-2 py-0.5 text-text-tertiary hover:text-text-secondary transition-colors"
          title="Search emails"
        >
          <MailSearch className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function ContactSearchInput({
  onSelectContact,
}: {
  onSelectContact: (contact: ContactResult) => void;
}) {
  const [query, setQuery] = useState('');
  const { data } = useContactAutocomplete(query);
  const results = (data?.data ?? []) as Array<{ id: string; email: string; name?: string; company?: string; title?: string }>;

  return (
    <div className="mt-2">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search contacts..."
        className="w-full rounded-md border border-border/60 bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
      />
      {query.trim().length >= 1 && results.length > 0 && (
        <div className="mt-1 space-y-1 rounded-md border border-border/40 bg-white p-1">
          {results.slice(0, 5).map((r) => {
            const avatarColor = getAvatarColor(r.name || r.email);
            const initial = (r.name || r.email).charAt(0).toUpperCase();
            return (
              <button
                key={r.email}
                onClick={() => {
                  onSelectContact({ email: r.email, name: r.name, company: r.company, title: r.title, emailCount: 0 });
                  setQuery('');
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-secondary transition-colors"
              >
                <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatarColor.bg} ${avatarColor.text}`}>
                  {initial}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium text-text-primary truncate">
                    {r.name || r.email}
                  </div>
                  {r.name && (
                    <div className="text-[10px] text-text-tertiary truncate">{r.email}</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ContactCards({
  contacts,
  onSelectContact,
  onSearchContact,
  onSearchAndSelect,
}: {
  contacts: ContactResult[];
  onSelectContact: (contact: ContactResult) => void;
  onSearchContact: (email: string) => void;
  onSearchAndSelect: (query: string) => void;
}) {
  return (
    <div className="mt-3 space-y-1.5">
      {contacts.map((contact) => (
        <ContactCardItem
          key={contact.email}
          contact={contact}
          onSelect={onSelectContact}
          onSearch={onSearchContact}
        />
      ))}
      <ContactSearchInput
        onSelectContact={(contact) => {
          onSearchAndSelect(`Use ${contact.email}${contact.name ? ` (${contact.name})` : ''}`);
        }}
      />
    </div>
  );
}

// ── Search Result Cards ──

/** Highlight search keywords within a snippet */
function highlightSnippet(snippet: string, searchTerm?: string): string {
  if (!searchTerm) return snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Extract meaningful keywords (skip stop words)
  const stopWords = new Set(['i', 'me', 'my', 'do', 'did', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'have', 'has', 'had', 'at', 'by', 'for', 'with', 'about', 'to', 'from', 'in', 'on', 'of', 'and', 'or', 'not', 'no', 'it', 'its', 'this', 'that', 'where', 'when', 'how', 'what', 'which', 'who', 'whom', 'any', 'all', 'ever', 'say', 'said', 'mention', 'find', 'search']);
  const keywords = searchTerm
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let escaped = snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pattern = new RegExp(`(${keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  escaped = escaped.replace(pattern, '<mark class="bg-primary/20 text-text-primary rounded px-0.5">$1</mark>');
  return escaped;
}

function SearchResultCards({
  results,
  onNavigate,
  searchTerm,
}: {
  results: SearchResultData[];
  onNavigate: (threadId: string, highlightSnippet?: string) => void;
  searchTerm?: string;
}) {
  return (
    <div className="mt-3 space-y-1.5">
      {results.map((result) => {
        const avatarColor = getAvatarColor(result.fromName);
        const initial = result.fromName.charAt(0).toUpperCase();
        // Trim snippet to ~120 chars for display
        const shortSnippet = result.snippet.length > 140
          ? result.snippet.slice(0, 140).replace(/\s\S*$/, '') + '...'
          : result.snippet;

        // Pick the snippet sentence most relevant to the search, for highlighting.
        // Split on sentence/line boundaries and score by keyword overlap with searchTerm.
        const sentences = result.snippet.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 10);
        let highlightChunk = (sentences[0] || result.snippet.slice(0, 60)).trim();
        if (searchTerm && sentences.length > 1) {
          const sw = new Set(['i','me','my','do','did','the','a','an','is','are','was','were','be','have','has','had','at','by','for','with','about','to','from','in','on','of','and','or','not','no','it','this','that','where','when','how','what','which','who','any','all','ever','say','said','mention','find','search']);
          const kws = searchTerm.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !sw.has(w));
          let best = sentences[0];
          let bestScore = 0;
          for (const s of sentences) {
            const lower = s.toLowerCase();
            let score = 0;
            for (const k of kws) if (lower.includes(k)) score++;
            if (score > bestScore) { bestScore = score; best = s; }
          }
          highlightChunk = best.replace(/^[•\-*]\s*/, '').trim();
        }

        return (
          <button
            key={result.emailId}
            onClick={() => onNavigate(result.threadId, highlightChunk)}
            className="group flex w-full items-start gap-2.5 rounded-lg border border-border/60 bg-white px-3 py-2.5 text-left transition-all hover:border-primary/30 hover:shadow-sm"
          >
            {/* Avatar */}
            <div
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${avatarColor.bg} ${avatarColor.text}`}
            >
              {initial}
            </div>

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[12px] font-semibold text-text-primary">
                  {result.fromName}
                </span>
                <span className="shrink-0 text-[10px] text-text-tertiary">
                  {result.date}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] font-medium text-text-secondary">
                {result.subject}
              </p>
              <p
                className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-text-tertiary"
                dangerouslySetInnerHTML={{ __html: highlightSnippet(shortSnippet, searchTerm) }}
              />
            </div>

            {/* Navigate icon */}
            <ExternalLink className="mt-1 h-3 w-3 shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        );
      })}
    </div>
  );
}

function FollowUpPill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full border border-secondary/30 px-2.5 py-1 text-[11px] text-secondary transition-colors hover:border-secondary/60 hover:bg-secondary/10"
    >
      {label}
    </button>
  );
}
