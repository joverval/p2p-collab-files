// relay-schemas.js — Zod schemas for relay-side message validation
// ExtremeCareful: keep client types.ts synchronized (see src/shared/types.ts)

import { z } from 'zod';

// ── Size limits ──
export const MAX_WS_PAYLOAD = 131072;       // 128KB
export const MAX_SDP_SIZE = 65536;          // 64KB
export const MAX_EMAIL_LENGTH = 254;
export const MAX_CHAT_LENGTH = 4096;
export const MAX_TOKEN_LENGTH = 256;
export const MAX_ROOM_ID_LENGTH = 64;
export const MAX_OFFER_ID_LENGTH = 128;
export const MAX_PARTICIPANTS_PER_ROOM = 50;
export const MAX_OFFERS_PER_ROOM = 100;
export const MAX_PROMOTIONS_PER_ROOM = 5;

// ── Base schemas ──
const emailSchema = z.string().trim().min(1).max(MAX_EMAIL_LENGTH)
  .regex(/^[^\x00-\x1f\x7f<>()\[\]{};:@",\s]+@[^\s@]+\.[^\s@]+$/,
    'Invalid email format');

const requestIdSchema = z.string().max(64).optional();

// ── Incoming message schemas (discriminated union by type) ──

export const storeOfferSchema = z.object({
  type: z.literal('store-offer'),
  sdp: z.string().min(1).max(MAX_SDP_SIZE),
  offerId: z.string().min(1).max(MAX_OFFER_ID_LENGTH),
  hostEmail: emailSchema,
  requestId: requestIdSchema,
});

export const fetchOfferSchema = z.object({
  type: z.literal('fetch-offer'),
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  requestId: requestIdSchema,
});

export const submitAnswerSchema = z.object({
  type: z.literal('submit-answer'),
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  email: emailSchema,
  answerB64: z.string().min(1).max(MAX_SDP_SIZE),
  requestId: requestIdSchema,
});

export const hostApproveSchema = z.object({
  type: z.literal('host-approve'),
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  requestId: requestIdSchema,
});

export const hostRejectSchema = z.object({
  type: z.literal('host-reject'),
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  requestId: requestIdSchema,
});

export const becomeHostSchema = z.object({
  type: z.literal('become-host'),
  oldToken: z.string().min(1).max(MAX_TOKEN_LENGTH),
  hostEmail: emailSchema.optional(),
  peers: z.array(z.object({
    email: emailSchema,
    isHost: z.boolean(),
  })).optional(),
  peerTokens: z.record(z.string()).optional(),
  requestId: requestIdSchema,
});

export const storeOfferNextSchema = z.object({
  type: z.literal('store-offer-next'),
  roomId: z.string().min(1).max(MAX_ROOM_ID_LENGTH),
  sdp: z.string().min(1).max(MAX_SDP_SIZE),
  offerId: z.string().min(1).max(MAX_OFFER_ID_LENGTH),
  requestId: requestIdSchema,
});

export const promotePeerSchema = z.object({
  type: z.literal('promote-peer'),
  roomId: z.string().min(1).max(MAX_ROOM_ID_LENGTH),
  targetEmail: emailSchema,
  targetParticipantId: z.string().max(MAX_TOKEN_LENGTH).optional(),
  automatic: z.boolean().optional(),
  requestId: requestIdSchema,
});

export const storePromotionOfferSchema = z.object({
  type: z.literal('store-promotion-offer'),
  roomId: z.string().min(1).max(MAX_ROOM_ID_LENGTH),
  promotionId: z.string().min(1).max(MAX_TOKEN_LENGTH),
  intendedEmail: emailSchema,
  sdp: z.string().min(1).max(MAX_SDP_SIZE),
  offerId: z.string().min(1).max(MAX_OFFER_ID_LENGTH),
  requestId: requestIdSchema,
});

export const commitPromotionSchema = z.object({
  type: z.literal('commit-promotion'),
  roomId: z.string().min(1).max(MAX_ROOM_ID_LENGTH),
  promotionId: z.string().min(1).max(MAX_TOKEN_LENGTH),
  reconnectTokens: z.record(z.string()).optional(),
  requestId: requestIdSchema,
});

export const pingSchema = z.object({
  type: z.literal('ping'),
  requestId: requestIdSchema,
});

// ── Discriminated union of all valid incoming messages ──
export const incomingMessageSchema = z.discriminatedUnion('type', [
  storeOfferSchema,
  fetchOfferSchema,
  submitAnswerSchema,
  hostApproveSchema,
  hostRejectSchema,
  becomeHostSchema,
  storeOfferNextSchema,
  promotePeerSchema,
  storePromotionOfferSchema,
  commitPromotionSchema,
  pingSchema,
]);

// ── Validation helper ──
export function validateIncoming(raw) {
  // Size check before parsing
  if (typeof raw === 'string' && raw.length > MAX_WS_PAYLOAD) {
    return { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: `Message exceeds ${MAX_WS_PAYLOAD} byte limit` } };
  }

  const result = incomingMessageSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: { code: 'INVALID_MESSAGE', message: messages } };
  }
  return { ok: true, data: result.data };
}