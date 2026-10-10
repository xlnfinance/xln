/**
 * HTLC Utility Functions
 * Fee calculation, timelock derivation, lock ID generation
 */

import { ethers } from 'ethers';
import { HTLC } from '../../config/constants';

/**
 * Minimal inbound amount whose forward, after `baseFee + floor(in * ppm / 1e6)`,
 * still reaches `desiredForwardAmount`. Parity: Rust `required_htlc_inbound`
 * (entity-kernel prepared_context/htlc.rs).
 *
 * The forward is allowed to go negative while searching. A hub may advertise
 * a base fee far above the payment, so the first probe can already be "fee >=
 * amount"; treating that as an error halted the payer on a valid profile.
 */
export function calculateRequiredInboundForDesiredForward(
  desiredForwardAmount: bigint,
  feePPM: number,
  baseFee: bigint,
): bigint {
  if (
    desiredForwardAmount <= 0n
    || !Number.isSafeInteger(feePPM) || feePPM < 0 || feePPM >= 1_000_000
    || baseFee < 0n
  ) {
    throw new Error('HTLC_QUOTE_FEE_INVALID');
  }
  const ppm = BigInt(feePPM);
  const forwarded = (amountIn: bigint): bigint => amountIn - (baseFee + (amountIn * ppm) / 1_000_000n);
  let low = desiredForwardAmount + baseFee;
  let high = low;
  while (forwarded(high) < desiredForwardAmount) high *= 2n;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (forwarded(mid) >= desiredForwardAmount) high = mid;
    else low = mid + 1n;
  }
  return low;
}

/**
 * Hash HTLC secret using the on-chain convention (keccak256(abi.encode(secret))).
 */
// abi.encode(bytes32) is the 32 bytes themselves; the generic ABI coder plus a
// fresh keccak per call ran on every resolve, deadline check and route lookup
// (~2% of Hub CPU at 500 users). Bounded memo on the secret string.
const htlcSecretHashes = new Map<string, string>();
const HTLC_SECRET_HASH_MEMO_MAX = 65_536;

export function hashHtlcSecret(secret: string): string {
  const memoized = htlcSecretHashes.get(secret);
  if (memoized !== undefined) return memoized;
  if (!ethers.isHexString(secret, 32)) {
    throw new Error(`HTLC secret must be 32-byte hex (got ${secret.length} chars)`);
  }
  const hashed = ethers.keccak256(secret);
  if (htlcSecretHashes.size >= HTLC_SECRET_HASH_MEMO_MAX) htlcSecretHashes.clear();
  htlcSecretHashes.set(secret, hashed);
  return hashed;
}

/**
 * Calculate timelock for hop (decreases per hop for griefing protection)
 * Alice gets most time (prevents Sprite/Blitz attack)
 *
 * Alice: baseTimelock - 0ms
 * Hub:   baseTimelock - 10s
 * Bob:   baseTimelock - 20s
 */
export function calculateHopTimelock(
  baseTimelock: bigint,
  hopIndex: number,  // 0 = Alice (first), 1 = Hub, 2 = Bob
): bigint {
  if (!Number.isSafeInteger(hopIndex) || hopIndex < 0) {
    throw new Error(`HTLC_HOP_INDEX_INVALID:${hopIndex}`);
  }
  // Source owns the full window. Each actual forward applies exactly one
  // delta; pre-reducing by the route tail here would charge every hop twice.
  const reduction = BigInt(hopIndex) * BigInt(HTLC.MIN_TIMELOCK_DELTA_MS);
  return baseTimelock - reduction;
}

/**
 * Calculate revealBeforeHeight for hop
 * Alice gets most blocks (highest deadline)
 *
 * Adjacent hops are separated by a fixed multi-block enforcement reserve.
 * A one-block ladder is unsafe when the watcher advances between downstream
 * commit and the upstream Account reveal.
 */
export function calculateHopRevealHeight(
  baseHeight: number,
  hopIndex: number,  // 0 = Alice, 1 = Hub, 2 = Bob
  totalHops: number
): number {
  return baseHeight
    + (totalHops - hopIndex) * HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS;
}
