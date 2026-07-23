// Relay protocol tests — built incrementally using the proven debug-test pattern
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createRelayServer } from '../../../server/ws-relay.js';

describe('Relay Protocol', () => {
  let relay: ReturnType<typeof createRelayServer>;
  let port: number;

  beforeEach(async () => {
    relay = createRelayServer({ port: 0 });
    port = await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  // ── Test 1: store-offer → returns token, echoes requestId, roomId ≠ token ──
  it('store-offer returns token, echoes requestId, roomId ≠ token', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.send(JSON.stringify({
      type: 'store-offer',
      sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1',
      offerId: 'offer-1',
      hostEmail: 'host@test.com',
      requestId: 'req-1',
    }));

    const msg = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2000);
      ws.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });

    expect(msg.type).toBe('token');
    expect(msg.requestId).toBe('req-1');
    expect(msg.token).toBeTruthy();
    expect(msg.roomId).toBeTruthy();
    expect(msg.offerId).toBe('offer-1');
    expect(msg.token).not.toBe(msg.roomId);

    ws.close();
  });

  // ── Test 2: fetch-offer → returns stored SDP ──
  it('fetch-offer returns stored SDP', async () => {
    // Step 1: store an offer
    const host = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      host.on('open', resolve);
      host.on('error', reject);
    });

    host.send(JSON.stringify({
      type: 'store-offer',
      sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1',
      offerId: 'offer-xyz',
      hostEmail: 'host@test.com',
      requestId: 'store-1',
    }));

    const storeRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout store-offer')), 2000);
      host.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(storeRes.type).toBe('token');
    const token = storeRes.token;

    // Step 2: fetch the offer from a different connection
    const fetcher = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      fetcher.on('open', resolve);
      fetcher.on('error', reject);
    });

    fetcher.send(JSON.stringify({
      type: 'fetch-offer',
      token,
      requestId: 'fetch-1',
    }));

    const fetchRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout fetch-offer')), 2000);
      fetcher.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });

    expect(fetchRes.type).toBe('offer');
    expect(fetchRes.requestId).toBe('fetch-1');
    expect(fetchRes.sdp).toBe('v=0\r\no=- 1 2 IN IP4 127.0.0.1');
    expect(fetchRes.offerId).toBe('offer-xyz');
    expect(fetchRes.roomId).toBeTruthy();

    host.close();
    fetcher.close();
  });

  // ── Test 3: submit-answer → peer gets waiting-approval, host gets peer-request ──
  it('submit-answer sends waiting-approval to peer and peer-request to host', async () => {
    // Step 1: host stores an offer
    const hostWs = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      hostWs.on('open', resolve);
      hostWs.on('error', reject);
    });

    hostWs.send(JSON.stringify({
      type: 'store-offer',
      sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1',
      offerId: 'offer-1',
      hostEmail: 'host@test.com',
      requestId: 'store-1',
    }));

    const storeRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout store-offer')), 2000);
      hostWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(storeRes.type).toBe('token');
    const token = storeRes.token;

    // Step 2: peer connects and submits answer
    const peerWs = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      peerWs.on('open', resolve);
      peerWs.on('error', reject);
    });

    // Set up host message listener BEFORE peer sends submit-answer
    const hostMsgPromise = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for peer-request on host')), 2000);
      hostWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });

    peerWs.send(JSON.stringify({
      type: 'submit-answer',
      token,
      email: 'peer@test.com',
      answerB64: 'base64-encoded-answer',
      requestId: 'answer-1',
    }));

    // Peer gets waiting-approval
    const peerRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting-approval')), 2000);
      peerWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(peerRes.type).toBe('waiting-approval');
    expect(peerRes.requestId).toBe('answer-1');

    // Host gets peer-request
    const hostMsg = await hostMsgPromise;
    expect(hostMsg.type).toBe('peer-request');
    expect(hostMsg.email).toBe('peer@test.com');
    expect(hostMsg.answerB64).toBe('base64-encoded-answer');
    expect(hostMsg.offerId).toBe('offer-1');
    expect(hostMsg.token).toBeTruthy();

    hostWs.close();
    peerWs.close();
  });

  // ── Test 4: host-approve → peer gets approved, host gets host-approve-ack ──
  it('host-approve sends approved to peer and host-approve-ack to host', async () => {
    // Step 1: host stores an offer
    const hostWs = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      hostWs.on('open', resolve);
      hostWs.on('error', reject);
    });

    hostWs.send(JSON.stringify({
      type: 'store-offer',
      sdp: 'test-sdp',
      offerId: 'offer-1',
      hostEmail: 'host@test.com',
      requestId: 'store-1',
    }));

    const storeRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2000);
      hostWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(storeRes.type).toBe('token');
    const offerToken = storeRes.token;

    // Step 2: peer submits answer
    const peerWs = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      peerWs.on('open', resolve);
      peerWs.on('error', reject);
    });

    // Host listens for peer-request
    const peerRequestPromise = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout peer-request')), 2000);
      hostWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });

    peerWs.send(JSON.stringify({
      type: 'submit-answer',
      token: offerToken,
      email: 'peer@test.com',
      answerB64: 'answer-data',
      requestId: 'answer-1',
    }));

    // Peer gets waiting-approval
    const waitingRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting-approval')), 2000);
      peerWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(waitingRes.type).toBe('waiting-approval');

    // Host gets peer-request
    const peerReq = await peerRequestPromise;
    expect(peerReq.type).toBe('peer-request');
    const peerToken = peerReq.token;

    // Step 3: set up peer listener for approved BEFORE host sends host-approve
    const approvedPromise = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for approved')), 2000);
      peerWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });

    hostWs.send(JSON.stringify({
      type: 'host-approve',
      token: peerToken,
      requestId: 'approve-1',
    }));

    // Host should get host-approve-ack
    const ackRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout host-approve-ack')), 2000);
      hostWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(ackRes.type).toBe('host-approve-ack');
    expect(ackRes.requestId).toBe('approve-1');

    // Peer should get approved
    const approvedRes = await approvedPromise;
    expect(approvedRes.type).toBe('approved');

    hostWs.close();
    peerWs.close();
  });

  // ── Test 5: host-reject → peer gets rejected, host gets host-reject-ack ──
  it('host-reject sends rejected to peer and host-reject-ack to host', async () => {
    // Step 1: host stores an offer
    const hostWs = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      hostWs.on('open', resolve);
      hostWs.on('error', reject);
    });

    hostWs.send(JSON.stringify({
      type: 'store-offer',
      sdp: 'test-sdp',
      offerId: 'offer-1',
      hostEmail: 'host@test.com',
      requestId: 'store-1',
    }));

    const storeRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2000);
      hostWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(storeRes.type).toBe('token');
    const offerToken = storeRes.token;

    // Step 2: peer submits answer
    const peerWs = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      peerWs.on('open', resolve);
      peerWs.on('error', reject);
    });

    const peerRequestPromise = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout peer-request')), 2000);
      hostWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });

    peerWs.send(JSON.stringify({
      type: 'submit-answer',
      token: offerToken,
      email: 'peer@test.com',
      answerB64: 'answer-data',
      requestId: 'answer-1',
    }));

    // Peer gets waiting-approval
    const waitingRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2000);
      peerWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(waitingRes.type).toBe('waiting-approval');

    const peerReq = await peerRequestPromise;
    expect(peerReq.type).toBe('peer-request');
    const peerToken = peerReq.token;

    // Step 3: set up peer listener BEFORE host rejects
    const rejectedPromise = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for rejected')), 2000);
      peerWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });

    hostWs.send(JSON.stringify({
      type: 'host-reject',
      token: peerToken,
      requestId: 'reject-1',
    }));

    // Host should get host-reject-ack
    const ackRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout host-reject-ack')), 2000);
      hostWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(ackRes.type).toBe('host-reject-ack');
    expect(ackRes.requestId).toBe('reject-1');

    // Peer should get rejected
    const rejectedRes = await rejectedPromise;
    expect(rejectedRes.type).toBe('rejected');
    expect(rejectedRes.message).toBe('Host rejected');

    hostWs.close();
    peerWs.close();
  });

  // ── Test 6: store-offer-next → creates second offer in existing room ──
  it('store-offer-next creates a second offer in an existing room', async () => {
    // Step 1: create a room with store-offer
    const hostWs = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      hostWs.on('open', resolve);
      hostWs.on('error', reject);
    });

    hostWs.send(JSON.stringify({
      type: 'store-offer',
      sdp: 'first-sdp',
      offerId: 'offer-first',
      hostEmail: 'host@test.com',
      requestId: 'req-1',
    }));

    const firstRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2000);
      hostWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });
    expect(firstRes.type).toBe('token');
    const roomId = firstRes.roomId;

    // Step 2: connect a new WS (simulating host reconnecting) and store-offer-next
    const nextWs = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      nextWs.on('open', resolve);
      nextWs.on('error', reject);
    });

    nextWs.send(JSON.stringify({
      type: 'store-offer-next',
      roomId,
      sdp: 'second-sdp',
      offerId: 'offer-second',
      requestId: 'req-2',
    }));

    const nextRes = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2000);
      nextWs.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });

    expect(nextRes.type).toBe('token');
    expect(nextRes.requestId).toBe('req-2');
    expect(nextRes.roomId).toBe(roomId);
    expect(nextRes.offerId).toBe('offer-second');
    expect(nextRes.token).toBeTruthy();
    expect(nextRes.token).not.toBe(firstRes.token);

    hostWs.close();
    nextWs.close();
  });

  // ── Test 7: ping/pong ──
  it('responds to ping with pong', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.send(JSON.stringify({ type: 'ping', requestId: 'ping-1' }));

    const msg = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2000);
      ws.once('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
    });

    expect(msg.type).toBe('pong');
    expect(msg.requestId).toBe('ping-1');

    ws.close();
  });
});