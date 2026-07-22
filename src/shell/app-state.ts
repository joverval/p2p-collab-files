// App state — shared shell state, replaces scattered globals

import type { Room } from '@joverval/p2p-collab';
import type { Participant } from './participants/participants-controller';

export class AppState {
  myEmail = '';
  isHost = false;
  connected = false;
  room: Room | null = null;
  ws: WebSocket | null = null;
  _token = '';
  _currentOfferId = '';
  _shareUrl = '';
  baseUrl = '';

  constructor() {
    this.baseUrl = (typeof window !== 'undefined') ? window.location.href.split('#')[0] : '';
  }
}