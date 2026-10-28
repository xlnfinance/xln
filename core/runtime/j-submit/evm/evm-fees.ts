import { ethers } from 'ethers';
import { safeStringify } from '../../../protocol/serialization';

export type EvmFeeEvidence = { kind: 'evm-fee'; minimumBumpBps: number };
const EVM_REPLACEMENT_BUMP_BPS = 1250;
export const EVM_PENDING_BUMP_MS = 120_000;
export const EVM_RESPONSE_BUMP_WINDOW_MS = 120_000;

const validateBumpBps = (bps: number): void => {
  if (!Number.isSafeInteger(bps) || bps < 1000 || bps > 100_000) throw new Error('EVM_REPLACEMENT_BUMP_INVALID');
};
export const suggestReplacementFees = (
  old: ethers.Transaction,
  market: { maxFeePerGas?: bigint | null; maxPriorityFeePerGas?: bigint | null },
  minimumBumpBps = EVM_REPLACEMENT_BUMP_BPS,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } => {
  validateBumpBps(minimumBumpBps);
  if (old.type !== 2 || old.maxFeePerGas === null || old.maxPriorityFeePerGas === null)
    throw new Error('EVM_REPLACEMENT_REQUIRES_1559');
  const bump = (value: bigint) => (value * BigInt(10_000 + minimumBumpBps) + 9_999n) / 10_000n;
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  const priority = max(
    max(bump(old.maxPriorityFeePerGas), old.maxPriorityFeePerGas + 1n),
    market.maxPriorityFeePerGas ?? 0n,
  );
  return {
    maxFeePerGas: max(max(max(bump(old.maxFeePerGas), old.maxFeePerGas + 1n), market.maxFeePerGas ?? 0n), priority),
    maxPriorityFeePerGas: priority,
  };
};

/** Same payer + nonce permits at most one competing transaction to execute.
 * Never allocate another nonce: that could execute the financial call twice.
 * Preserve the entire execution envelope, changing only the two fee caps. */
export const validateEvmReplacement = (oldRaw: string, raw: string, previousHash: string, bps: number): void => {
  const old = ethers.Transaction.from(oldRaw);
  const next = ethers.Transaction.from(raw);
  if (!old.isSigned() || !next.isSigned() || old.hash !== previousHash || old.hash === next.hash)
    throw new Error('EVM_REPLACEMENT_HASH');
  const required = suggestReplacementFees(old, {}, bps);
  if (
    next.type !== 2 ||
    next.from !== old.from ||
    next.nonce !== old.nonce ||
    next.chainId !== old.chainId ||
    next.to !== old.to ||
    next.value !== old.value ||
    next.data !== old.data ||
    next.gasLimit !== old.gasLimit ||
    safeStringify(next.accessList) !== safeStringify(old.accessList)
  )
    throw new Error('EVM_REPLACEMENT_INTENT');
  if (
    next.maxFeePerGas === null ||
    next.maxPriorityFeePerGas === null ||
    next.maxFeePerGas < required.maxFeePerGas ||
    next.maxPriorityFeePerGas < required.maxPriorityFeePerGas ||
    next.maxFeePerGas < next.maxPriorityFeePerGas
  )
    throw new Error('EVM_REPLACEMENT_UNDERPRICED');
};
