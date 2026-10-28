import { ethers } from 'ethers';
import type { RuntimeInput, RuntimeReplica } from '../../types';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
} from '../../../protocol/boundary/boundary-primitives';
import { withRuntimeCommittedRead } from '../../frame/lifecycle/writer-lock';
import { registerRuntimeFrameCommitCallback } from '../../loop/loop-environment';
import { authorizeEvmFeeLimits, validateEvmFeeLimits } from './evm-fee-authorization';
import { evmPayerSigner } from './evm-replacement';

export type EvmFeeAuthorizationRequest = {
  type: 'authorize-evm-fees';
  entityId: string;
  signerId: string;
  attemptId: string;
  transactionHash: string;
  ceilingWei: string;
};

export const decodeEvmFeeAuthorizationRequest = (value: unknown): EvmFeeAuthorizationRequest => {
  const data = requireBoundaryRecord(value, 'EVM_FEE_REQUEST');
  requireExactBoundaryKeys(
    data,
    ['type', 'entityId', 'signerId', 'attemptId', 'transactionHash', 'ceilingWei'],
    [],
    'EVM_FEE_REQUEST_FIELDS',
  );
  if (data['type'] !== 'authorize-evm-fees') throw new Error('EVM_FEE_REQUEST_TYPE');
  const read = (key: string, pattern: RegExp): string => {
    const text = requireString(data[key], 'EVM_FEE_REQUEST_FIELD');
    if (!pattern.test(text)) throw new Error('EVM_FEE_REQUEST_FIELD');
    return text;
  };
  const ceilingWei = requireString(data['ceilingWei'], 'EVM_FEE_REQUEST_CEILING');
  validateEvmFeeLimits({ maxFeePerGasWei: ceilingWei, maxPriorityFeePerGasWei: ceilingWei });
  return {
    type: 'authorize-evm-fees',
    entityId: read('entityId', /^0x[0-9a-f]{64}$/),
    signerId: read('signerId', /^0x[0-9a-f]{40}$/),
    attemptId: read('attemptId', /^0x[0-9a-f]{64}$/),
    transactionHash: read('transactionHash', /^0x[0-9a-f]{64}$/),
    ceilingWei,
  };
};

const pendingWire = (env: RuntimeReplica, request: EvmFeeAuthorizationRequest) => {
  for (const input of env.infrastructure?.pendingCommittedJOutbox ?? []) {
    for (const batch of input.jTxs) {
      if (batch.type !== 'batch' || batch.entityId !== request.entityId || batch.data.signerId !== request.signerId)
        continue;
      const attempt = batch.data.runtimeSubmitAttempt;
      if (
        attempt?.attemptId !== request.attemptId ||
        !attempt.rawTransaction ||
        ethers.keccak256(attempt.rawTransaction) !== request.transactionHash
      )
        continue;
      const adapter = env.infrastructure?.liveJAdapters?.get(input.jurisdictionName);
      if (!adapter || adapter.mode === 'tron') throw new Error('EVM_FEE_PAYER_UNAVAILABLE');
      return {
        batch,
        raw: attempt.rawTransaction,
        limits: validateEvmFeeLimits(attempt.evmFeeLimits),
        adapter,
        jurisdictionName: input.jurisdictionName,
      };
    }
  }
  throw new Error('EVM_FEE_QUOTE_STALE');
};

/** Admin action signs only the current payer's exact wire. Return after WAL commit;
 * the wallet requests rebroadcast afterwards. Cancellation before dispatch signs nothing. */
export const commitEvmFeeAuthorization = async (
  env: RuntimeReplica,
  value: EvmFeeAuthorizationRequest,
  enqueue: (env: RuntimeReplica, input: RuntimeInput) => void,
): Promise<{ height: number }> => {
  const request = decodeEvmFeeAuthorizationRequest(value);
  const pending = await withRuntimeCommittedRead(env, () => {
    const current = pendingWire(env, request);
    if (BigInt(request.ceilingWei) <= BigInt(current.limits.maxFeePerGasWei))
      throw new Error('EVM_FEE_CEILING_NOT_RAISED');
    return { ...current, batch: structuredClone(current.batch), raw: current.raw };
  });
  const signer = await evmPayerSigner(env, pending.adapter, pending.batch, pending.raw);
  const tx = await authorizeEvmFeeLimits(signer, pending.jurisdictionName, request.attemptId, pending.raw, {
    maxFeePerGasWei: request.ceilingWei,
    maxPriorityFeePerGasWei: request.ceilingWei,
  });
  if (!tx.data.feeAuthorization) throw new Error('EVM_FEE_AUTHORIZATION_MISSING');
  const signature = tx.data.feeAuthorization.signature;
  await withRuntimeCommittedRead(env, () => {
    pendingWire(env, request);
  });
  await new Promise<void>((resolve, reject) => {
    const off = registerRuntimeFrameCommitCallback(env, ({ runtimeInput }) => {
      if (
        !runtimeInput.runtimeTxs.some(
          candidate =>
            candidate.type === 'recordJPreparedTransaction' &&
            candidate.data.attemptId === request.attemptId &&
            candidate.data.feeAuthorization?.signature === signature,
        )
      )
        return;
      clearTimeout(timer);
      off();
      try {
        const current = pendingWire(env, request);
        if (current.limits.maxFeePerGasWei !== request.ceilingWei)
          throw new Error('EVM_FEE_AUTHORIZATION_NOT_COMMITTED');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error('EVM_FEE_AUTHORIZATION_WAL_TIMEOUT'));
    }, 30_000);
    try {
      enqueue(env, { runtimeTxs: [tx], entityInputs: [] });
    } catch (error) {
      clearTimeout(timer);
      off();
      reject(error);
    }
  });
  return { height: env.state.height };
};
