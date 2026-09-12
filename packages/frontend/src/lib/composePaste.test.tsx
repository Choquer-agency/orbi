// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { afterEach, describe, expect, it } from 'vitest';
import { pasteMarkdown } from './composePaste';

const editors: Editor[] = [];
function createEditor(content = '') {
  const editor = new Editor({
    extensions: [StarterKit.configure({ heading: false, codeBlock: false }), Link.configure({ openOnClick: false })],
    content,
  });
  editors.push(editor);
  return editor;
}
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });

describe('pasting an email from Claude', () => {
  it('inserts paragraphs, bullets, and links instead of visible HTML tags', () => {
    const editor = createEditor();
    const text = [
      'Hey Tracy,', '', 'Thanks again for the feedback.', '',
      "Here's the updated page: https://example.com/updated-page", '',
      "What's now in place:", '- The two options appear side by side',
      '- The heading has been updated', '', 'Cheers,', 'Bryce',
    ].join('\n');
    expect(pasteMarkdown(editor.view, text)).toBe(true);
    const html = editor.getHTML();
    expect(html).toContain('<p>Hey Tracy,</p>');
    expect(html).toContain('<ul><li>');
    expect(html).toContain('href="https://example.com/updated-page"');
    expect(editor.getText()).toContain('The heading has been updated');
    expect(editor.getText()).not.toMatch(/<\/?(?:p|ul|li|a|br)\b/);
    expect(html).not.toContain('&lt;p&gt;');
  });

  it('replaces selected text and preserves the surrounding message', () => {
    const editor = createEditor('<p>Before REPLACE after</p>');
    editor.commands.setTextSelection({ from: 8, to: 15 });
    expect(pasteMarkdown(editor.view, '**formatted reply**')).toBe(true);
    expect(editor.getHTML()).toBe('<p>Before <strong>formatted reply</strong> after</p>');
    editor.commands.undo();
    expect(editor.getText()).toBe('Before REPLACE after');
  });

  it('leaves existing rich clipboard formatting to the normal paste handler', () => {
    const editor = createEditor('<p>Existing text</p>');
    expect(pasteMarkdown(editor.view, '- formatted text', '<ul><li>formatted text</li></ul>')).toBe(false);
    expect(editor.getText()).toBe('Existing text');
  });

  it('leaves ordinary text and literal angle brackets alone', () => {
    const editor = createEditor();
    for (const text of ['Hello Tracy', 'The value is < 10 and > 2.', '<p>literal code example</p>']) {
      expect(pasteMarkdown(editor.view, text)).toBe(false);
    }
    expect(editor.getText()).toBe('');
  });

  it('removes executable HTML and unsafe links from converted Markdown', () => {
    const editor = createEditor();
    expect(pasteMarkdown(editor.view, '**Hello**\n\n<script>alert(1)</script>\n\n<a href="javascript:alert(1)" onclick="alert(1)">Link</a>')).toBe(true);
    expect(editor.getText()).toContain('Hello');
    expect(editor.getText()).toContain('Link');
    expect(editor.getHTML()).not.toMatch(/script|onclick|javascript:|alert\(1\)/);
  });
});
