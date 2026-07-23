// Participants controller — user list, host/peer labels, promotion

import { el } from '../../shared/dom';

export interface Participant {
  email: string;
  isHost: boolean;
  participantId: string;
  connected: boolean;
  joinOrder: number;
}

export class ParticipantsController {
  private _allUsers: Participant[] = [];
  private _peerEmails: Map<string, string> = new Map();
  private _pendingPeerEmail = '';
  private _onPromote?: (email: string) => void;

  get allUsers(): Participant[] { return this._allUsers; }
  set allUsers(v: Participant[]) { this._allUsers = v; }
  set onPromote(fn: ((email: string) => void) | undefined) { this._onPromote = fn; }
  get peerEmails(): Map<string, string> { return this._peerEmails; }
  set pendingPeerEmail(e: string) { this._pendingPeerEmail = e; }
  get pendingPeerEmail(): string { return this._pendingPeerEmail; }

  replaceSnapshot(peers: Participant[]): void { this._allUsers = [...peers]; }

  userCount(): number { return this._allUsers.length; }

  render(isHost: boolean, body: HTMLElement) {
    body.innerHTML = '';
    for (const u of this._allUsers) {
      const idx = this._allUsers.filter(x => !x.isHost).indexOf(u);
      const role = u.isHost ? 'Host' : `Peer ${idx >= 0 ? idx + 1 : '?'}`;
      const div = el('div', { class: 'user-panel-item' + (u.isHost ? ' host' : ''), 'data-testid': 'participant-row' }, [
        el('span', {}, [u.email]),
        el('span', { class: 'role' }, [` — ${role}`]),
      ]);
      if (isHost && !u.isHost && this._onPromote) {
        const promoteBtn = el('button', { class: 'promote-btn', 'data-testid': 'promote-btn' }, ['👑 Promote']);
        promoteBtn.addEventListener('click', () => {
          this._onPromote!(u.email);
        });
        div.appendChild(promoteBtn);
      }
      body.appendChild(div);
    }
  }
}