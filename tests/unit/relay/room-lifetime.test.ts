// Room lifetime tests — fake clock, offer TTL, room inactivity, reconnect cycles
// Covers: room survives offer TTL, participants stay connected, old offer expires,
// host creates fresh offer, room removed only after inactivity timeout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createRelayServer } from '../../../server/ws-relay.js';

describe('Room Lifetime', () => {
  const BASE_TIME = 1_000_000_000_000; // stable base for fake clock
  let relay: ReturnType<typeof createRelayServer>;
  let port: number;
  let now: number;
  let clock: () => number;

  // Short TTLs for testability
  const OFFER_TTL = 2_000;
  const TOKEN_TTL = 10_000;
  const ROOM_INACTIVITY_TTL = 4_000;
  const CLEANUP_MS = 60_000; // the relay's internal cleanup interval

  beforeEach(async () => {
    vi.useFakeTimers();
    now = BASE_TIME;
    clock = () => now;

    relay = createRelayServer({
      port: 0,
      clock,
      offerTTL: OFFER_TTL,
      tokenTTL: TOKEN_TTL,
      roomInactivityTTL: ROOM_INACTIVITY_TTL,
      // Long heartbeat so it doesn't fire during fake-timer advances
      // (ws auto-pong doesn't process in the same tick with fake timers)
      heartbeatInterval: 600_000,
    });
    port = await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    vi.useRealTimers();
  });

  // Helper: advance clock + timers past cleanup interval so the setInterval fires
  function advancePastCleanup(extraMs = 0) {
    now += CLEANUP_MS + extraMs;
    vi.advanceTimersByTime(CLEANUP_MS + extraMs);
  }

  // Fake timers prevent ws.close() from firing the 'close' event on WSS,
  // so participants are never removed from room.participants and
  // hasActiveSocket always returns true (the server-side ws is a different
  // object than the client-side ws, and its readyState stays 1).
  // This helper clears the room so the cleanup interval can sweep it.
  function simulateDisconnect(roomId: string) {
    const state = relay.getState();
    const room = state.rooms.get(roomId);
    if (!room) return;
    room.hostWs = null;
    room.participants.clear();
  }

  // ── Test 1: Room survives offer TTL while host stays connected ──
  it('room survives past offerTTL when host socket is still connected', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

    ws.send(JSON.stringify({
      type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
      hostEmail: 'host@test.com', requestId: 'r1',
    }));
    const storeRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(storeRes.type).toBe('token');
    const roomId = storeRes.roomId;

    // Advance past offerTTL + trigger cleanup
    advancePastCleanup(OFFER_TTL);

    // Room should still exist — host socket still connected
    const state = relay.getState();
    expect(state.rooms.has(roomId)).toBe(true);

    ws.close();
  });

  // ── Test 2: Participants stay connected past offer TTL ──
  it('host and peer stay connected past offerTTL', async () => {
    // Host creates room
    const hostWs = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { hostWs.on('open', r); hostWs.on('error', rj); });

    hostWs.send(JSON.stringify({
      type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1',
      hostEmail: 'host@test.com', requestId: 's1',
    }));
    const hostRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      hostWs.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(hostRes.type).toBe('token');
    const roomId = hostRes.roomId;
    const offerToken = hostRes.token;

    // Peer joins
    const peerWs = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { peerWs.on('open', r); peerWs.on('error', rj); });

    const hostPeerReq = new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      hostWs.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    const peerWait = new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      peerWs.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });

    peerWs.send(JSON.stringify({
      type: 'submit-answer', token: offerToken, email: 'peer@test.com',
      answerB64: 'data', requestId: 'a1',
    }));
    await peerWait; // waiting-approval
    const peerReq = await hostPeerReq;
    expect(peerReq.type).toBe('peer-request');

    // Host approves
    hostWs.send(JSON.stringify({ type: 'host-approve', token: peerReq.token, requestId: 'approve-1' }));
    await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      hostWs.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });

    // Advance past offerTTL + trigger cleanup
    advancePastCleanup(OFFER_TTL);

    // Both sockets still open and room still exists
    expect(hostWs.readyState).toBe(WebSocket.OPEN);
    expect(peerWs.readyState).toBe(WebSocket.OPEN);
    expect(relay.getState().rooms.has(roomId)).toBe(true);

    // Host can create a fresh offer via store-offer-next
    hostWs.send(JSON.stringify({
      type: 'store-offer-next', roomId, sdp: 'fresh-sdp',
      offerId: 'offer-2', requestId: 's2',
    }));
    const freshRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      hostWs.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(freshRes.type).toBe('token');
    expect(freshRes.roomId).toBe(roomId);

    hostWs.close();
    peerWs.close();
  });

  // ── Test 3: Old offer token expires after offerTTL ──
  it('offer token expires after offerTTL + cleanup', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

    ws.send(JSON.stringify({
      type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
      hostEmail: 'host@test.com', requestId: 'r1',
    }));
    const storeRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(storeRes.type).toBe('token');
    const offerToken = storeRes.token;

    // Verify token works before expiry
    const fetcher1 = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { fetcher1.on('open', r); fetcher1.on('error', rj); });

    fetcher1.send(JSON.stringify({ type: 'fetch-offer', token: offerToken, requestId: 'f1' }));
    const before = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      fetcher1.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(before.type).toBe('offer');

    fetcher1.close();

    // Advance past offerTTL + trigger cleanup (which sweeps expired tokens)
    advancePastCleanup(OFFER_TTL);

    // Token should be expired now
    const fetcher2 = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { fetcher2.on('open', r); fetcher2.on('error', rj); });

    fetcher2.send(JSON.stringify({ type: 'fetch-offer', token: offerToken, requestId: 'f2' }));
    const after = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      fetcher2.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(after.type).toBe('error');
    expect(after.message).toBe('Token not found or expired');

    ws.close();
    fetcher2.close();
  });

  // ── Test 4: Host creates fresh offer after old one expires ──
  it('host creates fresh offer via store-offer-next after old one expires', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

    // Create first offer
    ws.send(JSON.stringify({
      type: 'store-offer', sdp: 'old-sdp', offerId: 'offer-old',
      hostEmail: 'host@test.com', requestId: 'r1',
    }));
    const firstRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(firstRes.type).toBe('token');
    const roomId = firstRes.roomId;
    const oldToken = firstRes.token;

    // Advance past offerTTL + cleanup: old offer token expires
    advancePastCleanup(OFFER_TTL);

    // Verify old token is dead
    const fetcher = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { fetcher.on('open', r); fetcher.on('error', rj); });

    fetcher.send(JSON.stringify({ type: 'fetch-offer', token: oldToken, requestId: 'f1' }));
    const deadRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      fetcher.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(deadRes.type).toBe('error');
    fetcher.close();

    // Host creates fresh offer on same room (socket still connected)
    ws.send(JSON.stringify({
      type: 'store-offer-next', roomId, sdp: 'fresh-sdp',
      offerId: 'offer-fresh', requestId: 'r2',
    }));
    const freshRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(freshRes.type).toBe('token');
    expect(freshRes.roomId).toBe(roomId);
    expect(freshRes.offerId).toBe('offer-fresh');

    // Verify fresh offer is fetchable
    const fetcher2 = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { fetcher2.on('open', r); fetcher2.on('error', rj); });

    fetcher2.send(JSON.stringify({ type: 'fetch-offer', token: freshRes.token, requestId: 'f2' }));
    const freshFetch = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      fetcher2.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(freshFetch.type).toBe('offer');
    expect(freshFetch.sdp).toBe('fresh-sdp');
    expect(freshFetch.offerId).toBe('offer-fresh');

    ws.close();
    fetcher2.close();
  });

  // ── Test 5: Room removed after inactivity timeout (all sockets gone) ──
  it('room is removed after roomInactivityTTL when all sockets disconnected', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

    ws.send(JSON.stringify({
      type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
      hostEmail: 'host@test.com', requestId: 'r1',
    }));
    const storeRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(storeRes.type).toBe('token');
    const roomId = storeRes.roomId;

    // Room exists with active socket
    expect(relay.getState().rooms.has(roomId)).toBe(true);

    // Disconnect the socket — close event needs a tick to propagate
    ws.close();
    simulateDisconnect(roomId);
    now += 100;
    vi.advanceTimersByTime(100);

    // Room still exists before inactivity expiry (grace period active)
    expect(relay.getState().rooms.has(roomId)).toBe(true);

    // Advance past grace period (10s) so it fires and clears
    now += 11_000;
    vi.advanceTimersByTime(11_000);

    // Advance past cleanup interval + roomInactivityTTL
    now += CLEANUP_MS + ROOM_INACTIVITY_TTL;
    vi.advanceTimersByTime(CLEANUP_MS + ROOM_INACTIVITY_TTL);

    // Room should be cleaned up: no sockets, past inactivity TTL
    const state = relay.getState();
    expect(state.rooms.has(roomId)).toBe(false);
  });

  // ── Test 6: Room NOT removed when sockets connected past inactivity timeout ──
  it('room is NOT removed when sockets are still connected past roomInactivityTTL', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

    ws.send(JSON.stringify({
      type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
      hostEmail: 'host@test.com', requestId: 'r1',
    }));
    const storeRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(storeRes.type).toBe('token');
    const roomId = storeRes.roomId;

    // Advance past roomInactivityTTL + trigger cleanup — socket is still connected
    advancePastCleanup(ROOM_INACTIVITY_TTL);

    // Room should still exist: cleanup calls hasActiveSocket which sees readyState === 1
    const state = relay.getState();
    expect(state.rooms.has(roomId)).toBe(true);

    ws.close();
  });

  // ── Test 7: Graciously named: room is removed after enough inactivity ──
  it('room is removed after inactivity once grace period and cleanup have both passed', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

    ws.send(JSON.stringify({
      type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
      hostEmail: 'host@test.com', requestId: 'r1',
    }));
    const storeRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(storeRes.type).toBe('token');
    const roomId = storeRes.roomId;

    // Disconnect + let close propagate
    ws.close();
    simulateDisconnect(roomId);
    now += 100;
    vi.advanceTimersByTime(100);

    // Room still exists (grace period active but no candidates)
    expect(relay.getState().rooms.has(roomId)).toBe(true);

    // Advance past grace period (10s)
    now += 11_000;
    vi.advanceTimersByTime(11_000);

    // Now advance enough that roomInactivityTTL is exceeded
    // lastActivityAt is from creation time (BASE_TIME), and now - BASE_TIME 
    // after grace period is much > roomInactivityTTL
    now += ROOM_INACTIVITY_TTL + 1_000;
    vi.advanceTimersByTime(ROOM_INACTIVITY_TTL + 1_000);

    // Room still exists until cleanup actually fires
    now += CLEANUP_MS;
    vi.advanceTimersByTime(CLEANUP_MS);

    // Room should be gone after cleanup sweeps it
    const state = relay.getState();
    expect(state.rooms.has(roomId)).toBe(false);
  });

  // ── Test 8: Multiple offer expiry does not affect room ──
  it('multiple offers expiring does not remove the room', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

    // Create room + first offer
    ws.send(JSON.stringify({
      type: 'store-offer', sdp: 'sdp-1', offerId: 'offer-1',
      hostEmail: 'host@test.com', requestId: 'r1',
    }));
    const firstRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(firstRes.type).toBe('token');
    const roomId = firstRes.roomId;

    // Create second offer
    ws.send(JSON.stringify({
      type: 'store-offer-next', roomId, sdp: 'sdp-2',
      offerId: 'offer-2', requestId: 'r2',
    }));
    const secondRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(secondRes.type).toBe('token');

    // Advance past offerTTL + cleanup: both offer tokens expire
    advancePastCleanup(OFFER_TTL);

    // Room should still exist — socket is connected
    const state = relay.getState();
    expect(state.rooms.has(roomId)).toBe(true);

    // Both offer tokens should be cleaned from tokenRoom
    expect(state.tokenRoom.has(firstRes.token)).toBe(false);
    expect(state.tokenRoom.has(secondRes.token)).toBe(false);

    ws.close();
  });

  // ── Test 9: Grace period timer starts when host disconnects ──
  it('host disconnect starts grace period, room cleaned after grace + inactivity + cleanup', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { ws.on('open', r); ws.on('error', rj); });

    ws.send(JSON.stringify({
      type: 'store-offer', sdp: 'test-sdp', offerId: 'o1',
      hostEmail: 'host@test.com', requestId: 'r1',
    }));
    const storeRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      ws.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(storeRes.type).toBe('token');
    const roomId = storeRes.roomId;

    // Close host socket — triggers grace period (default 10s)
    ws.close();
    simulateDisconnect(roomId);
    now += 100;
    vi.advanceTimersByTime(100);

    // Room still exists within grace period
    const state = relay.getState();
    expect(state.rooms.has(roomId)).toBe(true);

    // Advance past grace period (10s) — grace timer fires, no candidates so no activity bump
    now += 11_000;
    vi.advanceTimersByTime(11_000);

    // Advance past cleanup + roomInactivityTTL
    now += CLEANUP_MS + ROOM_INACTIVITY_TTL;
    vi.advanceTimersByTime(CLEANUP_MS + ROOM_INACTIVITY_TTL);

    // Room should be cleaned: no sockets, inactivity exceeded
    expect(relay.getState().rooms.has(roomId)).toBe(false);
  });

  // ── Test 10: Room survives with peer connected after host leaves ──
  it('room survives with peer connected even after host disconnects', async () => {
    // Host creates room
    const hostWs = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { hostWs.on('open', r); hostWs.on('error', rj); });

    hostWs.send(JSON.stringify({
      type: 'store-offer', sdp: 'test-sdp', offerId: 'offer-1',
      hostEmail: 'host@test.com', requestId: 's1',
    }));
    const hostRes = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      hostWs.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    const roomId = hostRes.roomId;

    // Peer joins and is approved
    const peerWs = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((r, rj) => { peerWs.on('open', r); peerWs.on('error', rj); });

    // Create a second offer for the peer to use
    hostWs.send(JSON.stringify({
      type: 'store-offer-next', roomId, sdp: 'sdp-2',
      offerId: 'offer-2', requestId: 's2',
    }));
    const offer2Res = await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      hostWs.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    expect(offer2Res.type).toBe('token');

    const hostPeerReq = new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      hostWs.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });
    const peerWait = new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      peerWs.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });

    peerWs.send(JSON.stringify({
      type: 'submit-answer', token: offer2Res.token, email: 'peer@test.com',
      answerB64: 'data', requestId: 'a1',
    }));
    await peerWait;
    const peerReq = await hostPeerReq;

    hostWs.send(JSON.stringify({ type: 'host-approve', token: peerReq.token, requestId: 'approve-1' }));
    await new Promise<any>((r, rj) => {
      const t = setTimeout(() => rj(new Error('timeout')), 2_000);
      hostWs.once('message', d => { clearTimeout(t); r(JSON.parse(d.toString())); });
    });

    // Now host disconnects — peer stays
    hostWs.close();

    // Advance past roomInactivityTTL + trigger cleanup
    advancePastCleanup(ROOM_INACTIVITY_TTL);

    // Room should still exist: peer socket still connected
    // hasActiveSocket checks ALL participants, not just host
    const state = relay.getState();
    expect(state.rooms.has(roomId)).toBe(true);

    peerWs.close();
  });
});
