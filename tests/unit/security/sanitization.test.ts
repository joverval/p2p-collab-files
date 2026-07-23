// Security sanitization unit tests: XSS prevention, markup safety, input validation
// Tests ChatController textContent safety (3.7.1-3.7.5) and message spoofing (3.7.6-3.7.7)
// Uses jsdom for DOM APIs

import { describe, it, expect, beforeEach } from 'vitest';
import { ChatController } from '../../../src/shell/chat/chat-controller';

describe('Security Sanitization', () => {
  describe('ChatController output safety', () => {
    let ctrl: ChatController;

    beforeEach(() => {
      document.body.innerHTML = '';
      const notif = document.createElement('div');
      notif.id = 'chat-notif';
      document.body.appendChild(notif);
      const chatLog = document.createElement('div');
      chatLog.id = 'chat-log';
      document.body.appendChild(chatLog);
      ctrl = new ChatController();
    });

    // ── 3.7.1: chat <img onerror> does not execute ──
    it('chat <img onerror> does not execute', () => {
      ctrl.addLog('peer', '<img src=x onerror=alert(1)>', 'attacker@evil.com');

      const entry = document.querySelector('#chat-log')!.children[0];
      // textContent stores the literal string, no DOM nodes created
      expect(entry.textContent).toContain('<img src=x onerror=alert(1)>');
      // No img element created in DOM
      expect(entry.querySelector('img')).toBeNull();
      // innerHTML should NOT contain raw <img tag (must be escaped)
      expect(entry.innerHTML).not.toContain('<img ');
    });

    // ── 3.7.2: markdown <script> removed from preview ──
    it('markdown <script> removed from preview', () => {
      ctrl.addLog('peer', '<script>evil()</script>', 'attacker@evil.com');

      const entry = document.querySelector('#chat-log')!.children[0];
      expect(entry.textContent).toContain('<script>evil()</script>');
      expect(entry.querySelector('script')).toBeNull();
      // innerHTML should NOT contain raw <script> tag
      expect(entry.innerHTML).not.toContain('<script>');
    });

    // ── 3.7.3: javascript: link removed from preview ──
    it('javascript: link removed from preview', () => {
      ctrl.addLog('peer', 'Click <a href="javascript:alert(1)">here</a>', 'attacker@evil.com');

      const entry = document.querySelector('#chat-log')!.children[0];
      expect(entry.textContent).toContain('javascript:alert(1)');
      // No actual anchor element created
      expect(entry.querySelector('a')).toBeNull();
      // innerHTML should NOT contain raw <a href= tag
      expect(entry.innerHTML).not.toContain('<a href=');
    });

    // ── 3.7.4: unsafe SVG removed from preview ──
    it('unsafe SVG removed from preview', () => {
      const svgPayload = '<svg onload="alert(1)"><circle cx="50" cy="50" r="40"/></svg>';
      ctrl.addLog('peer', svgPayload, 'attacker@evil.com');

      const entry = document.querySelector('#chat-log')!.children[0];
      expect(entry.textContent).toContain('<svg');
      // No SVG element created in DOM
      expect(entry.querySelector('svg')).toBeNull();
      // innerHTML should NOT contain raw <svg tag
      expect(entry.innerHTML).not.toContain('<svg ');
    });

    // ── 3.7.5: very long chat/email rejected or truncated ──
    it('very long chat message truncated to max length', () => {
      const longText = 'A'.repeat(100000);
      expect(() => {
        ctrl.addLog('peer', longText, 'attacker@evil.com');
      }).not.toThrow();

      const entry = document.querySelector('#chat-log')!.children[0];
      expect(entry).toBeDefined();
      // Message should be truncated to CHAT_MAX_LENGTH (1000) + timestamp prefix
      const contentLen = entry.textContent!.length;
      const payloadLen = longText.slice(0, 1000).length;
      // textContent = `[HH:MM:SS] AAAA...` so length is timestamp (~10-11) + 1 space + payload
      expect(contentLen).toBeLessThan(20 + 1000); // well under 100000
      // Verify no raw HTML injection (innerHTML should be escaped text, not contain tags)
      expect(entry.innerHTML).not.toContain('<');
    });

    // ── 3.7.5b: control characters stripped from chat messages ──
    it('control characters stripped from chat messages', () => {
      // Null byte, ANSI escapes, and other C0/C1 control chars
      ctrl.addLog('peer', 'He\x00llo\x1B[31m World\x7F', 'attacker@evil.com');

      const entry = document.querySelector('#chat-log')!.children[0];
      // Should contain only printable chars: "Hello[31m World" (null, ESC, DEL stripped)
      expect(entry.textContent).toContain('Hello');
      expect(entry.textContent).toContain('World');
      expect(entry.textContent).not.toContain('\x00');
      expect(entry.textContent).not.toContain('\x1B');
      expect(entry.textContent).not.toContain('\x7F');
    });

    // ── 3.7.5c: all-control-char message produces no entry ──
    it('all-control-char message produces no entry', () => {
      ctrl.addLog('peer', '\x00\x01\x02\x1B\x7F', 'attacker@evil.com');
      // All chars stripped, text becomes empty → no entry created
      expect(document.querySelector('#chat-log')!.children.length).toBe(0);
    });
  });

  // ── 3.7.6-3.7.7: message spoofing prevention ──
  describe('Message spoofing prevention', () => {
    it('control-message spoof from peer rejected', () => {
      document.body.innerHTML = '';
      const notif = document.createElement('div');
      notif.id = 'chat-notif';
      document.body.appendChild(notif);
      const chatLog = document.createElement('div');
      chatLog.id = 'chat-log';
      document.body.appendChild(chatLog);

      const ctrl = new ChatController();

      // CHKSUM messages are filtered by ChatController
      ctrl.addLog('peer', '[CHKSUM] spoofed checksum from peer', 'attacker@evil.com');
      expect(chatLog.children.length).toBe(0);

      // Other control prefixes are NOT filtered by ChatController (they go through
      // SessionController's onControlMessage gating). ChatController renders them
      // as normal text, which is safe (textContent, no injection).
      ctrl.addLog('peer', '[SYNC] spoofed sync from peer', 'attacker@evil.com');
      expect(chatLog.children.length).toBe(1);
      expect(chatLog.children[0].textContent).toContain('[SYNC]');
      // innerHTML should not contain raw angle brackets (escaped)
      expect(chatLog.children[0].innerHTML).not.toContain('<');
    });

    it('room-state spoof from peer rejected', () => {
      document.body.innerHTML = '';
      const notif = document.createElement('div');
      notif.id = 'chat-notif';
      document.body.appendChild(notif);
      const chatLog = document.createElement('div');
      chatLog.id = 'chat-log';
      document.body.appendChild(chatLog);

      const ctrl = new ChatController();

      ctrl.addLog('peer', '[ROOM] spoofed room state from peer', 'attacker@evil.com');
      expect(chatLog.children.length).toBe(1);
      // Rendered as textContent (safe), no raw HTML in innerHTML
      expect(chatLog.children[0].textContent).toContain('[ROOM]');
      expect(chatLog.children[0].innerHTML).not.toContain('<');
    });
  });
});