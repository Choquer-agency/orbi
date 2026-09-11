import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

function looksLikeMarkdown(text: string): boolean {
  if (text.length < 4) return false;
  return (
    /(^|\n)\s*(?:[-*•]|\d+\.)\s+\S/.test(text) ||
    /\*\*[^*\n]+\*\*/.test(text) ||
    /(^|\n)#{1,6}\s+\S/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    /(^|\n)>\s+\S/.test(text)
  );
}

/** Convert plain-text Markdown pastes into editor nodes, preserving rich HTML pastes. */
export function pasteMarkdown(view: EditorView, text: string, clipboardHtml?: string): boolean {
  if (clipboardHtml || !looksLikeMarkdown(text)) return false;
  const html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  const container = view.dom.ownerDocument.createElement('div');
  container.innerHTML = DOMPurify.sanitize(html);
  // handlePaste receives a ProseMirror view, which has no Tiptap `editor`
  // property. Parse HTML into the schema instead of inserting markup as text.
  const slice = ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(container);
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
  return true;
}
