/** Client-side verification for the role/audience-bound mutual WS handshake. */

import {
  DIRECT_RUNTIME_RESPONDER_ROLE,
  RELAY_RESPONDER_ROLE,
  RUNTIME_WS_INITIATOR_ROLE,
  canonicalizeRuntimeWsAudience,
  createDirectHandshakeBinding,
  createRelayHandshakeBinding,
  sameHandshakeBinding,
  type RuntimeWsAckTranscript,
  type RuntimeWsChallengeTranscript,
  type RuntimeWsHandshakeBinding,
  type RuntimeWsHelloTranscript,
} from './hello-transcript';
import { verifyHelloAckAuth, verifyHelloChallengeAuth } from './hello-auth';
import { normalizeRuntimeId } from './runtime-id';
import type { RuntimeWsMessage } from './ws-protocol';

export type RuntimeWsExpectedPeer =
  | { role: typeof RELAY_RESPONDER_ROLE; audience?: string }
  | { role: typeof DIRECT_RUNTIME_RESPONDER_ROLE; runtimeId: string; encryptionPubKey?: string };

export type PendingClientHandshake = {
  challenge: RuntimeWsChallengeTranscript;
  hello: RuntimeWsHelloTranscript;
};

const isEncryptionPubKey = (value: string): boolean => /^0x[0-9a-f]{64}$/.test(value.toLowerCase());
const isChallenge = (value: string): boolean => /^0x[0-9a-f]{64}$/.test(value.toLowerCase());

const handshakeBindingFromChallenge = (message: RuntimeWsMessage): RuntimeWsHandshakeBinding => ({
  audience: String(message.audience || ''),
  initiatorRole: message.initiatorRole as RuntimeWsHandshakeBinding['initiatorRole'],
  responderRole: message.responderRole as RuntimeWsHandshakeBinding['responderRole'],
  responderRuntimeId: String(message.from || '').toLowerCase(),
  responderEncryptionPubKey: String(message.fromEncryptionPubKey || '').toLowerCase(),
});

const expectedBinding = (
  url: string,
  expectedPeer: RuntimeWsExpectedPeer | undefined,
  message: RuntimeWsMessage,
): RuntimeWsHandshakeBinding => {
  const selected = expectedPeer ?? { role: RELAY_RESPONDER_ROLE };
  if (selected.role === RELAY_RESPONDER_ROLE) {
    const audience = selected.audience
      ? canonicalizeRuntimeWsAudience(selected.audience)
      : canonicalizeRuntimeWsAudience(url);
    return createRelayHandshakeBinding(audience);
  }
  const runtimeId = normalizeRuntimeId(selected.runtimeId);
  if (!runtimeId) throw new Error('WS_HELLO_EXPECTED_DIRECT_RUNTIME_INVALID');
  const receivedKey = String(message.fromEncryptionPubKey || '').toLowerCase();
  const pinnedKey = String(selected.encryptionPubKey || receivedKey).toLowerCase();
  if (selected.encryptionPubKey && pinnedKey !== receivedKey) {
    throw new Error('WS_HELLO_CHALLENGE_DIRECT_KEY_MISMATCH');
  }
  return createDirectHandshakeBinding(runtimeId, pinnedKey);
};

const assertFreshTimestamp = (timestamp: unknown, maxSkewMs: number, code: string): number => {
  if (!Number.isSafeInteger(timestamp)) throw new Error(`${code}_TIMESTAMP_INVALID`);
  if (Math.abs(Date.now() - Number(timestamp)) > maxSkewMs) throw new Error(`${code}_TIMESTAMP_EXPIRED`);
  return Number(timestamp);
};

export const verifyServerChallenge = (options: {
  message: RuntimeWsMessage;
  url: string;
  expectedPeer?: RuntimeWsExpectedPeer;
  maxSkewMs: number;
}): RuntimeWsChallengeTranscript => {
  const { message, url, expectedPeer, maxSkewMs } = options;
  const challenge = String(message.challenge || '').toLowerCase();
  if (!isChallenge(challenge)) throw new Error('WS_HELLO_CHALLENGE_NONCE_INVALID');
  const received = handshakeBindingFromChallenge(message);
  const expected = expectedBinding(url, expectedPeer, message);
  if (received.audience !== expected.audience) {
    throw new Error(`WS_HELLO_CHALLENGE_AUDIENCE_MISMATCH:expected=${expected.audience}:received=${received.audience}`);
  }
  if (!sameHandshakeBinding(received, expected)) throw new Error('WS_HELLO_CHALLENGE_ROLE_OR_IDENTITY_MISMATCH');
  const timestamp = assertFreshTimestamp(message.timestamp, maxSkewMs, 'WS_HELLO_CHALLENGE');
  const transcript: RuntimeWsChallengeTranscript = { ...received, challenge, timestamp };
  if (expected.responderRole === DIRECT_RUNTIME_RESPONDER_ROLE) {
    if (!isEncryptionPubKey(received.responderEncryptionPubKey)) {
      throw new Error('WS_HELLO_CHALLENGE_DIRECT_KEY_INVALID');
    }
    const authError = verifyHelloChallengeAuth(transcript, message.auth, maxSkewMs);
    if (authError) throw new Error(`WS_HELLO_CHALLENGE_AUTH_INVALID:${authError}`);
  } else if (message.from || message.fromEncryptionPubKey || message.auth) {
    throw new Error('WS_HELLO_CHALLENGE_RELAY_IDENTITY_FORBIDDEN');
  }
  return transcript;
};

