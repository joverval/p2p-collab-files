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

// Use explicit function type for vitest mocks to avoid TS2348
type Fn = (...args: any[]) => any;

export type MockRoom = Room & {
  _offerUrl: ReturnType<typeof vi.fn<Fn>>;
  _connectToHost: ReturnType<typeof vi.fn<Fn>>;
  _acceptAnswer: ReturnType<typeof vi.fn<Fn>>;
  _onMessage: ReturnType<typeof vi.fn<Fn>>;
  _broadcastExcept: ReturnType<typeof vi.fn<Fn>>;
  _send: ReturnType<typeof vi.fn<Fn>>;
  _sendToPeer: ReturnType<typeof vi.fn<Fn>>;
  _close: ReturnType<typeof vi.fn<Fn>>;
  _getConnectionRoute: ReturnType<typeof vi.fn<Fn>>;
  _onPeerJoinCb: ((peerId: string) => void) | null;
  _messageCb: ((data: Uint8Array, peerId: string) => void) | null;
};

export function createMockRoom(): MockRoom {
  const mock: MockRoom = {
    _offerUrl: vi.fn<Fn>(),
    _connectToHost: vi.fn<Fn>(),
    _acceptAnswer: vi.fn<Fn>(),
    _onMessage: vi.fn<Fn>(),
    _broadcastExcept: vi.fn<Fn>(),
    _send: vi.fn<Fn>(),
    _sendToPeer: vi.fn<Fn>(),
    _close: vi.fn<Fn>(),
    _getConnectionRoute: vi.fn<Fn>(),
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
  constructor(_isHost: boolean, _baseUrl: string, _opts?: any) {}

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