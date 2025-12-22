/**
 * HTLC Utility Functions
 * Fee calculation, timelock derivation, lock ID generation
 */

import { ethers } from 'ethers';
import { HTLC } from './constants';

/**
 * Calculate HTLC fee (Coasian micro basis points)
 * Returns: amount after fee deduction
 *
 * Fee = base + (amount × rate_ubp / 10,000,000)
 * Example: $10,000 × 100 μbp = $0.10 fee
 */
export function calculateHtlcFee(amount: bigint): bigint {
  // Fee = base + (amount × rate_ubp / FEE_DENOMINATOR)
  const rateFee = (amount * HTLC.FEE_RATE_UBP) / HTLC.FEE_DENOMINATOR;
  const totalFee = HTLC.BASE_FEE_USD + rateFee;

  if (totalFee >= amount) {
    throw new Error(`Fee ${totalFee} exceeds amount ${amount}`);
  }

  return amount - totalFee;
}

/**
 * Calculate fee amount (not remaining amount)
 */
export function calculateHtlcFeeAmount(amount: bigint): bigint {
  const rateFee = (amount * HTLC.FEE_RATE_UBP) / HTLC.FEE_DENOMINATOR;
  return HTLC.BASE_FEE_USD + rateFee;
}

/**
 * Generate deterministic lock ID
 * Pattern: keccak256(hashlock + height + nonce + timestamp)
 */
export function generateLockId(
  hashlock: string,
  height: number,
  nonce: number,
  timestamp: number
): string {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`${hashlock}:${height}:${nonce}:${timestamp}`)
  );
}

/**
 * Generate secret and hashlock for HTLC
 * Returns 32-byte random secret as hex string
 */
export function generateHashlock(): { secret: string; hashlock: string } {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Buffer.from(secretBytes).toString('hex');
  const hashlock = ethers.keccak256(ethers.toUtf8Bytes(secret));
  return { secret, hashlock };
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
  totalHops: number
): bigint {
  // Each hop gets HTLC_MIN_TIMELOCK_DELTA_MS less than previous
  const reduction = BigInt((totalHops - hopIndex - 1) * HTLC.MIN_TIMELOCK_DELTA_MS);
  return baseTimelock - reduction;
}

/**
 * Calculate revealBeforeHeight for hop
 * Alice gets most blocks (highest deadline)
 *
 * Alice: baseHeight + 3
 * Hub:   baseHeight + 2
 * Bob:   baseHeight + 1
 */
export function calculateHopRevealHeight(
  baseHeight: number,
  hopIndex: number,  // 0 = Alice, 1 = Hub, 2 = Bob
  totalHops: number
): number {
  // Alice (first hop) gets most time
  // Each subsequent hop gets 1 block less
  return baseHeight + (totalHops - hopIndex);
}
