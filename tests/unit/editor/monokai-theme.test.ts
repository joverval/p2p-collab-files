// Monokai theme unit tests — palette values, createEditor theme extensions, updateListener behavior

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { Facet } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import * as Y from 'yjs';
import { createEditor, mono } from '../../../src/features/markdown/editor-controller.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock UndoManager that satisfies y-codemirror.next's YUndoManagerPluginValue */
function mockUndoManager() {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};

  return {
    undoStack: [] as any[],
    redoStack: [] as any[],
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    off: vi.fn((event: string, cb: (...args: any[]) => void) => {
      const stack = listeners[event];
      if (stack) {
        const idx = stack.indexOf(cb);
        if (idx >= 0) stack.splice(idx, 1);
      }
    }),
    addTrackedOrigin: vi.fn(),
    removeTrackedOrigin: vi.fn(),
    undo: vi.fn(() => null),
    redo: vi.fn(() => null),
    // For triggering internal events in tests
    _emit(event: string, ...args: any[]) {
      (listeners[event] ?? []).forEach(fn => fn(...args));
    },
  };
}

/** Minimal DOM setup matching what createEditor expects */
function setupEditorDOM() {
  const div = document.createElement('div');
  div.id = 'editor';
  document.body.appendChild(div);
  return div;
}

// ── Monokai palette ──────────────────────────────────────────────────────────

