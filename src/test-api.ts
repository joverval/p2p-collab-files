// test-api.ts — E2E test diagnostics, gated by VITE_P2P_TEST_API
// Never exposes TURN credentials, SDP, or IP addresses.
// Tree-shaken in production builds where VITE_P2P_TEST_API is not 'true'.

import type { Participant } from './shell/participants/participants-controller';
import type { MarkdownFeature } from './features/markdown/markdown-feature';
import type { SessionController } from './shell/session-controller';

export interface P2PTestAPI {
  getText(): string;
  getParticipants(): Participant[];
  getRole(): 'host' | 'peer';
  getConnectionState(): string;
  getConnectionRoute(): Promise<{ kind: string; local?: string; remote?: string } | null>;
  getRoomId(): string;
  getShareUrl(): string;
}

export function exposeTestAPI(deps: {
  feature: MarkdownFeature;
  session: SessionController;
  isHost: () => boolean;
}): void {
  // Gate: expose only when explicitly enabled
  if (import.meta.env.VITE_P2P_TEST_API !== 'true') return;

  const api: P2PTestAPI = {
    getText(): string {
      return deps.feature.text?.toString() ?? '';
    },

    getParticipants(): Participant[] {
      // Participants are tracked in the UI via participants-controller,
      // but we can derive from session's room state callbacks.
      // We return an empty array as a safe default — the E2E helpers
      // should use data-testid selectors for participant info.
      return [];
    },

    getRole(): 'host' | 'peer' {
      return deps.isHost() ? 'host' : 'peer';
    },

    getConnectionState(): string {
      return deps.session.connectionState;
    },

    getConnectionRoute(): Promise<{ kind: string; local?: string; remote?: string } | null> {
      try {
        const room = deps.session.roomRef;
        if (room && typeof room.getConnectionRoute === 'function') {
          return room.getConnectionRoute();
        }
      } catch {
        // silently return null on any error
      }
      return Promise.resolve(null);
    },

    getRoomId(): string {
      return deps.session.roomId;
    },

    getShareUrl(): string {
      return deps.session.shareUrl;
    },
  };

  (window as any).__P2P_TEST__ = api;
}