// Chat controller — typed message store, safe textContent-only rendering

import { $ } from '../../shared/dom';
import type { ChatMessage } from '../../shared/types';

export class ChatController {
  private _messages: ChatMessage[] = [];
  private _unread = 0;

  get unread(): number { return this._unread; }

  /** Append a message to the store and render it live if the chat-log element is visible. */
  addLog(senderRole: ChatMessage['senderRole'], text: string, senderEmail?: string) {
    if (text.startsWith('[CHKSUM]') || text.includes('[CHKSUM]')) return;
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      senderEmail: senderEmail || 'system',
      senderRole,
      text,
      timestamp: Date.now(),
    };
    this._messages.push(msg);
    this._unread++;
    this.updateNotif();

    const cl = document.querySelector('#chat-log');
    if (cl) {
      cl.appendChild(this._createEntry(msg));
      cl.scrollTop = cl.scrollHeight;
    }
  }

  /** Render full message history into a container element. Never uses innerHTML. */
  renderInto(container: HTMLElement) {
    // Safe clear: remove all children
    while (container.firstChild) container.removeChild(container.firstChild);
    for (const msg of this._messages) {
      container.appendChild(this._createEntry(msg));
    }
    container.scrollTop = container.scrollHeight;
  }

  markRead() {
    this._unread = 0;
    this.updateNotif();
  }

  updateNotif() {
    ($('chat-notif') as HTMLElement).classList.toggle('show', this._unread > 0);
  }

  /** Create a single log-entry element using textContent only — never innerHTML. */
  private _createEntry(msg: ChatMessage): HTMLElement {
    const t = new Date(msg.timestamp).toLocaleTimeString();
    const div = document.createElement('div');
    div.className = `log-entry ${msg.senderRole}`;
    // textContent is always safe: no injection possible
    div.textContent = `[${t}] ${msg.text}`;
    return div;
  }
}