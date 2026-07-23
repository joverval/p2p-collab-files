// Preview controller — markdown rendering with debounce and XSS sanitization

import { $ } from '../../shared/dom';
import { sanitizePreview } from '../../shared/dompurify-config';
import type * as Y from 'yjs';

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

    // sanitizePreview uses a hardened DOMPurify config that strips:
    // <script>, <style>, <svg>, <math>, event handlers, javascript: URIs,
    // and data: URIs (except images).
    panel.innerHTML = sanitizePreview(rawHTML);
  }
}