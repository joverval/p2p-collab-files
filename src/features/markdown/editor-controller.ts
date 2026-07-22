// Editor controller — CodeMirror setup with yCollab

import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { yCollab } from 'y-codemirror.next';
import type * as Y from 'yjs';
import { $ } from '../../shared/dom';

export function createEditor(
  ytext: Y.Text,
  undoManager: Y.UndoManager,
  onDocChange: () => void,
  onCursorMove: (line: number, totalLines: number) => void
): EditorView {
  const extensions = [
    basicSetup, markdown(),
    EditorView.lineWrapping,
    yCollab(ytext, null, { undoManager }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const cursor = update.state.selection.main.head;
        const line = update.state.doc.lineAt(cursor);
        onCursorMove(line.number, update.state.doc.lines);
      }
      onDocChange();
    }),
    EditorView.theme({
      '&': { backgroundColor: '#0d1117' },
      '.cm-gutters': { backgroundColor: '#0d1117', borderRight: '1px solid #21262d', color: '#484f58' },
      '.cm-activeLineGutter': { backgroundColor: '#161b22' },
    }),
  ];

  return new EditorView({ doc: ytext.toString(), extensions, parent: $('editor') });
}