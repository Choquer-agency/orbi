import { useState } from 'react';
import { Sparkles, X, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

interface ComposeInlineProps {
  threadId?: string;
  mode: 'reply' | 'forward' | 'compose';
  onClose: () => void;
}

export function ComposeInline({ threadId, mode, onClose }: ComposeInlineProps) {
  const { aiAssistOpen, toggleAiAssist } = useUiStore();
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [aiInstruction, setAiInstruction] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [sending, setSending] = useState(false);

  const handleGenerateDraft = async () => {
    if (!aiInstruction.trim()) return;
    setIsGenerating(true);
    try {
      const res = await api.post<{ data: { draftHtml: string; draftText: string; suggestedSubject: string | null } }>(
        '/ai/draft',
        {
          instruction: aiInstruction,
          threadId: threadId || null,
          accountId: '', // TODO: get from selected account
        },
      );
      setBody(res.data.draftText);
      if (res.data.suggestedSubject && !subject) {
        setSubject(res.data.suggestedSubject);
      }
    } catch (err: any) {
      console.error('AI draft failed:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSend = async () => {
    setSending(true);
    try {
      // TODO: Call send/reply API
      onClose();
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.target === document.querySelector('[data-ai-input]')) {
        handleGenerateDraft();
      } else {
        handleSend();
      }
    }
  };

  return (
    <div className="border-t border-gray-200 bg-white" onKeyDown={handleKeyDown}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
        <span className="text-xs font-medium text-gray-500 uppercase">
          {mode === 'reply' ? 'Reply' : mode === 'forward' ? 'Forward' : 'New Email'}
        </span>
        <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* To / Subject fields for forward/compose */}
      {(mode === 'forward' || mode === 'compose') && (
        <div className="border-b border-gray-100 px-4 py-2 space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 w-12">To:</label>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="flex-1 text-sm outline-none"
              placeholder="recipient@example.com"
            />
          </div>
          {mode === 'compose' && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 w-12">Subject:</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="flex-1 text-sm outline-none"
                placeholder="Subject"
              />
            </div>
          )}
        </div>
      )}

      {/* AI Assist section */}
      <div className="border-b border-gray-100">
        <button
          onClick={toggleAiAssist}
          className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-gray-50"
        >
          <span className="flex items-center gap-1.5 text-xs font-medium text-purple-600">
            <Sparkles className="h-3.5 w-3.5" />
            AI Assist
          </span>
          {aiAssistOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-gray-400" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
          )}
        </button>

        {aiAssistOpen && (
          <div className="px-4 pb-3">
            <textarea
              data-ai-input
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              placeholder="Tell the AI how to respond... e.g. 'Tell them we're on track, mockups by Friday'"
              className="w-full rounded-md border border-purple-200 bg-purple-50/50 px-3 py-2 text-sm placeholder:text-purple-300 focus:border-purple-400 focus:outline-none focus:ring-1 focus:ring-purple-400"
              rows={2}
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[10px] text-gray-400">Cmd+Enter to generate</span>
              <button
                onClick={handleGenerateDraft}
                disabled={!aiInstruction.trim() || isGenerating}
                className="flex items-center gap-1.5 rounded-md bg-purple-600 px-3 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3 w-3" />
                    Generate Draft
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Compose body */}
      <div className="px-4 py-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your message..."
          className="min-h-[120px] w-full resize-none text-sm text-gray-700 outline-none placeholder:text-gray-400"
          rows={6}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2">
        <div className="text-[10px] text-gray-400">Cmd+Enter to send</div>
        <button
          onClick={handleSend}
          disabled={!body.trim() || sending}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {sending ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
