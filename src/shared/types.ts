// Shared types for shell ↔ feature boundary

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