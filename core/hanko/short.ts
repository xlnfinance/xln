/**
 * 65-byte Hanko shortcut (HankoVerifier.verify).
 *
 * A raw `r||s||v` signature is the Hanko of the signer's own lazy 1-of-1
 * entity: id = keccak256(abi.encode(Board{1,[bytes32(addr)],[1],0,0,0})). The
 * chain accepts it wherever a Hanko is accepted; it is the full single-signer
 * envelope at a fraction of the calldata. Off-chain consensus keeps exchanging
 * full envelopes (Rust parity, one wire shape per proof); the shortcut is
 * applied at the jurisdiction submission boundary only.
 */
import { ethers } from 'ethers';

import type { HankoHex, HankoString } from '../types/hanko';
import { hashHankoBoardClaim } from './claims';
import {
  asHankoBytes32,
  decodeHankoEnvelope,
  recoverHankoSignatures,
  unpackHankoSignatures,
} from './codec';

const SHORT_HANKO_RE = /^0x[0-9a-f]{130}$/i;

export const isShortHanko = (hanko: string): boolean => SHORT_HANKO_RE.test(hanko);

/** Lazy entity id of an EOA: keccak256 of its canonical 1-of-1 board (delays 0). */
export const lazySingleSignerEntityId = (signerAddress: string): HankoHex => {
  if (!ethers.isAddress(signerAddress)) throw new Error(`LAZY_SIGNER_ADDRESS_INVALID:${signerAddress}`);
  return hashHankoBoardClaim({
    entityId: ethers.ZeroHash as HankoHex,
    members: [{ entityId: ethers.zeroPadValue(signerAddress, 32).toLowerCase() as HankoHex, weight: 1n }],
    threshold: 1n,
    delays: { boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n },
  });
};

/** Entity id the chain derives from a 65-byte Hanko over `digest`. */
export const recoverShortHankoEntityId = (hanko: string, digest: string): HankoHex => {
  if (!isShortHanko(hanko)) throw new Error('SHORT_HANKO_LENGTH_INVALID');
  const signerId = recoverHankoSignatures(asHankoBytes32(digest, 'DIGEST'), packSingle(hanko))[0]?.signerEntityId;
  if (!signerId) throw new Error('SHORT_HANKO_RECOVERY_FAILED');
  return lazySingleSignerEntityId(`0x${signerId.slice(-40)}`);
};

const packSingle = (signature: string): HankoHex => {
  const bytes = ethers.getBytes(signature);
  const recovery = bytes[64]!;
  const packed = new Uint8Array(65);
  packed.set(bytes.subarray(0, 64), 0);
  packed[64] = recovery === 28 || recovery === 1 ? 1 : 0;
  return ethers.hexlify(packed) as HankoHex;
};

/**
 * Compact a full envelope to the 65-byte form when, and only when, it is one
 * EOA signature claiming that signer's own lazy entity. Every other proof
 * (placeholders, quorum boards, registered/numbered entities, nested claims,
 * non-zero board delays) is returned unchanged.
 */
export const compactHankoForChain = (hanko: HankoString, digest: string): HankoString => {
  if (isShortHanko(hanko)) return hanko;
  const envelope = decodeHankoEnvelope(hanko);
  if (
    envelope.placeholders.length !== 0
    || envelope.memberSignatures.length !== 0
    || envelope.claims.length !== 1
  ) return hanko;
  const claim = envelope.claims[0]!;
  if (
    claim.entityIndexes.length !== 1 || claim.entityIndexes[0] !== 0n
    || claim.weights.length !== 1 || claim.weights[0] !== 1n
    || claim.threshold !== 1n
    || claim.boardChangeDelay !== 0n || claim.controlChangeDelay !== 0n || claim.dividendChangeDelay !== 0n
  ) return hanko;
  const signatures = unpackHankoSignatures(envelope.packedSignatures);
  if (signatures.length !== 1) return hanko;
  const recovered = recoverHankoSignatures(asHankoBytes32(digest, 'DIGEST'), envelope.packedSignatures);
  const signerId = recovered[0]?.signerEntityId;
  if (!signerId || lazySingleSignerEntityId(`0x${signerId.slice(-40)}`) !== claim.entityId) return hanko;
  return signatures[0]! as HankoString;
};

/** Target entity id of a chain-bound Hanko (short or full) without verifying it. */
export const chainHankoTargetEntityId = (hanko: string, digest: string): HankoHex => {
  if (isShortHanko(hanko)) return recoverShortHankoEntityId(hanko, digest);
  const claims = decodeHankoEnvelope(hanko as HankoString).claims;
  const target = claims[claims.length - 1];
  if (!target) throw new Error('HANKO_CLAIM_REQUIRED');
  return target.entityId;
};

/** Structural check for a Hanko about to be submitted: short form or a decodable envelope. */
export const assertChainHankoShape = (hanko: string): void => {
  if (isShortHanko(hanko)) return;
  decodeHankoEnvelope(hanko as HankoString);
};
