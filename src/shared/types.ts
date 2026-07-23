// Shared types for shell <-> feature boundary

// ── Chat ──

export interface ChatMessage {
  id: string;
  senderEmail: string;
  senderRole: 'host' | 'peer' | 'system';
  text: string;
  timestamp: number;
}

export interface ChatEnvelope {
  type: 'chat';
  sender: string;
  senderRole: string;
  text: string;
}

export interface CollaborationFeature {
  start(context: FeatureContext): void;
  onConnected(): void;
  onDisconnected(): void;
  onPeerJoined?(peerId: string): void;
  onPeerLeft?(peerId: string): void;
  handleFeatureData(data: Uint8Array, peerId?: string): void;
  handleControlMessage?(message: string): void;
  destroy(): void;
}

export interface FeatureContext {
  isHost(): boolean;
  isConnected(): boolean;
  sendFeatureData(data: Uint8Array): void;
  sendFeatureDataToPeer(peerId: string, data: Uint8Array): void;
  broadcastFeatureDataExcept?(data: Uint8Array, excludedPeerId?: string): void;
  sendControlMessage(message: string): void;
  reportStatus(message: string): void;
}

export interface IceConfigProvider {
  getConfig(): Promise<RTCConfiguration>;
  refreshIfNeeded(): Promise<RTCConfiguration>;
}

// ── Signaling protocol types ──

/** Base signaling message — every message has a type and optional requestId. */
export interface SignalingMessage {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

// ── Incoming messages (relay → client) ──

export interface PeerRequestMessage extends SignalingMessage {
  type: 'peer-request';
  email: string;
  token: string;
  offerId: string;
  answerB64: string;
}

export interface ApprovedMessage extends SignalingMessage {
  type: 'approved';
}

export interface PromotionRequestMessage extends SignalingMessage {
  type: 'promotion-request';
  oldHostEmail: string;
  roomId: string;
  promotionId: string;
  participants?: Array<{ email: string }>;
}

export interface NewHostMessage extends SignalingMessage {
  type: 'new-host';
  hostEmail: string;
  token: string;
}

export interface ErrorMessage extends SignalingMessage {
  type: 'error';
  message: string;
}

/**
 * Relay response for request/reply pattern.
 * The relay sends back the echoed type + requestId plus response-specific fields.
 * Use inline type assertions at call sites to narrow to exact response shape.
 */
export type SignalingResponse = SignalingMessage & {
  requestId: string;
  [key: string]: unknown;
};

/** Discriminated union of all known incoming signaling messages. */
export type IncomingSignalMessage =
  | PeerRequestMessage
  | ApprovedMessage
  | PromotionRequestMessage
  | NewHostMessage
  | ErrorMessage
  | SignalingResponse;

// ── Outgoing messages (client → relay) ──

export interface StoreOfferMessage {
  type: 'store-offer';
  sdp: string;
  offerId: string;
  hostEmail: string;
}

export interface HostApproveMessage {
  type: 'host-approve';
  token: string;
}

export interface HostRejectMessage {
  type: 'host-reject';
  token: string;
}

export interface SubmitAnswerMessage {
  type: 'submit-answer';
  token: string;
  email: string;
  answerB64: string;
}

export interface FetchOfferMessage {
  type: 'fetch-offer';
  token: string;
}

export interface StoreOfferNextMessage {
  type: 'store-offer-next';
  roomId: string;
  sdp: string;
  offerId: string;
}

export interface PromotePeerMessage {
  type: 'promote-peer';
  roomId: string;
  targetEmail: string;
}

export interface StorePromotionOfferMessage {
  type: 'store-promotion-offer';
  roomId: string;
  promotionId: string;
  intendedEmail: string;
  sdp: string;
  offerId: string;
}

export interface CommitPromotionMessage {
  type: 'commit-promotion';
  roomId: string;
  promotionId: string;
  reconnectTokens: Record<string, string>;
}

/**
 * Union of all known outgoing signaling messages plus a catch-all
 * for message types not yet enumerated (prevents call-site breakage).
 */
export type OutgoingSignalMessage =
  | StoreOfferMessage
  | HostApproveMessage
  | HostRejectMessage
  | SubmitAnswerMessage
  | FetchOfferMessage
  | StoreOfferNextMessage
  | PromotePeerMessage
  | StorePromotionOfferMessage
  | CommitPromotionMessage
  | { type: string; [key: string]: unknown };