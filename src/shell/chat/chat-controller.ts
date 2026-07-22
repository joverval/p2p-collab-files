// Chat controller — chat log, unread count, rendering, sending

import { $ } from '../../shared/dom';
import { encodeChat } from '../protocol/message-envelope';

export class ChatController {
  private _logHTML = '';
  private _unread = 0;

  get unread(): number { return this._unread; }

  addLog(type: string, text: string) {
    if (text.startsWith('[CHKSUM]') || text.includes('[CHKSUM]')) return;
    const t = new Date().toLocaleTimeString();
    this._logHTML += `<div class="log-entry ${type}">[${t}] ${text}</div>`;
    const cl = document.querySelector('#chat-log');
    if (cl) {
      cl.innerHTML = this._logHTML;
      cl.scrollTop = cl.scrollHeight;
    }
    this._unread++;
    this.updateNotif();
  }

  markRead() {
    this._unread = 0;
    this.updateNotif();
  }

  updateNotif() {
    ($('chat-notif') as HTMLElement).classList.toggle('show', this._unread > 0);
  }

  sendChat(text: string, prefix: string, sendFn: (data: Uint8Array) => void) {
    const input = document.querySelector('#chat-input') as HTMLInputElement;
    if (!input) return;
    if (!text || !sendFn) return;
    sendFn(encodeChat(`${prefix}: ${text}`));
    this.addLog('sent', prefix.startsWith('[Host]') ? `[Host]: ${text}` : text);
    input.value = '';
  }
}