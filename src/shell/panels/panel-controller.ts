// Panel controller — right panel open/close, tab switching

import { $ } from '../../shared/dom';
import type { ChatController } from '../chat/chat-controller';
import type { ParticipantsController } from '../participants/participants-controller';

export class PanelController {
  private _currentPanel = '';
  private _sendChatFn: ((text: string) => void) | null = null;

  constructor(
    private chat: ChatController,
    private participants: ParticipantsController,
    private isHostFn: () => boolean,
    private isConnectedFn: () => boolean = () => false,
  ) {}

  setSendChat(fn: (text: string) => void) { this._sendChatFn = fn; }

  open(name: string) {
    if (this._currentPanel === name) { this.close(); return; }
    this._currentPanel = name;
    const panel = $('right-panel');
    panel.classList.remove('panel-hidden');
    $('panel-title').textContent = name === 'chat' ? '💬 Chat' : name === 'users' ? '👤 Users' : '📖 How it works';
    const body = $('panel-body');
    body.innerHTML = '';

    if (name === 'users') this.participants.render(this.isHostFn(), body);
    else if (name === 'info') this.renderInfo(body);
    else if (name === 'chat') this.renderChat(body);

    document.querySelectorAll('.panel-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-panel="${name}"]`)?.classList.add('active');
    if (name === 'chat') this.chat.markRead();
  }

  close() {
    this._currentPanel = '';
    $('right-panel').classList.add('panel-hidden');
    document.querySelectorAll('.panel-btn').forEach(b => b.classList.remove('active'));
  }

  private renderChat(body: HTMLElement) {
    body.innerHTML = `<div id="chat-log"></div>
<div class="chat-input-row"><input id="chat-input" placeholder="Type..."><button id="chat-send-btn">Send</button></div>`;
    const logEl = body.querySelector('#chat-log')!;
    const input = body.querySelector('#chat-input') as HTMLInputElement;
    const sendBtn = body.querySelector('#chat-send-btn') as HTMLButtonElement;
    const doSend = () => {
      const text = input.value.trim();
      if (!text || !this._sendChatFn) return;
      this._sendChatFn(text);
    };
    sendBtn.addEventListener('click', doSend);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });
  }

  private renderInfo(body: HTMLElement) {
    body.innerHTML = `<div class="info-section">
<h3>🖥️ Host</h3><p>1. Enter email & click <b>Create Room</b></p><p>2. Click <b>📋 Copy invite</b> and share</p><p>3. Approve or reject peers</p><p>4. If manual: paste answer URL</p>
<hr><h3>👤 Peer</h3><p>1. Open invite link from host</p><p>2. Enter email & click <b>Join Room</b></p><p>3. Wait for host approval</p><p>4. If manual: click copy & send answer</p>
<hr><h3>📝 Editing</h3><p>• <b>📂 Open</b> (host) — load .md file</p><p>• <b>💾 Save</b> — save local copy</p><p>• <b>👤 Users</b> — see connected peers</p><p>• <b>💬 Chat</b> — open chat</p></div>`;
  }
}