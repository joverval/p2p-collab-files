// replace-snapshot.test.ts — ParticipantsController.replaceSnapshot with RoomSnapshot
// Verifies: host-first sort, joinOrder ordering, dedup, stale version rejection, render DOM
// Uses project mock infrastructure

import { describe, it, expect, beforeEach } from 'vitest';
import { ParticipantsController, type Participant } from '../../../src/shell/participants/participants-controller';
import { createMockRoom } from '../../../src/__mocks__/p2p-collab';
import type { RoomSnapshot } from '../../../src/shared/types';

function snap(participants: Participant[], version = 1, roomId = 'room-1'): RoomSnapshot {
  const host = participants.find(p => p.role === 'host');
  return { roomId, version, hostParticipantId: host?.participantId ?? 'host', participants };
}

function part(email: string, overrides?: Partial<Participant>): Participant {
  return {
    email,
    role: 'peer',
    participantId: `id-${email.replace(/[@.]/g, '-')}`,
    connected: true,
    joinOrder: 0,
    ...overrides,
  };
}

describe('replaceSnapshot', () => {
  let ctrl: ParticipantsController;

  beforeEach(() => { ctrl = new ParticipantsController(); });

  it('host appears first (role===host)', () => {
    const host = part('host@test.com', { role: 'host', joinOrder: 5 });
    const p1 = part('a@test.com', { participantId: 'a', joinOrder: 1 });
    const p2 = part('b@test.com', { participantId: 'b', joinOrder: 3 });

    ctrl.replaceSnapshot(snap([p1, host, p2]));

    expect(ctrl.allUsers[0].role).toBe('host');
    expect(ctrl.allUsers[0].email).toBe('host@test.com');
  });

  it('peers sorted by joinOrder ascending', () => {
    const host = part('host@test.com', { role: 'host', joinOrder: 99 });
    const pLast = part('last@test.com', { participantId: 'last', joinOrder: 5 });
    const pFirst = part('first@test.com', { participantId: 'first', joinOrder: 1 });
    const pMid = part('mid@test.com', { participantId: 'mid', joinOrder: 3 });

    ctrl.replaceSnapshot(snap([pLast, host, pMid, pFirst]));

    expect(ctrl.allUsers[0].role).toBe('host');
    expect(ctrl.allUsers[1].email).toBe('first@test.com');
    expect(ctrl.allUsers[2].email).toBe('mid@test.com');
    expect(ctrl.allUsers[3].email).toBe('last@test.com');
  });

  it('duplicate participantIds removed (first occurrence kept)', () => {
    const host = part('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 });
    const dup1 = part('a@test.com', { participantId: 'same-id', joinOrder: 1 });
    const dup2 = part('b@test.com', { participantId: 'same-id', joinOrder: 2 });

    ctrl.replaceSnapshot(snap([host, dup1, dup2]));

    expect(ctrl.allUsers.length).toBe(2);
    expect(ctrl.allUsers[1].email).toBe('a@test.com');
  });

  it('stale version (lower) ignored — list unchanged', () => {
    const host = part('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 });
    const peer = part('peer@test.com', { participantId: 'peer', joinOrder: 2 });

    ctrl.replaceSnapshot(snap([host, peer], 10));
    expect(ctrl.userCount()).toBe(2);

    const stale = part('stale@test.com', { participantId: 'stale', joinOrder: 1 });
    ctrl.replaceSnapshot(snap([stale], 5));
    expect(ctrl.userCount()).toBe(2);
    expect(ctrl.allUsers[0].email).toBe('host@test.com');
  });

  it('render produces DOM rows with data-testid="participant-row"', () => {
    const host = part('host@test.com', { role: 'host', participantId: 'host', joinOrder: 1 });
    const p1 = part('peer1@test.com', { participantId: 'p1', joinOrder: 2 });
    const p2 = part('peer2@test.com', { participantId: 'p2', joinOrder: 3 });

    ctrl.replaceSnapshot(snap([host, p2, p1]));

    const body = document.createElement('div');
    ctrl.render(true, body);

    const rows = body.querySelectorAll('[data-testid="participant-row"]');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('host@test.com');
    expect(rows[0].classList.contains('host')).toBe(true);
  });

  // ponytail: smoke test verifying createMockRoom is importable
  it('createMockRoom provides a valid mock', () => {
    const room = createMockRoom();
    expect(room._offerUrl).toBeDefined();
    expect(room._connectToHost).toBeDefined();
  });
});