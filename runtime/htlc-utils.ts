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
 * Hash HTLC secret using the on-chain convention (keccak256(abi.encode(secret))).
 */
export function hashHtlcSecret(secret: string): string {
  if (!ethers.isHexString(secret, 32)) {
    throw new Error(`HTLC secret must be 32-byte hex (got ${secret.length} chars)`);
  }
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(abiCoder.encode(['bytes32'], [secret]));
}

/**
 * Generate secret and hashlock for HTLC
 * DEPRECATED: This function uses RNG and is non-deterministic!
 * For consensus-safe HTLC creation, pass secret/hashlock explicitly in tx.data
 *
 * @throws Error - Always throws to prevent non-deterministic usage in consensus
 */
export function generateHashlock(): { secret: string; hashlock: string } {
  throw new Error(
    'generateHashlock() is non-deterministic and BANNED in consensus code. ' +
    'Pass secret/hashlock as tx.data parameters (derived from tx hash or provided by user).'
  );
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
