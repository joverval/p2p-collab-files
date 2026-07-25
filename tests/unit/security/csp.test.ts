// CSP tests: Content Security Policy validation for XSS prevention
//
// Verifies the CSP meta tag in index.html has correct directives:
// - No 'unsafe-inline' on script-src (prevents inline script injection)
// - object-src 'none' (prevents plugin-based attacks)
// - base-uri 'self' (prevents base tag hijacking)
// - form-action 'none' (prevents form-based exfiltration)
// - default-src 'self' (deny-by-default posture)

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function getCspContent(): string {
  const indexPath = resolve(__dirname, '../../../index.html');
  const html = readFileSync(indexPath, 'utf-8');
  const match = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/s
  );
  if (!match) throw new Error('CSP meta tag not found in index.html');
  return match[1].trim();
}

function parseCspDirectives(csp: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const line of csp.split(';')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
      directives.set(trimmed, '');
    } else {
      directives.set(trimmed.slice(0, spaceIdx), trimmed.slice(spaceIdx + 1).trim());
    }
  }
  return directives;
}

describe('Content Security Policy', () => {
  let csp: string;
  let directives: Map<string, string>;

  beforeAll(() => {
    csp = getCspContent();
    directives = parseCspDirectives(csp);
  });

  it('CSP meta tag is present in index.html', () => {
    expect(csp).toBeTruthy();
    expect(csp.length).toBeGreaterThan(50);
  });

  // ── default-src ──
  it("default-src is 'self' (deny-by-default)", () => {
    expect(directives.get('default-src')).toBe("'self'");
  });

  // ── script-src ──
  it("script-src does NOT include 'unsafe-inline' (blocks inline scripts)", () => {
    const scriptSrc = directives.get('script-src') || '';
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("script-src allows 'self' for bundled scripts", () => {
    const scriptSrc = directives.get('script-src') || '';
    expect(scriptSrc).toContain("'self'");
  });

  it('script-src allows cdn.jsdelivr.net for marked.js', () => {
    const scriptSrc = directives.get('script-src') || '';
    expect(scriptSrc).toContain('cdn.jsdelivr.net');
  });

  // ── GoatCounter analytics ──
  it('script-src allows track.joverval.cl for GoatCounter analytics', () => {
    const scriptSrc = directives.get('script-src') || '';
    expect(scriptSrc).toContain('track.joverval.cl');
  });

  // ── connect-src ──
  it("connect-src includes 'self'", () => {
    const connectSrc = directives.get('connect-src') || '';
    expect(connectSrc).toContain("'self'");
  });

  it('connect-src allows WebSocket to relay', () => {
    const connectSrc = directives.get('connect-src') || '';
    expect(connectSrc).toContain('wss://relay.joverval.cl');
    // Allow any localhost WS port for dev/testing (dynamic port allocation)
    expect(connectSrc).toContain('ws://localhost:*');
    expect(connectSrc).toContain('http://localhost:*');
  });

  it('connect-src allows HTTPS fetch to relay for TURN credentials', () => {
    const connectSrc = directives.get('connect-src') || '';
    expect(connectSrc).toContain('https://relay.joverval.cl');
  });

  it('connect-src allows track.joverval.cl for GoatCounter analytics', () => {
    const connectSrc = directives.get('connect-src') || '';
    expect(connectSrc).toContain('https://track.joverval.cl');
  });

  // ── style-src ──
  it("style-src includes 'self'", () => {
    const styleSrc = directives.get('style-src') || '';
    expect(styleSrc).toContain("'self'");
  });

  // ── img-src ──
  it("img-src includes 'self' and data:", () => {
    const imgSrc = directives.get('img-src') || '';
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain('data:');
  });

  // ── object-src ──
  it("object-src is 'none' (blocks Flash/Java/plugin attacks)", () => {
    expect(directives.get('object-src')).toBe("'none'");
  });

  // ── base-uri ──
  it("base-uri is 'self' (prevents base tag hijacking)", () => {
    expect(directives.get('base-uri')).toBe("'self'");
  });

  // ── form-action ──
  it("form-action is 'none' (prevents form-based data exfiltration)", () => {
    expect(directives.get('form-action')).toBe("'none'");
  });

  // ── media-src ──
  it("media-src is 'none'", () => {
    expect(directives.get('media-src')).toBe("'none'");
  });

  // ── font-src ──
  it("font-src is 'self'", () => {
    expect(directives.get('font-src')).toBe("'self'");
  });
});