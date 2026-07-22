// main.ts — bootstrap entry point
// Delegates all logic to app.ts composition root

import { createApplication } from './app';

declare const __BUILD_TIME__: string;
console.log('p2p-collab-files — built', __BUILD_TIME__ || 'dev');

document.addEventListener('DOMContentLoaded', () => {
  createApplication();
});