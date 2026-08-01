/** Single-use server challenges bound to one socket, audience, and transport role. */

import {
  sameHandshakeBinding,
  type RuntimeWsAuth,
  type RuntimeWsChallengeTranscript,
  type RuntimeWsHandshakeBinding,
} from './hello-transcript';
import { serializeWsMessage, type RuntimeWsMessage } from './ws-protocol';

type ChallengeSocket = { send(data: Uint8Array): unknown };
type ChallengeSigner = (transcript: RuntimeWsChallengeTranscript) => RuntimeWsAuth;

export type HelloChallengeConsumption =
  | { ok: true; transcript: RuntimeWsChallengeTranscript }
  | { ok: false; error: string };

let challengeTimestamp = 0;

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

export const createHelloChallengeRegistry = () => {
  const challenges = new Map<object, RuntimeWsChallengeTranscript>();
  return {
    issue(ws: ChallengeSocket, binding: RuntimeWsHandshakeBinding, sign?: ChallengeSigner): RuntimeWsChallengeTranscript {
      const transcript: RuntimeWsChallengeTranscript = {
        ...binding,
        challenge: createChallenge(),
        timestamp: nextTimestamp(),
      };
      const auth = sign?.(transcript);
      challenges.set(ws, transcript);
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
      return transcript;
    },
    consume(ws: object, hello: RuntimeWsMessage): HelloChallengeConsumption {
      const expected = challenges.get(ws);
      challenges.delete(ws);
      if (!expected) return { ok: false, error: 'Hello challenge missing, expired, or already consumed' };
      const mismatch = helloMatchesChallenge(hello, expected);
      return mismatch ? { ok: false, error: mismatch } : { ok: true, transcript: expected };
    },
    forget(ws: object): void {
      challenges.delete(ws);
    },
  };
};
