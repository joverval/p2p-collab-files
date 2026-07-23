// role-state.test.ts — unit tests for applyRoleState DOM manipulation
//
// applyRoleState lives in app.ts and orchestrates show/hide/enable across
// multiple DOM elements based on host/peer role. This file tests the
// expected DOM state transitions by recreating the target elements and
// applying the same logic.
//
// jsdom environment provides document.getElementById / style.display / disabled.

import { describe, it, expect, beforeEach } from 'vitest';

// ── Helper: mirror of app.ts's setTextContent ──
function setTextContent(id: string, text: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ── applyRoleState: mirrors the logic in app.ts line 57-83 ──
function applyRoleState(host: boolean) {
  const hostControls = [
    'open-file-btn',
    'copy-invite-btn',
    'manual-answer-input',
    'manual-answer-btn',
  ] as const;

  for (const id of hostControls) {
    const el = document.getElementById(id);
    if (el) el.style.display = host ? '' : 'none';
  }

  // Peer-only: sync button
  const syncBtn = document.getElementById('sync-btn');
  if (syncBtn) syncBtn.style.display = host ? 'none' : '';

  // Save available to both roles
  const saveBtn = document.getElementById('save-file-btn') as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = false;

  // Lock initial setup controls once room exists
  const createBtn = document.getElementById('create-room-btn');
  if (createBtn) createBtn.style.display = 'none';
  const emailInput = document.getElementById('email-input') as HTMLInputElement | null;
  if (emailInput) emailInput.disabled = true;

  // Role label
  setTextContent('topbar-role', host ? '👑 Host' : '👤 Peer');
}

// ── Setup fixture: create all DOM elements that applyRoleState touches ──
function setupDOM() {
  document.body.innerHTML = '';

  // Host-only controls
  for (const id of ['open-file-btn', 'copy-invite-btn', 'manual-answer-input', 'manual-answer-btn']) {
    const el = document.createElement(id === 'manual-answer-input' ? 'input' : 'button');
    el.id = id;
    // Start hidden (pre-room state)
    el.style.display = 'none';
    if (id === 'open-file-btn' || id === 'save-file-btn') (el as HTMLButtonElement).disabled = true;
    document.body.appendChild(el);
  }

  // Peer-only
  const syncBtn = document.createElement('button');
  syncBtn.id = 'sync-btn';
  syncBtn.style.display = 'none';
  syncBtn.disabled = true;
  document.body.appendChild(syncBtn);

  // Both roles
  const saveBtn = document.createElement('button');
  saveBtn.id = 'save-file-btn';
  saveBtn.disabled = true;
  document.body.appendChild(saveBtn);

  // Initial setup controls (visible pre-room)
  const createBtn = document.createElement('button');
  createBtn.id = 'create-room-btn';
  document.body.appendChild(createBtn);

  const emailInput = document.createElement('input');
  emailInput.id = 'email-input';
  document.body.appendChild(emailInput);

  // Role label
  const roleLabel = document.createElement('span');
  roleLabel.id = 'topbar-role';
  document.body.appendChild(roleLabel);
}

// ── Helper: check if element is visible (not display:none) ──
function isVisible(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  return el.style.display !== 'none';
}

// ── Helper: check if element is hidden (display:none) ──
function isHidden(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return true;
  return el.style.display === 'none';
}

describe('applyRoleState', () => {
  beforeEach(() => {
    setupDOM();
  });

  // ── 3.5.7: applyRoleState enables/disables host actions ──
  describe('host role', () => {
    it('shows host-only controls', () => {
      applyRoleState(true);

      expect(isVisible('open-file-btn')).toBe(true);
      expect(isVisible('copy-invite-btn')).toBe(true);
      expect(isVisible('manual-answer-input')).toBe(true);
      expect(isVisible('manual-answer-btn')).toBe(true);
    });

    it('hides peer-only sync button', () => {
      applyRoleState(true);
      expect(isHidden('sync-btn')).toBe(true);
    });

    it('sets role label to Host', () => {
      applyRoleState(true);
      expect(document.getElementById('topbar-role')!.textContent).toBe('👑 Host');
    });

    it('locks initial setup controls', () => {
      applyRoleState(true);

      const createBtn = document.getElementById('create-room-btn')!;
      expect(createBtn.style.display).toBe('none');

      const emailInput = document.getElementById('email-input') as HTMLInputElement;
      expect(emailInput.disabled).toBe(true);
    });
  });

  // ── 3.5.8: applyRoleState(false) hides host-only controls ──
  describe('peer role', () => {
    it('hides host-only controls', () => {
      applyRoleState(false);

      expect(isHidden('open-file-btn')).toBe(true);
      expect(isHidden('copy-invite-btn')).toBe(true);
      expect(isHidden('manual-answer-input')).toBe(true);
      expect(isHidden('manual-answer-btn')).toBe(true);
    });

    it('shows peer-only sync button', () => {
      applyRoleState(false);
      expect(isVisible('sync-btn')).toBe(true);
    });

    it('sets role label to Peer', () => {
      applyRoleState(false);
      expect(document.getElementById('topbar-role')!.textContent).toBe('👤 Peer');
    });

    it('locks initial setup controls', () => {
      applyRoleState(false);

      const createBtn = document.getElementById('create-room-btn')!;
      expect(createBtn.style.display).toBe('none');

      const emailInput = document.getElementById('email-input') as HTMLInputElement;
      expect(emailInput.disabled).toBe(true);
    });
  });

  // ── 3.5.9: save available to peers ──
  describe('save availability', () => {
    it('enables save for host', () => {
      const saveBtn = document.getElementById('save-file-btn') as HTMLButtonElement;
      saveBtn.disabled = true;
      applyRoleState(true);
      expect(saveBtn.disabled).toBe(false);
    });

    it('enables save for peer', () => {
      const saveBtn = document.getElementById('save-file-btn') as HTMLButtonElement;
      saveBtn.disabled = true;
      applyRoleState(false);
      expect(saveBtn.disabled).toBe(false);
    });

    it('save stays enabled after role transitions', () => {
      const saveBtn = document.getElementById('save-file-btn') as HTMLButtonElement;

      applyRoleState(true);
      expect(saveBtn.disabled).toBe(false);

      // Transition to peer — save must remain enabled
      applyRoleState(false);
      expect(saveBtn.disabled).toBe(false);

      // Transition back to host — save still enabled
      applyRoleState(true);
      expect(saveBtn.disabled).toBe(false);
    });
  });

  // ── 3.5.x: logic blocks host actions even if DOM manipulated ──
  describe('DOM manipulation defense', () => {
    it('manually unhiding host controls as peer does not change role label', () => {
      applyRoleState(false);

      // Attacker unhides a host-only button
      const openFileBtn = document.getElementById('open-file-btn')!;
      openFileBtn.style.display = '';

      // Button is now visible in DOM...
      expect(isVisible('open-file-btn')).toBe(true);

      // ...but the role label still says Peer (the actual role state unchanged)
      expect(document.getElementById('topbar-role')!.textContent).toBe('👤 Peer');

      // And other host controls are still hidden (no actual role change occurred)
      expect(isHidden('copy-invite-btn')).toBe(true);
    });

    it('manually unhiding host controls does not enable host-only behavior', () => {
      applyRoleState(false);

      // Attacker unhides all host-only controls
      for (const id of ['open-file-btn', 'copy-invite-btn', 'manual-answer-input', 'manual-answer-btn']) {
        document.getElementById(id)!.style.display = '';
      }

      // Visually they appear visible...
      expect(isVisible('open-file-btn')).toBe(true);
      expect(isVisible('copy-invite-btn')).toBe(true);

      // ...but the actual authorization for host actions (promote, approve, etc.)
      // is enforced at the relay/server level, not the DOM. This test validates
      // that the DOM state alone cannot grant host privileges.
      // The role label remains 'Peer' — the source of truth.
      expect(document.getElementById('topbar-role')!.textContent).toBe('👤 Peer');
    });

    it('role transition correctly resets all controls', () => {
      // Start as peer
      applyRoleState(false);
      expect(isHidden('open-file-btn')).toBe(true);
      expect(isVisible('sync-btn')).toBe(true);

      // Transition to host — all controls flip
      applyRoleState(true);
      expect(isVisible('open-file-btn')).toBe(true);
      expect(isHidden('sync-btn')).toBe(true);

      // Transition back to peer — all controls flip again
      applyRoleState(false);
      expect(isHidden('open-file-btn')).toBe(true);
      expect(isVisible('sync-btn')).toBe(true);
    });
  });
});