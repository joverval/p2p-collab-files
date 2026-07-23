// auth.js — Time-limited TURN credential generation via HMAC-SHA1
// Used with coturn use-auth-secret mode.

import crypto from 'node:crypto';

/**
 * Generate time-limited TURN credentials compatible with coturn's REST API.
 * Used by the /turn-credentials endpoint.
 *
 * Coturn verifies by recomputing HMAC-SHA1(timestamp + username, secret)
 * and comparing to the password field. Timestamp is the expiry time.
 *
 * @param {string} secret   Shared secret (must match coturn's static-auth-secret)
 * @param {number} ttlSeconds  Credential lifetime in seconds (default: 1800 = 30 min)
 * @param {string} username    Base username (default: 'p2p')
 * @returns {{ username: string, password: string, ttl: number }}
 */
export function generateTurnCredentials(secret, ttlSeconds = 1800, username = 'p2p') {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const usernameStr = `${expiry}:${username}`;
  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(usernameStr);
  const password = hmac.digest('base64');
  return { username: usernameStr, password, ttl: ttlSeconds };
}
