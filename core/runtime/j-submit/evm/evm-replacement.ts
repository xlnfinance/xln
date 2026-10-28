import { validateEvmFeeLimits, withinEvmFeeLimits } from './evm-fee-authorization';
import { ethers } from 'ethers';
import type { RuntimeReplica, RuntimeTx } from '../../types';
import type { JAdapter } from '../../../jurisdiction/adapter/types';
import type { JTx } from '../../../types/jurisdiction-runtime';
import { getLocalSignerPrivateKey } from '../../../account/crypto';
import { markLocalJSubmitRuntimeTx, findJSubmitReplica } from '../j-submit-state';
import {
  EVM_PENDING_BUMP_MS,
  EVM_RESPONSE_BUMP_WINDOW_MS,
  suggestReplacementFees,
  validateEvmReplacement,
} from './evm-fees';

type Batch = Extract<JTx, { type: 'batch' }>;
export type JFeeQuote = {
  currentMaxFeeWei: string;
  currentPriorityFeeWei: string;
  suggestedMaxFeeWei: string;
  suggestedPriorityFeeWei: string;
  attemptId: string;
  transactionHash: string;
  ceilingWei: string;
  deadline: number | null;
  remainingMs: number | null;
};

export const batchResponseDeadline = (env: RuntimeReplica, batch: Batch): number | null => {
  const replica = findJSubmitReplica(env, batch.entityId, batch.data.signerId ?? '');
  if (!replica) return null;
  const deadlines = batch.data.batch.counterDisputes.flatMap(op => {
    const account = replica.state.accounts.get(op.counterentity.toLowerCase());
    const active = account?.activeDispute;
    if (!account || !active?.observedOnChain) return [];
    return [active.disputeTimeout * 1000];
  });
  return deadlines.length ? Math.min(...deadlines) : null;
};

export const quoteJReplacement = async (
  adapter: JAdapter,
  batch: Batch,
  now: number,
  deadline: number | null,
): Promise<JFeeQuote> => {
  const attempt = batch.data.runtimeSubmitAttempt;
  if (!attempt?.rawTransaction || adapter.mode === 'tron') throw new Error('EVM_REPLACEMENT_WIRE_MISSING');
  const raw = attempt.rawTransaction;
  const limits = validateEvmFeeLimits(attempt.evmFeeLimits);
  const old = ethers.Transaction.from(raw);
  const fees = suggestReplacementFees(old, await adapter.provider.getFeeData(), Math.max(adapter.replacementMinimumBumpBps ?? 1250, 1250));
  return {
    attemptId: attempt.attemptId,
    transactionHash: ethers.keccak256(raw),
    ceilingWei: String([BigInt(limits.maxFeePerGasWei) * 2n, fees.maxFeePerGas, fees.maxPriorityFeePerGas].reduce((a, b) => a > b ? a : b)),
    currentMaxFeeWei: String(old.maxFeePerGas),
    currentPriorityFeeWei: String(old.maxPriorityFeePerGas),
    suggestedMaxFeeWei: String(fees.maxFeePerGas),
    suggestedPriorityFeeWei: String(fees.maxPriorityFeePerGas),
    deadline,
    remainingMs: deadline === null ? null : Math.max(0, deadline - now),
  };
};

export class EvmFeeReadError extends Error {
  constructor(cause: unknown) {
    super('EVM_REPLACEMENT_RPC_UNAVAILABLE', { cause });
  }
}

const readFeeRpc = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (cause) {
    throw new EvmFeeReadError(cause);
  }
};

const signReplacement = async (
  env: RuntimeReplica,
  adapter: JAdapter,
  batch: Batch,
  old: ethers.Transaction,
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): Promise<string> => {
  const signer = await evmPayerSigner(env, adapter, batch, old.serialized);
  const unsigned = ethers.Transaction.from({ ...old.toJSON(), signature: null, ...fees });
  return (await signer.signTransaction(unsigned)).toLowerCase();
};

