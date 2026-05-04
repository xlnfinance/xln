import * as secp256k1 from '@noble/secp256k1';
import { keccak256 } from 'ethers';
import { hashHelloMessage, type RuntimeWsAuth } from './ws-protocol';

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

export const verifyHelloAuth = (runtimeId: string, auth: RuntimeWsAuth | undefined, maxSkewMs: number): string | null => {
  if (!auth?.nonce || !auth.signature || !auth.timestamp) {
    return 'Missing auth fields';
  }
  const nowTs = now();
  if (Math.abs(nowTs - auth.timestamp) > maxSkewMs) {
    return `Hello timestamp skew too large (${nowTs - auth.timestamp}ms)`;
  }
  const digest = hashHelloMessage(runtimeId, auth.timestamp, auth.nonce);
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
