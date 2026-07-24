// Participants controller — user list, host/peer labels, promotion

import { el } from '../../shared/dom';
import type { RoomSnapshot } from '../../shared/types';

export interface Participant {
  email: string;
  role: 'host' | 'peer';
  participantId: string;
  connected: boolean;
  joinOrder: number;
}

export class ParticipantsController {
  private _allUsers: Participant[] = [];
  private _peerEmails: Map<string, string> = new Map();
  private _pendingPeerEmail = '';
  private _onPromote?: (email: string) => void;
  private _version = 0;
  private _lastBody: HTMLElement | null = null;
  private _lastIsHost = false;

  get allUsers(): Participant[] { return this._allUsers; }
  set onPromote(fn: ((email: string) => void) | undefined) { this._onPromote = fn; }
  get peerEmails(): Map<string, string> { return this._peerEmails; }
  set pendingPeerEmail(e: string) { this._pendingPeerEmail = e; }
  get pendingPeerEmail(): string { return this._pendingPeerEmail; }

  replaceSnapshot(snapshot: RoomSnapshot): void {
    if (snapshot.version <= this._version) return;
    this._version = snapshot.version;

    const seen = new Set<string>();
    const deduped: Participant[] = [];
    for (const p of snapshot.participants) {
      if (seen.has(p.participantId)) continue;
      seen.add(p.participantId);
      deduped.push({ ...p, email: p.email.toLowerCase().trim() });
    }

    deduped.sort((a, b) => {
      if (a.role === 'host' && b.role !== 'host') return -1;
      if (a.role !== 'host' && b.role === 'host') return 1;
      return a.joinOrder - b.joinOrder;
    });

    this._allUsers = deduped;

    // Rerender if users panel was rendered at least once
    if (this._lastBody) this.render(this._lastIsHost, this._lastBody);
  }

  /** Local initialization: replace entire list with no version gate. */
  reset(peers: Participant[]): void { this._allUsers = [...peers]; }

  userCount(): number { return this._allUsers.length; }

  render(isHost: boolean, body: HTMLElement) {
    this._lastIsHost = isHost;
    this._lastBody = body;
    body.innerHTML = '';
    for (const u of this._allUsers) {
      const idx = this._allUsers.filter(x => x.role !== 'host').indexOf(u);
      const role = u.role === 'host' ? 'Host' : `Peer ${idx >= 0 ? idx + 1 : '?'}`;
      const div = el('div', { class: 'user-panel-item' + (u.role === 'host' ? ' host' : ''), 'data-testid': 'participant-row' }, [
        el('span', {}, [u.email]),
        el('span', { class: 'role' }, [` — ${role}`]),
      ]);
      if (isHost && u.role !== 'host' && this._onPromote) {
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