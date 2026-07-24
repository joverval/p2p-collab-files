// Message envelope — 1-byte prefix protocol
// 0x00: chat/control (JSON-typed body)  0x01: feature payload (Yjs)
// 0x00 body is parsed as typed control message (ChatControlMessage);
// plain-text fallback preserved for legacy wire compatibility.

import type { ChatControlMessage } from '../../shared/types.js';

export function encodeChat(text: string): Uint8Array {
  const e = new TextEncoder().encode(text);
  const m = new Uint8Array(1 + e.length);
  m[0] = 0x00;
  m.set(e, 1);
  return m;
}

export function encodeStructuredChat(
  id: string,
  senderParticipantId: string,
  senderEmail: string,
  senderRole: string,
  text: string,
  timestamp: number
): Uint8Array {
  const control: ChatControlMessage = {
    kind: 'chat',
    message: {
      id,
      senderParticipantId,
      senderEmail,
      senderRole: senderRole as 'host' | 'peer' | 'system',
      text,
      timestamp
    }
  };
  const payload = JSON.stringify(control);
  const e = new TextEncoder().encode(payload);
  const m = new Uint8Array(1 + e.length);
  m[0] = 0x00;
  m.set(e, 1);
  return m;
}

export function encodeYjs(data: Uint8Array, seq?: number): Uint8Array {
  if (seq === undefined) return encodeYjs(data, 0);
  const m = new Uint8Array(3 + data.length);
  m[0] = 0x01;
  m[1] = (seq >> 8) & 0xFF;
  m[2] = seq & 0xFF;
  m.set(data, 3);
  return m;
}

export function decodeMessage(data: Uint8Array):
  | { type: 'chat-control'; control: ChatControlMessage }
  | { type: 'chat'; text: string }
  | { type: 'yjs'; update: Uint8Array; seq: number } {
  if (data.length === 0) return { type: 'chat', text: '' };
  if (data[0] === 0x01) return { type: 'yjs', update: data.slice(3), seq: (data[1] << 8) | data[2] };
  const s = data[0] === 0x00 ? 1 : 0;
  const body = new TextDecoder().decode(data.slice(s));

  // Parse 0x00 body as typed control message (JSON with `kind` discriminator).
  // Fall back to raw text for legacy wire formats and non-chat control strings.
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && parsed.kind === 'chat' &&
        parsed.message && typeof parsed.message === 'object') {
      return { type: 'chat-control', control: parsed as ChatControlMessage };
    }
  } catch {}

  return { type: 'chat', text: body };
}