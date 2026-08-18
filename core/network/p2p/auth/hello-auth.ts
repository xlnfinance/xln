import * as secp256k1 from '@noble/secp256k1';
import { keccak256 } from 'ethers';
import {
  hashHelloMessage,
  hashRuntimeWsFrame,
  macRuntimeWsFrame,
  runtimeWsMacEquals,
  type RuntimeWsAuth,
  type RuntimeWsMessage,
} from '../ws-protocol';

const recoverHelloAddress = (digestHex: string, signatureHex: string): string => {
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
  sessionPubKey?: string,
): string | null => {
  if (!auth?.nonce || !auth.signature || !auth.timestamp) {
    return 'Missing auth fields';
  }
  // Verification must be observational. A process-global monotonic verifier
  // clock lets a burst of invalid frames advance time and reject honest peers.
  const nowTs = Date.now();
  if (Math.abs(nowTs - auth.timestamp) > maxSkewMs) {
    return `Hello timestamp skew too large (${nowTs - auth.timestamp}ms)`;
  }
  const digest = hashHelloMessage(runtimeId, encryptionPubKey, auth.timestamp, auth.nonce, audience, sessionPubKey);
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
  audience: string,
  nonce: string,
  lastTimestamp: number,
  sessionMacKey?: Uint8Array,
): string | null => {
  if (!auth || auth.nonce !== nonce || !Number.isSafeInteger(auth.timestamp)) {
    return 'Missing or invalid session frame auth';
  }
  if (sessionMacKey) {
    // Session established: the peer's ephemeral key was bound by its hello
    // signature, so an HMAC under the derived direction key authenticates the
    // frame as that runtime. A signature on a session frame is not accepted
    // (one authenticator per session keeps the replay window single).
    if (!auth.mac || auth.signature) return 'Session frame requires mac auth';
    const expected = macRuntimeWsFrame(sessionMacKey, message, audience, nonce, auth.timestamp);
    if (!runtimeWsMacEquals(expected, auth.mac.toLowerCase().replace('0x', ''))) {
      return 'Frame mac does not match session key';
    }
  } else {
    if (!auth.signature) return 'Missing or invalid session frame auth';
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
  }
  // Hello freshness prevents old sessions. After that, the single-use nonce,
  // ordered socket and signed per-session counter are sufficient: consulting
  // wall time here lets clock jumps or a busy peer reject an otherwise valid
  // authenticated session. Equality would replay the exact frame.
  return auth.timestamp > lastTimestamp ? null : 'Session frame replay or reordering';
};
