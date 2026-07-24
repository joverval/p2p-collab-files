// Editor controller — CodeMirror setup with yCollab + Monokai theme

import { basicSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { yCollab } from 'y-codemirror.next';
import type * as Y from 'yjs';
import { $ } from '../../shared/dom';

// Monokai palette
export const mono = {
  bg:         '#272822',
  fg:         '#F8F8F2',
  comment:    '#75715E',
  pink:       '#F92672',
  green:      '#A6E22E',
  yellow:     '#E6DB74',
  purple:     '#AE81FF',
  cyan:       '#66D9EF',
  orange:     '#FD971F',
  selection:  '#49483E',
  cursor:     '#F8F8F0',
} as const;

const monokaiEditorTheme = EditorView.theme({
  '&': {
    backgroundColor: mono.bg,
    color: mono.fg,
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: mono.cursor,
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: mono.selection,
  },
  '.cm-activeLine': {
    backgroundColor: '#3E3D32',
  },
  '.cm-gutters': {
    backgroundColor: mono.bg,
    color: '#75715E',
    borderRight: '1px solid #49483E',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#3E3D32',
  },
  '.cm-matchingBracket': {
    backgroundColor: '#49483E',
    outline: '1px solid #75715E',
  },
}, { dark: true });

const monokaiHighlightStyle = HighlightStyle.define([
  { tag: tags.comment,        color: mono.comment, fontStyle: 'italic' },
  { tag: tags.keyword,        color: mono.pink },
  { tag: tags.tagName,        color: mono.pink },
  { tag: tags.string,         color: mono.yellow },
  { tag: tags.function(tags.variableName), color: mono.green },
  { tag: tags.propertyName,   color: mono.green },
  { tag: tags.number,         color: mono.purple },
  { tag: tags.typeName,       color: mono.purple },
  { tag: tags.heading,        color: mono.cyan },
  { tag: tags.link,           color: mono.cyan },
  { tag: tags.operator,       color: mono.fg },
  { tag: tags.regexp,         color: mono.orange },
  { tag: tags.invalid,        color: mono.pink, backgroundColor: '#3E2231' },
]);

export function createEditor(
  ytext: Y.Text,
  undoManager: Y.UndoManager,
  onDocChange: () => void,
  onCursorMove: (line: number, totalLines: number) => void
): EditorView {
  const extensions = [
    basicSetup,
    markdown(),
    EditorView.lineWrapping,
    monokaiEditorTheme,
    syntaxHighlighting(monokaiHighlightStyle),
    yCollab(ytext, null, { undoManager }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocChange();
      }
      if (update.docChanged || update.selectionSet) {
        const cursor = update.state.selection.main.head;
        const line = update.state.doc.lineAt(cursor);
        onCursorMove(line.number, update.state.doc.lines);
      }
    }),
  ];

  return new EditorView({ doc: ytext.toString(), extensions, parent: $('editor') });
}