/**
 * HTLC Utility Functions
 * Fee calculation, timelock derivation, lock ID generation
 */

import { ethers } from 'ethers';
import { HTLC } from './constants';

const DEFAULT_FEE_PPM = Number((HTLC.FEE_RATE_UBP * 1_000_000n) / HTLC.FEE_DENOMINATOR);

/**
 * Calculate HTLC fee (Coasian micro basis points)
 * Returns: amount after fee deduction
 *
 * Fee = base + (amount × rate_ubp / 10,000,000)
 * Example: $10,000 × 100 μbp = $0.10 fee
 */
export function calculateHtlcFee(amount: bigint): bigint {
  return calculateHtlcForwardAmount(amount);
}

/**
 * Calculate forwarded amount after fees.
 * Fee = baseFee + floor(amountIn * feePPM / 1,000,000)
 */
export function calculateHtlcForwardAmount(
  amountIn: bigint,
  feePPM: number = DEFAULT_FEE_PPM,
  baseFee: bigint = HTLC.BASE_FEE_USD
): bigint {
  if (amountIn <= 0n) {
    throw new Error(`Amount must be positive (got ${amountIn})`);
  }
  const ppm = Number.isFinite(feePPM) && feePPM >= 0 ? BigInt(Math.floor(feePPM)) : 0n;
  const rateFee = (amountIn * ppm) / 1_000_000n;
  const totalFee = baseFee + rateFee;

  if (totalFee >= amountIn) {
    throw new Error(`Fee ${totalFee} exceeds amount ${amountIn}`);
  }

  return amountIn - totalFee;
}

/**
 * Calculate fee amount (not remaining amount)
 */
export function calculateHtlcFeeAmount(
  amountIn: bigint,
  feePPM: number = DEFAULT_FEE_PPM,
  baseFee: bigint = HTLC.BASE_FEE_USD
): bigint {
  const ppm = Number.isFinite(feePPM) && feePPM >= 0 ? BigInt(Math.floor(feePPM)) : 0n;
  const rateFee = (amountIn * ppm) / 1_000_000n;
  return baseFee + rateFee;
}

/**
 * Compute minimal inbound amount needed to guarantee desired forwarded amount.
 * Inversion of calculateHtlcForwardAmount with integer rounding.
 */
export function calculateRequiredInboundForDesiredForward(
  desiredForwardAmount: bigint,
  feePPM: number = DEFAULT_FEE_PPM,
  baseFee: bigint = HTLC.BASE_FEE_USD
): bigint {
  if (desiredForwardAmount <= 0n) {
    throw new Error(`Desired forward amount must be positive (got ${desiredForwardAmount})`);
  }
  const ppm = Number.isFinite(feePPM) && feePPM >= 0 ? Math.floor(feePPM) : 0;
  if (ppm === 0 && baseFee === 0n) return desiredForwardAmount;

  let low = desiredForwardAmount + baseFee;
  let high = low;
  while (calculateHtlcForwardAmount(high, ppm, baseFee) < desiredForwardAmount) {
    high = high * 2n;
  }

  while (low < high) {
    const mid = (low + high) / 2n;
    const out = calculateHtlcForwardAmount(mid, ppm, baseFee);
    if (out >= desiredForwardAmount) high = mid;
    else low = mid + 1n;
  }
  return low;
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
