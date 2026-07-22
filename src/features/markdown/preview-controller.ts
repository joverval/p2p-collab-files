// Preview controller — markdown rendering with debounce

import { $ } from '../../shared/dom';
import type * as Y from 'yjs';

export class PreviewController {
  private _dirty = false;
  private _timer: any = undefined;

  constructor(private getYText: () => Y.Text | null) {}

  schedule() {
    this._dirty = true;
    if (!this._timer) this._timer = setTimeout(() => this.render(), 200);
  }

  render() {
    this._timer = undefined;
    const ytext = this.getYText();
    if (!ytext || !this._dirty) return;
    this._dirty = false;
    if ($('preview').classList.contains('view-hidden')) return;
    const md = ytext.toString();
    $('preview').innerHTML = (window as any).marked?.parse(md) || md.replace(/</g, '&lt;');
  }
}