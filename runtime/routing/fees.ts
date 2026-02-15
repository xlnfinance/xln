/**
 * Deterministic routing fee helpers.
 *
 * Directional pricing:
 * utilization = 1 - (outCapacity / totalCapacity)
 * effectivePPM = basePPM * (1 + utilization)
 */
import { normalizeBigInt } from './capacity';

export const PPM_DENOM = 1_000_000n;
export const DIRECTIONAL_UTIL_STEP_PPM = 50_000n; // 5% utilization buckets
export const DIRECTIONAL_UTIL_CAP_PPM = 500_000n; // cap uplift at +50% (1.5x base fee)

const clampNonNegative = (value: bigint): bigint => (value < 0n ? 0n : value);

export const sanitizeFeePPM = (raw: unknown, fallback: number = 100): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < 0) return 0;
  if (v > 1_000_000) return 1_000_000;
  return v;
};

export const sanitizeBaseFee = (raw: unknown): bigint => {
  return clampNonNegative(normalizeBigInt(raw));
};

/**
 * Effective directional PPM derived from account direction utilization.
 * - outCapacity: available amount in this direction
 * - inCapacity: reverse-side capacity (used to estimate total directional room)
 */
export const calculateDirectionalFeePPM = (
  basePPM: number,
  outCapacity: bigint,
  inCapacity: bigint
): number => {
  const base = sanitizeFeePPM(basePPM, 100);
  const out = clampNonNegative(outCapacity);
  const inn = clampNonNegative(inCapacity);
  const total = out + inn;
  if (total <= 0n) return base;

  // utilScaled in [0, 1_000_000]
  let utilScaled = ((total - out) * PPM_DENOM) / total;
  if (utilScaled > DIRECTIONAL_UTIL_CAP_PPM) utilScaled = DIRECTIONAL_UTIL_CAP_PPM;
  // Quantize to reduce jitter from tiny balance/capacity changes
  utilScaled = (utilScaled / DIRECTIONAL_UTIL_STEP_PPM) * DIRECTIONAL_UTIL_STEP_PPM;
  const effective = BigInt(base) + (BigInt(base) * utilScaled) / PPM_DENOM;
  const asNumber = Number(effective);
  return Number.isFinite(asNumber) ? Math.max(0, Math.floor(asNumber)) : base;
};

export const calculateHopFee = (amountIn: bigint, feePPM: number, baseFee: bigint): bigint => {
  const amt = clampNonNegative(amountIn);
  const ppm = BigInt(sanitizeFeePPM(feePPM, 100));
  const base = sanitizeBaseFee(baseFee);
  return base + (amt * ppm) / PPM_DENOM;
};