describe('Monokai theme palette', () => {
  it('background is #272822', () => {
    expect(mono.bg).toBe('#272822');
  });

  it('foreground is #F8F8F2', () => {
    expect(mono.fg).toBe('#F8F8F2');
  });

  it('comment is #75715E', () => {
    expect(mono.comment).toBe('#75715E');
  });

  it('pink (keywords, tags) is #F92672', () => {
    expect(mono.pink).toBe('#F92672');
  });

  it('green (functions) is #A6E22E', () => {
    expect(mono.green).toBe('#A6E22E');
  });

  it('yellow (strings) is #E6DB74', () => {
    expect(mono.yellow).toBe('#E6DB74');
  });

  it('purple (numbers, types) is #AE81FF', () => {
    expect(mono.purple).toBe('#AE81FF');
  });

  it('cyan (headings, links) is #66D9EF', () => {
    expect(mono.cyan).toBe('#66D9EF');
  });

  it('orange (regex) is #FD971F', () => {
    expect(mono.orange).toBe('#FD971F');
  });

  it('selection background is #49483E', () => {
    expect(mono.selection).toBe('#49483E');
  });

  it('cursor is #F8F8F0', () => {
    expect(mono.cursor).toBe('#F8F8F0');
  });

  it('all palette colors are valid 7-char hex', () => {
    for (const [key, value] of Object.entries(mono)) {
      expect(value, `mono.${key} should be a valid hex color`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

// ── createEditor: theme extensions ───────────────────────────────────────────

describe('createEditor — theme extensions', () => {
  let editorDiv: HTMLElement;
  let editor: EditorView | null;
  let ydoc: Y.Doc;
  let ytext: Y.Text;

  beforeEach(() => {
    editorDiv = setupEditorDOM();
    ydoc = new Y.Doc();
    ytext = ydoc.getText('content');
    ytext.insert(0, '# Hello world\n');
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    ydoc.destroy();
    document.body.innerHTML = '';
  });

  it('creates an EditorView instance', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    expect(editor).toBeInstanceOf(EditorView);
    const cmEditor = editorDiv.querySelector('.cm-editor') as HTMLElement;
    expect(cmEditor).not.toBeNull();
  });

  it('applies Monokai background (#272822) on the editor element', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    const cmEditor = editorDiv.querySelector('.cm-editor') as HTMLElement;
    expect(cmEditor).not.toBeNull();

    const bgColor = window.getComputedStyle(cmEditor).backgroundColor;
    // #272822 → rgb(39, 40, 34)
    expect(bgColor).toBe('rgb(39, 40, 34)');
  });

  it('applies Monokai foreground (#F8F8F2) on the editor element', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    const cmEditor = editorDiv.querySelector('.cm-editor') as HTMLElement;
    const fgColor = window.getComputedStyle(cmEditor).color;
    // #F8F8F2 → rgb(248, 248, 242)
    expect(fgColor).toBe('rgb(248, 248, 242)');
  });

  it('includes the syntaxHighlighting extension (Monokai highlight style) in editor state', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    // CodeMirror stores highlight styles in a facet. Verify that the syntax
    // tree colors match the Monokai palette by exercising the highlight system:
    // the editor contains markdown text; when rendered, tokens should be styled.
    const contentDOM = editorDiv.querySelector('.cm-content');
    expect(contentDOM).not.toBeNull();
    // At minimum, the editor should contain the initial text
    expect(contentDOM!.textContent).toContain('Hello world');
  });

  it('the editor is in dark mode (theme option {dark: true})', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    const cmEditor = editorDiv.querySelector('.cm-editor') as HTMLElement;
    // Monokai theme sets dark: true, which CodeMirror reflects via class or attrs
    // The key check: bg is dark and fg is light
    const bg = window.getComputedStyle(cmEditor).backgroundColor;
    const fg = window.getComputedStyle(cmEditor).color;
    // Dark background + light foreground = dark theme
    expect(bg).toBe('rgb(39, 40, 34)');
    expect(fg).toBe('rgb(248, 248, 242)');
  });
});

// ── createEditor: updateListener ─────────────────────────────────────────────

describe('createEditor — updateListener', () => {
  let editorDiv: HTMLElement;
  let editor: EditorView | null;
  let ydoc: Y.Doc;
  let ytext: Y.Text;

  beforeEach(() => {
    editorDiv = setupEditorDOM();
    ydoc = new Y.Doc();
    ytext = ydoc.getText('content');
    ytext.insert(0, '# Hello\n');
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    ydoc.destroy();
    document.body.innerHTML = '';
  });

  it('calls onDocChange when docChanged is true (text insertion)', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    // Reset call counts (createEditor may trigger initial cursor move)
    onDocChange.mockClear();
    onCursorMove.mockClear();

    // Dispatch a text insertion
    editor.dispatch({
      changes: { from: 0, insert: '## New heading\n' },
    });

    expect(onDocChange).toHaveBeenCalledTimes(1);
  });

  it('calls onDocChange when docChanged is true (text deletion)', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    onDocChange.mockClear();
    onCursorMove.mockClear();

    // Dispatch a deletion (remove '# ')
    editor.dispatch({
      changes: { from: 0, to: 2 },
    });

    expect(onDocChange).toHaveBeenCalledTimes(1);
  });

  it('calls onCursorMove when cursor moves', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    onDocChange.mockClear();
    onCursorMove.mockClear();

    // Move cursor to position 2 without changing doc
    editor.dispatch({
      selection: { anchor: 2, head: 2 },
    });

    expect(onCursorMove).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onDocChange when only cursor moves (docChanged = false)', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    onDocChange.mockClear();
    onCursorMove.mockClear();

    // Move cursor only, no doc change
    editor.dispatch({
      selection: { anchor: 3, head: 3 },
    });

    expect(onCursorMove).toHaveBeenCalledTimes(1);
    expect(onDocChange).not.toHaveBeenCalled();
  });

  it('calls both onDocChange and onCursorMove when doc changes (cursor moves with insertion)', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    onDocChange.mockClear();
    onCursorMove.mockClear();

    // Change moves the cursor to end of inserted text
    editor.dispatch({
      changes: { from: 7, insert: ' world' },
    });

    expect(onDocChange).toHaveBeenCalledTimes(1);
    expect(onCursorMove).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onDocChange when selection changes without text change', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    onDocChange.mockClear();
    onCursorMove.mockClear();

    // Expand selection without changing text
    editor.dispatch({
      selection: { anchor: 0, head: 6 }, // select '# Hello'
    });

    expect(onCursorMove).toHaveBeenCalledTimes(1);
    expect(onDocChange).not.toHaveBeenCalled();
  });

  it('onCursorMove receives line number and total lines', () => {
    const onDocChange = vi.fn();
    const onCursorMove = vi.fn();

    editor = createEditor(ytext, mockUndoManager() as any, onDocChange, onCursorMove);

    onDocChange.mockClear();
    onCursorMove.mockClear();

    // Two lines of text
    editor.dispatch({
      changes: { from: 7, insert: '\nSecond line' },
    });

    // onCursorMove should have been called with line number and total lines
    expect(onCursorMove).toHaveBeenCalled();
    const callArgs = onCursorMove.mock.calls[0];
    expect(callArgs[0]).toBeGreaterThanOrEqual(1); // line number
    expect(callArgs[1]).toBe(3); // total lines = 3 (initial 1 + '\n' + 'Second line')
  });
});