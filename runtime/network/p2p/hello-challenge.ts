/** Single-use server challenges bound to one socket, audience, and transport role. */

import {
  sameHandshakeBinding,
  type RuntimeWsAuth,
  type RuntimeWsChallengeTranscript,
  type RuntimeWsHandshakeBinding,
} from './hello-transcript';
import { serializeWsMessage, type RuntimeWsMessage } from './ws-protocol';

type ChallengeSocket = {
  send(data: Uint8Array): unknown;
  close?(code?: number, reason?: string): unknown;
};
type ChallengeSigner = (transcript: RuntimeWsChallengeTranscript) => RuntimeWsAuth;

type HelloChallengeRegistryOptions = {
  timeoutMs?: number;
  maxPending?: number;
  onReject?: (ws: ChallengeSocket, reason: 'hello-timeout' | 'hello-capacity') => void;
};

export type HelloChallengeConsumption =
  | { ok: true; transcript: RuntimeWsChallengeTranscript }
  | { ok: false; error: string };

let challengeTimestamp = 0;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_HELLOS = 1_024;

const positiveIntegerOr = (value: number | undefined, fallback: number): number =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;

const nextTimestamp = (): number => {
  const timestamp = Date.now();
  challengeTimestamp = timestamp <= challengeTimestamp ? challengeTimestamp + 1 : timestamp;
  return challengeTimestamp;
};

const createChallenge = (): string => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const bindingFromHello = (message: RuntimeWsMessage): RuntimeWsHandshakeBinding => ({
  audience: String(message.audience || ''),
  initiatorRole: message.initiatorRole as RuntimeWsHandshakeBinding['initiatorRole'],
  responderRole: message.responderRole as RuntimeWsHandshakeBinding['responderRole'],
  responderRuntimeId: message.responderRole === 'direct-runtime-server' ? String(message.to || '') : '',
  responderEncryptionPubKey: '',
});

const helloMatchesChallenge = (
  message: RuntimeWsMessage,
  expected: RuntimeWsChallengeTranscript,
): string | null => {
  const received = bindingFromHello(message);
  received.responderEncryptionPubKey = expected.responderEncryptionPubKey;
  if (!sameHandshakeBinding(received, expected)) return 'Hello audience or role does not match issued challenge';
  if (message.auth?.nonce !== expected.challenge) return 'Hello challenge missing, expired, or already consumed';
  return null;
};

export const createHelloChallengeRegistry = (options: HelloChallengeRegistryOptions = {}) => {
  const challenges = new Map<object, RuntimeWsChallengeTranscript>();
  const timers = new Map<object, ReturnType<typeof setTimeout>>();
  const timeoutMs = positiveIntegerOr(options.timeoutMs, DEFAULT_HELLO_TIMEOUT_MS);
  const maxPending = positiveIntegerOr(options.maxPending, DEFAULT_MAX_PENDING_HELLOS);
  const clearPending = (ws: object): RuntimeWsChallengeTranscript | undefined => {
    const challenge = challenges.get(ws);
    challenges.delete(ws);
    const timer = timers.get(ws);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(ws);
    return challenge;
  };
  const rejectPending = (
    ws: ChallengeSocket,
    reason: 'hello-timeout' | 'hello-capacity',
  ): void => {
    clearPending(ws);
    try {
      options.onReject?.(ws, reason);
    } finally {
      ws.close?.(4008, reason);
    }
  };
  const armTimeout = (ws: ChallengeSocket): void => {
    const timer = setTimeout(() => {
      if (!challenges.has(ws)) return;
      rejectPending(ws, 'hello-timeout');
    }, timeoutMs);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    timers.set(ws, timer);
  };
  return {
    issue(
      ws: ChallengeSocket,
      binding: RuntimeWsHandshakeBinding,
      sign?: ChallengeSigner,
    ): RuntimeWsChallengeTranscript | null {
      clearPending(ws);
      if (challenges.size >= maxPending) {
        rejectPending(ws, 'hello-capacity');
        return null;
      }
      const transcript: RuntimeWsChallengeTranscript = {
        ...binding,
        challenge: createChallenge(),
        timestamp: nextTimestamp(),
      };
      const auth = sign?.(transcript);
      challenges.set(ws, transcript);
      armTimeout(ws);
      try {
        ws.send(serializeWsMessage({
          type: 'hello_challenge',
          challenge: transcript.challenge,
          audience: transcript.audience,
          initiatorRole: transcript.initiatorRole,
          responderRole: transcript.responderRole,
          ...(transcript.responderRuntimeId ? { from: transcript.responderRuntimeId } : {}),
          ...(transcript.responderEncryptionPubKey
            ? { fromEncryptionPubKey: transcript.responderEncryptionPubKey }
            : {}),
          timestamp: transcript.timestamp,
          ...(auth ? { auth } : {}),
        } satisfies RuntimeWsMessage));
      } catch (error) {
        clearPending(ws);
        throw error;
      }
      return transcript;
    },
    consume(ws: object, hello: RuntimeWsMessage): HelloChallengeConsumption {
      const expected = clearPending(ws);
      if (!expected) return { ok: false, error: 'Hello challenge missing, expired, or already consumed' };
      if (Date.now() > expected.timestamp + timeoutMs) {
        return { ok: false, error: 'Hello challenge missing, expired, or already consumed' };
      }
      const mismatch = helloMatchesChallenge(hello, expected);
      return mismatch ? { ok: false, error: mismatch } : { ok: true, transcript: expected };
    },
    forget(ws: object): void {
      clearPending(ws);
    },
    pendingCount: (): number => challenges.size,
  };
};
