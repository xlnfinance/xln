import * as secp256k1 from '@noble/secp256k1';
import { keccak256 } from 'ethers';
import {
  hashHelloAck,
  hashHelloChallenge,
  hashHelloMessage,
  type RuntimeWsAckTranscript,
  type RuntimeWsAuth,
  type RuntimeWsChallengeTranscript,
  type RuntimeWsHelloTranscript,
} from './hello-transcript';

let authClock = 0;

const now = (): number => {
  const ts = Date.now();
  if (ts <= authClock) {
    authClock += 1;
    return authClock;
  }
  authClock = ts;
  return authClock;
};

export const recoverHelloAddress = (digestHex: string, signatureHex: string): string => {
  const sig = signatureHex.replace('0x', '');
  if (sig.length < 130) {
    throw new Error('Signature too short');
  }
  const compact = sig.slice(0, 128);
  const recovery = Number.parseInt(sig.slice(128, 130), 16);
  const messageBytes = Buffer.from(digestHex.replace('0x', ''), 'hex');
  const signatureBytes = Buffer.from(compact, 'hex');
  const publicKey = secp256k1.recoverPublicKey(messageBytes, signatureBytes, recovery, false);
  const hash = keccak256(publicKey.slice(1));
  return `0x${hash.slice(-40)}`.toLowerCase();
};

const verifyHandshakeAuth = (
  runtimeId: string,
  digest: string,
  auth: RuntimeWsAuth | undefined,
  expectedNonce: string,
  expectedTimestamp: number,
  maxSkewMs: number,
): string | null => {
  if (!auth?.nonce || !auth.signature || !auth.timestamp) {
    return 'Missing auth fields';
  }
  if (auth.nonce !== expectedNonce) return 'Handshake signature nonce mismatch';
  if (auth.timestamp !== expectedTimestamp) return 'Handshake signature timestamp mismatch';
  const nowTs = now();
  if (Math.abs(nowTs - auth.timestamp) > maxSkewMs) {
    return `Hello timestamp skew too large (${nowTs - auth.timestamp}ms)`;
  }
  let recovered: string;
  try {
    recovered = recoverHelloAddress(digest, auth.signature);
  } catch (error) {
    return `Hello signature invalid: ${(error as Error).message}`;
  }
  if (recovered.toLowerCase() !== runtimeId.toLowerCase()) {
    return 'Hello signature does not match runtimeId';
  }
  return null;
};

export const verifyHelloAuth = (
  transcript: RuntimeWsHelloTranscript,
  auth: RuntimeWsAuth | undefined,
  maxSkewMs: number,
): string | null => verifyHandshakeAuth(
  transcript.initiatorRuntimeId,
  hashHelloMessage(transcript),
  auth,
  transcript.challenge,
  transcript.timestamp,
  maxSkewMs,
);

export const verifyHelloChallengeAuth = (
  transcript: RuntimeWsChallengeTranscript,
  auth: RuntimeWsAuth | undefined,
  maxSkewMs: number,
): string | null => verifyHandshakeAuth(
  transcript.responderRuntimeId,
  hashHelloChallenge(transcript),
  auth,
  transcript.challenge,
  transcript.timestamp,
  maxSkewMs,
);

export const verifyHelloAckAuth = (
  transcript: RuntimeWsAckTranscript,
  auth: RuntimeWsAuth | undefined,
  maxSkewMs: number,
): string | null => verifyHandshakeAuth(
  transcript.responderRuntimeId,
  hashHelloAck(transcript),
  auth,
  transcript.challenge,
  transcript.timestamp,
  maxSkewMs,
);
