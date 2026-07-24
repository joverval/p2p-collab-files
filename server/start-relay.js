// start-relay.js — Entry point for the WebSocket signaling relay
// Wraps the createRelayServer factory from ws-relay.js and auto-starts it.

import { createRelayServer, logger } from './ws-relay.js';

const { start, getState } = createRelayServer();
const port = await start();

logger.info(`✅ Relay listening on ws://localhost:${port}`);

// Export for programmatic use (tests)
export { getState };