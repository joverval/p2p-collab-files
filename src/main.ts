// main.ts — entry point for p2p-collab-files v1.2-dev
// Delegates all logic to the modular composition root

import { createApplication } from './app';

document.addEventListener('DOMContentLoaded', () => {
  if ((window as any).__p2pBound) return;
  (window as any).__p2pBound = true;
  createApplication();
});