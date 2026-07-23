// tests/unit/protocol/message-envelope.test.ts
// Tests A.1–A.7: message envelope round-trips, edge cases

import { describe, it, expect } from 'vitest';
import { encodeChat, encodeStructuredChat, encodeYjs, decodeMessage } from '../../../src/shell/protocol/message-envelope';

describe('Message Envelope', () => {
  // A.1 — Chat round-trip
  it('A.1 — chat round-trip (encodeChat → decodeMessage → text matches)', () => {
    const text = 'Hello, World!';
    const encoded = encodeChat(text);
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe('chat');
    expect((decoded as { type: 'chat'; text: string }).text).toBe(text);
  });

  it('A.1 — chat round-trip with empty string', () => {
    const encoded = encodeChat('');
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe('chat');
    expect((decoded as { type: 'chat'; text: string }).text).toBe('');
  });

  it('A.1 — chat round-trip with unicode', () => {
    const text = '🚀 Привет, мир! ñ';
    const encoded = encodeChat(text);
    const decoded = decodeMessage(encoded);
    expect((decoded as { type: 'chat'; text: string }).text).toBe(text);
  });

  // A.2 — Yjs payload round-trip
  it('A.2 — Yjs payload round-trip (encodeYjs → decodeMessage)', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    const seq = 42;
    const encoded = encodeYjs(data, seq);
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe('yjs');
    const yjsDecoded = decoded as { type: 'yjs'; update: Uint8Array; seq: number };
    expect(yjsDecoded.seq).toBe(seq);
    expect(Array.from(yjsDecoded.update)).toEqual([10, 20, 30, 40, 50]);
  });

  it('A.2 — Yjs payload round-trip with default seq=0', () => {
    const data = new Uint8Array([1, 2, 3]);
    const encoded = encodeYjs(data); // no seq
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe('yjs');
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).seq).toBe(0);
  });

  it('A.2 — Yjs payload with seq at boundaries', () => {
    // seq 0xFFFF (max 16-bit)
    const data = new Uint8Array([99]);
    const encoded = encodeYjs(data, 0xFFFF);
    const decoded = decodeMessage(encoded);
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).seq).toBe(0xFFFF);

    // seq 0
    const encoded2 = encodeYjs(data, 0);
    const decoded2 = decodeMessage(encoded2);
    expect((decoded2 as { type: 'yjs'; update: Uint8Array; seq: number }).seq).toBe(0);
  });

  // A.3 — Empty payload
  it('A.3 — empty Uint8Array decodes as empty chat', () => {
    const decoded = decodeMessage(new Uint8Array(0));
    expect(decoded.type).toBe('chat');
    expect((decoded as { type: 'chat'; text: string }).text).toBe('');
  });

  it('A.3 — empty Yjs payload (zero-length update)', () => {
    const encoded = encodeYjs(new Uint8Array(0), 5);
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe('yjs');
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).update.length).toBe(0);
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).seq).toBe(5);
  });

  // A.4 — Invalid/truncated feature header
  it('A.4 — single byte (no feature header)', () => {
    const decoded = decodeMessage(new Uint8Array([0x41])); // 'A'
    expect(decoded.type).toBe('chat');
    expect((decoded as { type: 'chat'; text: string }).text).toBe('A');
  });

  it('A.4 — truncated yjs envelope (only 2 bytes, missing update)', () => {
    const encoded = new Uint8Array([0x01, 0x00, 0x05]); // 3 bytes total = header only, no update
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe('yjs');
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).update.length).toBe(0);
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).seq).toBe(5);
  });

  it('A.4 — byte with 0x01 prefix but less than 3 bytes total', () => {
    const decoded = decodeMessage(new Uint8Array([0x01])); // only 1 byte
    // slice(3) on 1-byte array returns empty
    expect(decoded.type).toBe('yjs');
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).update.length).toBe(0);
  });

  it('A.4 — byte with 0x01 prefix, exactly 3 bytes', () => {
    const decoded = decodeMessage(new Uint8Array([0x01, 0x00, 0x00]));
    expect(decoded.type).toBe('yjs');
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).update.length).toBe(0);
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).seq).toBe(0);
  });

  // A.5 — Large payload (close to 48KB threshold boundary)
  it('A.5 — large Yjs payload round-trip (~47KB)', () => {
    const size = 47 * 1024;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i % 256);
    const encoded = encodeYjs(data, 123);
    expect(encoded.length).toBe(3 + size);
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe('yjs');
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).update.length).toBe(size);
    expect((decoded as { type: 'yjs'; update: Uint8Array; seq: number }).seq).toBe(123);
  });

  it('A.5 — large chat payload round-trip', () => {
    const text = 'x'.repeat(48 * 1024);
    const encoded = encodeChat(text);
    expect(encoded.length).toBe(1 + text.length);
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe('chat');
    expect((decoded as { type: 'chat'; text: string }).text).toBe(text);
  });

  // A.6 — Envelope added exactly once (no double-wrapping)
  it('A.6 — envelope is not double-wrapped', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeYjs(data, 10);
    // The encoded should have exactly 3 envelope bytes + 4 data bytes = 7
    expect(encoded.length).toBe(7);
    // First byte is the type marker
    expect(encoded[0]).toBe(0x01);
    // Data starts at byte 3
    expect(encoded[3]).toBe(1);
    expect(encoded[4]).toBe(2);
    expect(encoded[5]).toBe(3);
    expect(encoded[6]).toBe(4);
  });

  it('A.6 — chat envelope is also single-layer', () => {
    const encoded = encodeChat('test');
    expect(encoded[0]).toBe(0x00);
    expect(encoded.length).toBe(5); // 1 prefix + 4 chars
  });

  // A.7 — Sequence metadata does not remove Yjs bytes
  it('A.7 — decodeMessage preserves full update via slice (not corrupting)', () => {
    const updateData = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE]);
    const encoded = encodeYjs(updateData, 0x1234);
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe('yjs');
    const result = decoded as { type: 'yjs'; update: Uint8Array; seq: number };
    // The update must be exactly the original bytes
    expect(Array.from(result.update)).toEqual([0xAA, 0xBB, 0xCC, 0xDD, 0xEE]);
    // Seq must be correct
    expect(result.seq).toBe(0x1234);
  });

  it('A.7 — seq bytes do not leak into update', () => {
    // seq = 0x0102, so envelope bytes are [0x01, 0x01, 0x02]
    const updateData = new Uint8Array([0xFF]);
    const encoded = encodeYjs(updateData, 0x0102);
    const decoded = decodeMessage(encoded) as { type: 'yjs'; update: Uint8Array; seq: number };

    // The decoded seq should correctly be 0x0102, not mistaken for the type byte
    expect(decoded.seq).toBe(0x0102);
    // The update should just be the single byte 0xFF
    expect(decoded.update.length).toBe(1);
    expect(decoded.update[0]).toBe(0xFF);
  });

  // Bonus: encodeStructuredChat round-trip
  it('encodeStructuredChat round-trips via decodeMessage', () => {
    const encoded = encodeStructuredChat('Alice', 'host', 'Hi there!');
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe('chat');
    const text = (decoded as { type: 'chat'; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ type: 'chat', sender: 'Alice', senderRole: 'host', text: 'Hi there!' });
  });
});