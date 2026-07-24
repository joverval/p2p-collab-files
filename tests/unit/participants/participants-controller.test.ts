// ParticipantsController unit tests — snapshot management, join/leave, role changes, render
// Uses jsdom (via vitest config) for DOM APIs
// Updated for refactored API: reset(), replaceSnapshot(RoomSnapshot) with version gate/dedup/sort

import { describe, it, expect, beforeEach } from 'vitest';
import { ParticipantsController, type Participant } from '../../../src/shell/participants/participants-controller';

function makeParticipant(email: string, overrides?: Partial<Participant>): Participant {
  return {
    email,
    role: 'peer' as const,
    participantId: `id-${email.replace(/[@.]/g, '-')}`,
    connected: true,
    joinOrder: 0,
    ...overrides,
  };
}

function makeSnapshot(participants: Participant[], version = 1, roomId = 'room-1'): { roomId: string; version: number; hostParticipantId: string; participants: Participant[] } {
  const host = participants.find(p => p.role === 'host');
  return { roomId, version, hostParticipantId: host?.participantId ?? 'host', participants };
}

describe('ParticipantsController', () => {
  let ctrl: ParticipantsController;

  beforeEach(() => {
    ctrl = new ParticipantsController();
  });

  // reset() — local initialization without version gate
  describe('reset()', () => {
    it('resets the participant list', () => {
      ctrl.reset([
        makeParticipant('host@test.com', { role: 'host' as const, joinOrder: 1 }),
        makeParticipant('peer@test.com', { joinOrder: 2 }),
      ]);
      expect(ctrl.userCount()).toBe(2);
      expect(ctrl.allUsers[0].email).toBe('host@test.com');
      expect(ctrl.allUsers[1].email).toBe('peer@test.com');
    });

    it('reset replaces previous list', () => {
      ctrl.reset([makeParticipant('old@test.com')]);
      expect(ctrl.userCount()).toBe(1);

      ctrl.reset([makeParticipant('new@test.com')]);
      expect(ctrl.userCount()).toBe(1);
      expect(ctrl.allUsers[0].email).toBe('new@test.com');
    });

    it('reset does not version-gate', () => {
      ctrl.reset([makeParticipant('a@test.com')]);
      // Reset with different users (no version check)
      ctrl.reset([makeParticipant('b@test.com')]);
      expect(ctrl.allUsers[0].email).toBe('b@test.com');
    });
  });

  // replaceSnapshot — room snapshot with version gate, deduplication, normalization, sort
  describe('replaceSnapshot — snapshot management', () => {
    it('replaces local list with snapshot participants', () => {
      // Seed via reset
      ctrl.reset([makeParticipant('old@test.com')]);
      expect(ctrl.userCount()).toBe(1);

      const host = makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 });
      const peer = makeParticipant('peer@test.com', { participantId: 'peer-1', joinOrder: 2 });
      ctrl.replaceSnapshot(makeSnapshot([host, peer]));

      expect(ctrl.userCount()).toBe(2);
      expect(ctrl.allUsers[0].email).toBe('host@test.com');
      expect(ctrl.allUsers[1].email).toBe('peer@test.com');
    });

    it('deduplicates by participantId', () => {
      const dup1 = makeParticipant('dup@test.com', { participantId: 'same-id', joinOrder: 1 });
      const dup2 = makeParticipant('dup2@test.com', { participantId: 'same-id', joinOrder: 2 });
      const host = makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 3 });

      ctrl.replaceSnapshot(makeSnapshot([dup1, dup2, host], 1));
      // dup2 should be skipped (same participantId as dup1)
      expect(ctrl.allUsers.length).toBe(2);
    });

    it('normalizes email to lowercase and trimmed', () => {
      const p = makeParticipant('  UPPER@Test.COM  ', { participantId: 'p1', role: 'host', joinOrder: 1 });

      ctrl.replaceSnapshot(makeSnapshot([p]));

      expect(ctrl.allUsers[0].email).toBe('upper@test.com');
    });

    it('sorts host first, then by joinOrder', () => {
      const peerA = makeParticipant('a@test.com', { participantId: 'a', joinOrder: 3 });
      const host = makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 5 });
      const peerB = makeParticipant('b@test.com', { participantId: 'b', joinOrder: 1 });

      ctrl.replaceSnapshot(makeSnapshot([peerA, host, peerB], 1));

      expect(ctrl.allUsers[0].role).toBe('host');
      expect(ctrl.allUsers[0].email).toBe('host@test.com');
      // Peers sorted by joinOrder
      expect(ctrl.allUsers[1].email).toBe('b@test.com'); // joinOrder 1
      expect(ctrl.allUsers[2].email).toBe('a@test.com'); // joinOrder 3
    });

    it('rejects stale version (version <= current)', () => {
      const v1 = makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 });

      ctrl.replaceSnapshot(makeSnapshot([v1], 5));
      expect(ctrl.userCount()).toBe(1);
      expect(ctrl.allUsers[0].email).toBe('host@test.com');

      // Stale version: 3 < 5
      const stale = makeParticipant('stale@test.com', { participantId: 'p2', joinOrder: 1 });
      ctrl.replaceSnapshot(makeSnapshot([stale], 3));
      // Should NOT apply — list unchanged
      expect(ctrl.userCount()).toBe(1);
      expect(ctrl.allUsers[0].email).toBe('host@test.com');
    });

    it('applies newer version correctly', () => {
      const v1 = makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 });

      ctrl.replaceSnapshot(makeSnapshot([v1], 3));
      expect(ctrl.allUsers.length).toBe(1);

      const v2 = makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 });
      const newPeer = makeParticipant('newpeer@test.com', { participantId: 'p2', joinOrder: 2 });

      ctrl.replaceSnapshot(makeSnapshot([v2, newPeer], 5));
      expect(ctrl.allUsers.length).toBe(2);
      expect(ctrl.allUsers[1].email).toBe('newpeer@test.com');
    });

    it('rejects same version (version <= current)', () => {
      const v1 = makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 });

      ctrl.replaceSnapshot(makeSnapshot([v1], 5));
      expect(ctrl.userCount()).toBe(1);

      const different = makeParticipant('different@test.com', { participantId: 'p2', joinOrder: 1 });
      ctrl.replaceSnapshot(makeSnapshot([different], 5));
      // Same version — rejected
      expect(ctrl.userCount()).toBe(1);
      expect(ctrl.allUsers[0].email).toBe('host@test.com');
    });
  });

  // Render behavior
  describe('render behavior', () => {
    it('renders participants via reset + render (non-host)', () => {
      ctrl.reset([
        makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 }),
        makeParticipant('peer@test.com', { participantId: 'peer-1', joinOrder: 2 }),
      ]);

      const body = document.createElement('div');
      ctrl.render(false, body);

      expect(body.children.length).toBe(2);
      expect(body.querySelectorAll('[data-testid="participant-row"]').length).toBe(2);
      expect(body.querySelectorAll('[data-testid="promote-btn"]').length).toBe(0);
    });

    it('renders promote buttons when host', () => {
      ctrl.onPromote = () => {};
      ctrl.reset([
        makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 }),
        makeParticipant('peer@test.com', { participantId: 'peer-1', joinOrder: 2 }),
      ]);

      const body = document.createElement('div');
      ctrl.render(true, body);

      expect(body.querySelectorAll('[data-testid="promote-btn"]').length).toBe(1);
    });

    it('rerenders on snapshot after initial render', () => {
      ctrl.onPromote = () => {};
      ctrl.reset([
        makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 }),
      ]);

      const body = document.createElement('div');
      ctrl.render(true, body);
      expect(body.children.length).toBe(1);

      // push a new snapshot — should rerender into same body
      const host = makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 });
      const peer = makeParticipant('peer@test.com', { participantId: 'peer-1', joinOrder: 2 });
      ctrl.replaceSnapshot(makeSnapshot([host, peer], 2));

      expect(body.children.length).toBe(2);
    });

    it('promote button click calls onPromote with email', () => {
      let promotedEmail = '';
      ctrl.onPromote = (email) => { promotedEmail = email; };
      ctrl.reset([
        makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 }),
        makeParticipant('peer@test.com', { participantId: 'peer-1', joinOrder: 2 }),
      ]);

      const body = document.createElement('div');
      ctrl.render(true, body);

      const promoteBtn = body.querySelector('[data-testid="promote-btn"]') as HTMLButtonElement;
      expect(promoteBtn).toBeTruthy();
      promoteBtn.click();
      expect(promotedEmail).toBe('peer@test.com');
    });
  });

  // DOM manipulation defense
  describe('DOM manipulation defense', () => {
    it('injected promote button does not trigger onPromote', () => {
      let promoteCalled = false;
      ctrl.onPromote = () => { promoteCalled = true; };
      ctrl.reset([
        makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 }),
        makeParticipant('peer@test.com', { participantId: 'peer-1', joinOrder: 2 }),
      ]);

      // Render as non-host. No promote buttons should exist.
      const body = document.createElement('div');
      ctrl.render(false, body);
      expect(body.querySelectorAll('[data-testid="promote-btn"]').length).toBe(0);

      // Simulate DOM manipulation: inject a fake promote button
      const fakeBtn = document.createElement('button');
      fakeBtn.setAttribute('data-testid', 'promote-btn');
      fakeBtn.textContent = '👑 Promote';
      body.querySelector('[data-testid="participant-row"]')?.appendChild(fakeBtn);

      fakeBtn.click();
      expect(promoteCalled).toBe(false);
    });

    it('injected host button in non-host render has no effect', () => {
      let promoteCalled = false;
      ctrl.onPromote = () => { promoteCalled = true; };

      ctrl.reset([
        makeParticipant('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 }),
        makeParticipant('peer1@test.com', { participantId: 'peer-1', joinOrder: 2 }),
        makeParticipant('peer2@test.com', { participantId: 'peer-2', joinOrder: 3 }),
      ]);

      // Render as host (legitimate promote buttons)
      const hostBody = document.createElement('div');
      ctrl.render(true, hostBody);
      const legitBtns = hostBody.querySelectorAll('[data-testid="promote-btn"]');
      expect(legitBtns.length).toBe(2);

      // Inject a fake button
      const fakeBtn = document.createElement('button');
      fakeBtn.setAttribute('data-testid', 'promote-btn');
      fakeBtn.textContent = '👑 Promote';
      (hostBody.children[0] as HTMLElement).appendChild(fakeBtn);

      fakeBtn.click();
      expect(promoteCalled).toBe(false);

      // Legitimate button should still work
      (legitBtns[0] as HTMLButtonElement).click();
      expect(promoteCalled).toBe(true);
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('empty snapshot replaces with empty list', () => {
      ctrl.reset([makeParticipant('a@test.com', { participantId: 'a', joinOrder: 1 })]);
      ctrl.replaceSnapshot(makeSnapshot([], 1));
      expect(ctrl.userCount()).toBe(0);
    });

    it('handles duplicate participants across snapshots', () => {
      const p1 = makeParticipant('a@test.com', { participantId: 'same', role: 'host', joinOrder: 1 });
      const p2 = makeParticipant('b@test.com', { participantId: 'same', role: 'peer', joinOrder: 2 });

      ctrl.replaceSnapshot(makeSnapshot([p1, p2], 1));
      expect(ctrl.allUsers.length).toBe(1);
      expect(ctrl.allUsers[0].email).toBe('a@test.com'); // first occurrence kept
    });
  });
});