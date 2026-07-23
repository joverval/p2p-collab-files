// rate-limiter.js — In-memory sliding-window rate limiter per IP
// Lightweight, no external dependencies.

export class RateLimiter {
  /**
   * @param {number} windowMs  Window size in ms (default: 60s)
   */
  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
    /** @type {Map<string, Array<{timestamp: number, count: number}>>} */
    this.counters = new Map();
  }

  /**
   * Check whether a request is allowed under the rate limit.
   * @param {string} key  Key to rate-limit (usually an IP address)
   * @param {number} limit  Maximum count in the window
   * @returns {boolean}  true if allowed, false if rate-limited
   */
  check(key, limit) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let entries = this.counters.get(key);
    if (!entries) {
      entries = [];
      this.counters.set(key, entries);
    }
    // Remove expired entries
    while (entries.length > 0 && entries[0].timestamp < cutoff) {
      entries.shift();
    }
    const current = entries.reduce((sum, e) => sum + e.count, 0);
    if (current >= limit) return false;
    // Add to last bucket or create new
    const last = entries[entries.length - 1];
    if (last && last.timestamp > now - 5000) {
      last.count++;
    } else {
      entries.push({ timestamp: now, count: 1 });
    }
    return true;
  }

  /** Periodic cleanup of stale keys (call from interval). */
  cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, entries] of this.counters) {
      while (entries.length > 0 && entries[0].timestamp < cutoff) {
        entries.shift();
      }
      if (entries.length === 0) this.counters.delete(key);
    }
  }

  /** Expose for tests. */
  _size() { return this.counters.size; }
}

/** Tracks hard limits (rooms/IP, sockets/IP, peers/room) separately from rate windows. */
export class IPTracker {
  constructor() {
    /** @type {Map<string, Set<string>>} ip -> Set<roomId> */
    this.ipRooms = new Map();
    /** @type {Map<string, Set<object>>} ip -> Set<ws> */
    this.ipSockets = new Map();
    /** @type {Map<string, Set<string>>} roomId -> Set<participantId> */
    this.roomPeers = new Map();
  }

  trackRoom(ip, roomId) {
    let s = this.ipRooms.get(ip);
    if (!s) { s = new Set(); this.ipRooms.set(ip, s); }
    s.add(roomId);
  }

  untrackRoom(ip, roomId) {
    const s = this.ipRooms.get(ip);
    if (s) {
      s.delete(roomId);
      if (s.size === 0) this.ipRooms.delete(ip);
    }
  }

  trackSocket(ip, ws) {
    let s = this.ipSockets.get(ip);
    if (!s) { s = new Set(); this.ipSockets.set(ip, s); }
    s.add(ws);
  }

  untrackSocket(ip, ws) {
    const s = this.ipSockets.get(ip);
    if (s) {
      s.delete(ws);
      if (s.size === 0) this.ipSockets.delete(ip);
    }
  }

  trackPeer(roomId, participantId) {
    let s = this.roomPeers.get(roomId);
    if (!s) { s = new Set(); this.roomPeers.set(roomId, s); }
    s.add(participantId);
  }

  untrackPeer(roomId, participantId) {
    const s = this.roomPeers.get(roomId);
    if (s) {
      s.delete(participantId);
      if (s.size === 0) this.roomPeers.delete(roomId);
    }
  }

  roomCount(ip) { return this.ipRooms.get(ip)?.size || 0; }
  socketCount(ip) { return this.ipSockets.get(ip)?.size || 0; }
  peerCount(roomId) { return this.roomPeers.get(roomId)?.size || 0; }

  /** Remove all tracking for a given ws object (call on disconnect). */
  untrackAllForWs(ws) {
    for (const [, socks] of this.ipSockets) socks.delete(ws);
  }
}