const rejectedByNode = (env: RuntimeReplica, batch: Batch, raw: string): boolean => {
  const local = findJSubmitReplica(env, batch.entityId, batch.data.signerId ?? '')?.jSubmitState;
  // Feedback owns one exact wire; a rejected sibling cannot force endless bumps.
  return (
    local?.txHash?.toLowerCase() === ethers.keccak256(raw) &&
    /replacement.*underpriced|replacement fee too low/i.test(local.lastFailure?.message ?? '')
  );
};

/** External signing only; the returned RuntimeTx must fsync before any broadcast.
 * Age schedules a market check, never proves absence or alone authorizes a bump.
 * Every sibling hash derives from its durable signed wire, without a second hash store. */
export const prepareEvmFeeReplacement = async (
  env: RuntimeReplica,
  adapter: JAdapter,
  jurisdictionName: string,
  batch: Batch,
): Promise<RuntimeTx | null> => {
  const attempt = batch.data.runtimeSubmitAttempt;
  if (!attempt?.rawTransaction || adapter.mode === 'tron') return null;
  const now = env.state.timestamp;
  const last = attempt.feeBumpedAt ?? attempt.attemptedAt;
  const deadline = batchResponseDeadline(env, batch);
  const nodeRejected = rejectedByNode(env, batch, attempt.rawTransaction);
  const manual = (batch.data.feeOverrides?.gasBumpBps ?? 0) !== (attempt.requestedGasBumpBps ?? 0);
  const urgent = deadline !== null && deadline > now && deadline - now <= EVM_RESPONSE_BUMP_WINDOW_MS;
  if (!manual && deadline !== null && deadline <= now) return null;
  if (!manual && !nodeRejected && now - last < (urgent ? 30_000 : EVM_PENDING_BUMP_MS)) return null;
  for (const raw of [...(attempt.competingTransactions ?? []), attempt.rawTransaction]) {
    if (await readFeeRpc(() => adapter.provider.getTransactionReceipt(ethers.keccak256(raw)))) return null;
  }
  const old = ethers.Transaction.from(attempt.rawTransaction);
  const previousTransactionHash = old.hash;
  if (!previousTransactionHash) throw new Error('EVM_REPLACEMENT_UNSIGNED');
  const minimumBumpBps = Math.max(adapter.replacementMinimumBumpBps ?? 1250, batch.data.feeOverrides?.gasBumpBps ?? 0);
  const market = await readFeeRpc(() => adapter.provider.getFeeData());
  if (
    !manual &&
    !urgent &&
    !nodeRejected &&
    (market.maxFeePerGas ?? 0n) <= (old.maxFeePerGas ?? 0n) &&
    (market.maxPriorityFeePerGas ?? 0n) <= (old.maxPriorityFeePerGas ?? 0n)
  )
    return null;
  const limits = validateEvmFeeLimits(attempt.evmFeeLimits);
  const fees = suggestReplacementFees(old, market, minimumBumpBps);
  // Cap exhaustion retains every signed sibling for ordinary inclusion reconciliation.
  if (!withinEvmFeeLimits(fees, limits)) return null;
  const rawTransaction = await signReplacement(
    env,
    adapter,
    batch,
    old,
    fees,
  );
  validateEvmReplacement(attempt.rawTransaction, rawTransaction, previousTransactionHash, minimumBumpBps);
  return markLocalJSubmitRuntimeTx({
    type: 'replaceJPreparedTransaction',
    data: {
      jurisdictionName,
      attemptId: attempt.attemptId,
      previousTransactionHash,
      rawTransaction,
      evidence: { kind: 'evm-fee', minimumBumpBps },
    },
  });
};

/** Select the actual signed wire's payer, never substitute an Entity signer. */
export const evmPayerSigner = async (env: RuntimeReplica, adapter: JAdapter, batch: Batch, raw: string): Promise<ethers.Signer> => {
  const payer = ethers.Transaction.from(raw).from;
  const key = batch.data.signerId ? getLocalSignerPrivateKey(env, batch.data.signerId) : null;
  const local = key ? new ethers.Wallet(ethers.hexlify(key)) : null;
  const signer = local && local.address.toLowerCase() === payer?.toLowerCase() ? local : adapter.signer;
  if ((await signer.getAddress()).toLowerCase() !== payer?.toLowerCase()) throw new Error('EVM_REPLACEMENT_PAYER_UNAVAILABLE');
  return signer;
};
