import * as secp256k1 from '@noble/secp256k1';
import { keccak256 } from 'ethers';
import { hashHelloMessage, hashRuntimeWsFrame, type RuntimeWsAuth, type RuntimeWsMessage } from './ws-protocol';

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

export const verifyHelloAuth = (
  runtimeId: string,
  encryptionPubKey: string,
  auth: RuntimeWsAuth | undefined,
  maxSkewMs: number,
  audience: string,
): string | null => {
  if (!auth?.nonce || !auth.signature || !auth.timestamp) {
    return 'Missing auth fields';
  }
  const nowTs = now();
  if (Math.abs(nowTs - auth.timestamp) > maxSkewMs) {
    return `Hello timestamp skew too large (${nowTs - auth.timestamp}ms)`;
  }
  const digest = hashHelloMessage(runtimeId, encryptionPubKey, auth.timestamp, auth.nonce, audience);
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

export const verifyRuntimeWsFrameAuth = (
  runtimeId: string,
  message: RuntimeWsMessage,
  auth: RuntimeWsAuth | undefined,
  maxSkewMs: number,
  audience: string,
  nonce: string,
  lastTimestamp: number,
): string | null => {
  if (!auth?.signature || auth.nonce !== nonce || !Number.isSafeInteger(auth.timestamp)) {
    return 'Missing or invalid session frame auth';
  }
  const nowTs = now();
  if (Math.abs(nowTs - auth.timestamp) > maxSkewMs) {
    return `Frame timestamp skew too large (${nowTs - auth.timestamp}ms)`;
  }
  let recovered: string;
  try {
    recovered = recoverHelloAddress(
      hashRuntimeWsFrame(message, audience, nonce, auth.timestamp),
      auth.signature,
    );
  } catch (error) {
    return `Frame signature invalid: ${(error as Error).message}`;
  }
  if (recovered !== runtimeId.toLowerCase()) return 'Frame signature does not match session runtimeId';
  // WebSocket delivery is ordered, so a signed timestamp is also the smallest
  // session-bound replay fence: accepting equality would replay the exact frame.
  return auth.timestamp > lastTimestamp ? null : 'Session frame replay or reordering';
};
