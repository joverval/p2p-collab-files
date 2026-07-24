// Preview controller — markdown rendering with debounce and XSS sanitization

import { $ } from '../../shared/dom';
import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';
import type * as Y from 'yjs';

const PURIFY_CFG: Config = Object.freeze({
  ALLOWED_TAGS: [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'a',
    'code', 'pre',
    'em', 'strong',
    'br',
    'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'hr',
    'blockquote',
  ],
  FORBID_ATTR: [
    'style',
    'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur',
    'onchange', 'onsubmit', 'oninput', 'onkeydown', 'onkeyup',
    'ondblclick', 'oncontextmenu', 'oninvalid', 'onreset', 'onsearch',
    'onselect', 'onwheel', 'ondrag', 'ondrop', 'oncopy', 'oncut',
    'onpaste', 'onscroll', 'ontoggle', 'onanimationend',
    'onanimationiteration', 'onanimationstart', 'ontransitionend',
    'formaction',
  ],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
});

interface MarkedLib {
  parse(md: string): string;
}

export class PreviewController {
  private _dirty = false;
  private _timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private getYText: () => Y.Text | null) {}

  schedule(): void {
    this._dirty = true;
    if (!this._timer) this._timer = setTimeout(() => this.render(), 200);
  }

  render(): void {
    this._timer = undefined;
    const ytext = this.getYText();
    if (!ytext || !this._dirty) return;
    this._dirty = false;

    const panel = $('preview');
    if (panel.classList.contains('view-hidden')) return;

    const md = ytext.toString();
    // marked.parse() produces HTML from markdown. Fall back to
    // entity-escaped plain text if marked is unavailable — never
    // inject unsanitized HTML into the DOM.
    const marked = (window as unknown as Record<string, unknown>).marked as
      | MarkedLib
      | undefined;
    const rawHTML = marked?.parse(md) ?? md.replace(/</g, '&lt;');

    // DOMPurify strips <script>, event handlers, javascript:/data: URIs,
    // and only allows tags in PURIFY_CFG.ALLOWED_TAGS.
    panel.innerHTML = DOMPurify.sanitize(rawHTML, PURIFY_CFG) as unknown as string;
  }
}