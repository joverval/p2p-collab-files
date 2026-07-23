// Message envelope — 1-byte prefix protocol
// 0x00: chat/text  0x01: feature payload (Yjs)
// Preserved exactly from original main.ts

export function encodeChat(text: string): Uint8Array {
  const e = new TextEncoder().encode(text);
  const m = new Uint8Array(1 + e.length);
  m[0] = 0x00;
  m.set(e, 1);
  return m;
}

export function encodeStructuredChat(sender: string, text: string): Uint8Array {
  const payload = JSON.stringify({ type: 'chat', sender, text });
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

export function decodeMessage(data: Uint8Array): { type: 'chat'; text: string } | { type: 'yjs'; update: Uint8Array; seq: number } {
  if (data.length === 0) return { type: 'chat', text: '' };
  if (data[0] === 0x01) return { type: 'yjs', update: data.slice(3), seq: (data[1] << 8) | data[2] };
  const s = data[0] === 0x00 ? 1 : 0;
  return { type: 'chat', text: new TextDecoder().decode(data.slice(s)) };
}