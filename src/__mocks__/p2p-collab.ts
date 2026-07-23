// Mock for @joverval/p2p-collab — used in unit tests only
import { vi } from 'vitest';

export interface Room {
  offerUrl(): Promise<{ url: string; offerId: string }>;
  connectToHost(offerUrl: string): Promise<string>;
  acceptAnswer(offerId: string, answerUrl: string): void;
  onMessage(cb: (data: Uint8Array, peerId: string) => void): void;
  onPeerJoin(cb: (peerId: string) => void): void;
  broadcastExcept(data: Uint8Array, peerId?: string): void;
  send(data: Uint8Array): void;
  sendToPeer(peerId: string, data: Uint8Array): void;
  close(): void;
  getConnectionRoute(): Promise<{ kind: string; local?: string; remote?: string }>;
}

export type MockRoom = Room & {
  _offerUrl: ReturnType<typeof vi.fn>;
  _connectToHost: ReturnType<typeof vi.fn>;
  _acceptAnswer: ReturnType<typeof vi.fn>;
  _onMessage: ReturnType<typeof vi.fn>;
  _broadcastExcept: ReturnType<typeof vi.fn>;
  _send: ReturnType<typeof vi.fn>;
  _sendToPeer: ReturnType<typeof vi.fn>;
  _close: ReturnType<typeof vi.fn>;
  _getConnectionRoute: ReturnType<typeof vi.fn>;
  _onPeerJoinCb: ((peerId: string) => void) | null;
  _messageCb: ((data: Uint8Array, peerId: string) => void) | null;
};

export function createMockRoom(): MockRoom {
  const mock: MockRoom = {
    _offerUrl: vi.fn(),
    _connectToHost: vi.fn(),
    _acceptAnswer: vi.fn(),
    _onMessage: vi.fn(),
    _broadcastExcept: vi.fn(),
    _send: vi.fn(),
    _sendToPeer: vi.fn(),
    _close: vi.fn(),
    _getConnectionRoute: vi.fn(),
    _onPeerJoinCb: null,
    _messageCb: null,

    offerUrl() { return mock._offerUrl(); },
    connectToHost(url: string) { return mock._connectToHost(url); },
    acceptAnswer(offerId: string, answerUrl: string) { mock._acceptAnswer(offerId, answerUrl); },
    onMessage(cb: (data: Uint8Array, peerId: string) => void) {
      mock._onMessage(cb);
      mock._messageCb = cb;
    },
    onPeerJoin(cb: (peerId: string) => void) {
      mock._onPeerJoinCb = cb;
    },
    broadcastExcept(data: Uint8Array, peerId?: string) {
      mock._broadcastExcept(data, peerId);
    },
    send(data: Uint8Array) { mock._send(data); },
    sendToPeer(peerId: string, data: Uint8Array) { mock._sendToPeer(peerId, data); },
    close() { mock._close(); },
    getConnectionRoute() { return mock._getConnectionRoute(); },
  };
  return mock;
}

// P2PRoom constructor mock
export class P2PRoom implements Room {
  private _isHost: boolean;
  private _baseUrl: string;
  private _opts: any;

  constructor(isHost: boolean, baseUrl: string, opts?: any) {
    this._isHost = isHost;
    this._baseUrl = baseUrl;
    this._opts = opts;
  }

  offerUrl() { return Promise.resolve({ url: '', offerId: '' }); }
  connectToHost(_url: string) { return Promise.resolve(''); }
  acceptAnswer(_offerId: string, _answerUrl: string) { }
  onMessage(_cb: (data: Uint8Array, peerId: string) => void) { }
  onPeerJoin(_cb: (peerId: string) => void) { }
  broadcastExcept(_data: Uint8Array, _peerId?: string) { }
  send(_data: Uint8Array) { }
  sendToPeer(_peerId: string, _data: Uint8Array) { }
  close() { }
  getConnectionRoute() { return Promise.resolve({ kind: 'direct' }); }
}