const ackBinding = (message: RuntimeWsMessage, pending: PendingClientHandshake): RuntimeWsHandshakeBinding => ({
  audience: String(message.audience || ''),
  initiatorRole: message.initiatorRole as RuntimeWsHandshakeBinding['initiatorRole'],
  responderRole: message.responderRole as RuntimeWsHandshakeBinding['responderRole'],
  responderRuntimeId: pending.challenge.responderRole === DIRECT_RUNTIME_RESPONDER_ROLE
    ? String(message.from || '').toLowerCase()
    : '',
  responderEncryptionPubKey: pending.challenge.responderRole === DIRECT_RUNTIME_RESPONDER_ROLE
    ? String(message.fromEncryptionPubKey || '').toLowerCase()
    : '',
});

export const verifyServerAck = (options: {
  message: RuntimeWsMessage;
  pending: PendingClientHandshake;
  clientRuntimeId: string;
  maxSkewMs: number;
}): { runtimeId: string; encryptionPubKey: string } | null => {
  const { message, pending, clientRuntimeId, maxSkewMs } = options;
  if (normalizeRuntimeId(message.to || '') !== normalizeRuntimeId(clientRuntimeId)) {
    throw new Error('WS_HELLO_ACK_TARGET_MISMATCH');
  }
  if (message.challenge !== pending.challenge.challenge) throw new Error('WS_HELLO_ACK_CHALLENGE_MISMATCH');
  if (message.helloTimestamp !== pending.hello.timestamp) throw new Error('WS_HELLO_ACK_TRANSCRIPT_MISMATCH');
  const receivedBinding = ackBinding(message, pending);
  if (!sameHandshakeBinding(receivedBinding, pending.challenge)) {
    throw new Error('WS_HELLO_ACK_RESPONDER_MISMATCH');
  }
  const timestamp = assertFreshTimestamp(message.timestamp, maxSkewMs, 'WS_HELLO_ACK');
  const transcript: RuntimeWsAckTranscript = {
    ...pending.hello,
    helloTimestamp: pending.hello.timestamp,
    timestamp,
  };
  if (pending.challenge.responderRole === DIRECT_RUNTIME_RESPONDER_ROLE) {
    const authError = verifyHelloAckAuth(transcript, message.auth, maxSkewMs);
    if (authError) throw new Error(`WS_HELLO_ACK_AUTH_INVALID:${authError}`);
    return {
      runtimeId: pending.challenge.responderRuntimeId,
      encryptionPubKey: pending.challenge.responderEncryptionPubKey,
    };
  }
  if (message.from || message.fromEncryptionPubKey || message.auth) {
    throw new Error('WS_HELLO_ACK_RELAY_IDENTITY_FORBIDDEN');
  }
  return null;
};

export const createHelloTranscript = (options: {
  challenge: RuntimeWsChallengeTranscript;
  runtimeId: string;
  encryptionPubKey: string;
  timestamp: number;
}): RuntimeWsHelloTranscript => ({
  audience: options.challenge.audience,
  initiatorRole: options.challenge.initiatorRole,
  responderRole: options.challenge.responderRole,
  responderRuntimeId: options.challenge.responderRuntimeId,
  responderEncryptionPubKey: options.challenge.responderEncryptionPubKey,
  challenge: options.challenge.challenge,
  initiatorRuntimeId: normalizeRuntimeId(options.runtimeId),
  initiatorEncryptionPubKey: options.encryptionPubKey.toLowerCase(),
  challengeTimestamp: options.challenge.timestamp,
  timestamp: options.timestamp,
});

export const handshakeWireFields = (binding: RuntimeWsHandshakeBinding) => ({
  audience: binding.audience,
  initiatorRole: RUNTIME_WS_INITIATOR_ROLE,
  responderRole: binding.responderRole,
});
