/**
 * Vitest global setup — runs before every test file.
 *
 * Sets up jsdom globals that Vitest/jsdom doesn't provide by default
 * but that the code under test may reference.
 */

// Stub globals that some browser APIs expect in jsdom
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  // jsdom provides crypto.getRandomValues but not randomUUID in some Node versions
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => {
      // Simple UUID v4 generator for test environments
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    },
    configurable: true,
  });
}

// Stub RTCPeerConnection for unit tests that don't need real WebRTC
if (typeof globalThis.RTCPeerConnection === 'undefined') {
  (globalThis as any).RTCPeerConnection = class MockRTCPeerConnection {
    onicecandidate: ((event: any) => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    ondatachannel: ((event: any) => void) | null = null;
    iceConnectionState = 'new';
    localDescription: any = null;
    remoteDescription: any = null;

    createDataChannel(_label: string) {
      return {
        onopen: null,
        onmessage: null,
        onclose: null,
        send: () => {},
        close: () => {},
      };
    }

    createOffer() {
      return Promise.resolve({ type: 'offer', sdp: 'mock' } as any);
    }

    createAnswer() {
      return Promise.resolve({ type: 'answer', sdp: 'mock' } as any);
    }

    setLocalDescription(_desc: any) {
      this.localDescription = _desc;
      return Promise.resolve();
    }

    setRemoteDescription(_desc: any) {
      this.remoteDescription = _desc;
      return Promise.resolve();
    }

    addIceCandidate(_candidate: any) {
      return Promise.resolve();
    }

    close() {}
  };
}