import type { JTx } from '../types';
import { createStructuredLogger } from '../infra/logger';
import { makeJAdapterFailureResult } from './failure';
import type { JEvent, JSubmitResult } from './types';

const submitLog = createStructuredLogger('jadapter.rpc');

export const submitDebtEnforcement = async (
  jTx: Extract<JTx, { type: 'debtEnforcement' }>,
  enforceDebts: (
    entityId: string,
    tokenId: number,
    maxIterations: bigint,
  ) => Promise<void>,
): Promise<JSubmitResult> => {
  const entityId = String(jTx.entityId || '').toLowerCase();
  const tokenId = Number(jTx.data.tokenId);
  const maxIterations = BigInt(jTx.data.maxIterations);
  if (
    !entityId ||
    !Number.isInteger(tokenId) ||
    tokenId < 0 ||
    maxIterations <= 0n
  ) {
    return { success: false, error: 'Invalid debt enforcement payload' };
  }
  try {
    await enforceDebts(entityId, tokenId, maxIterations);
    return { success: true };
  } catch (error) {
    submitLog.error('debt_enforcement.failed', {
      entityId,
      tokenId,
      error: error instanceof Error ? error.message : String(error),
    });
    return makeJAdapterFailureResult(error);
  }
};

export const submitMint = async (
  jTx: Extract<JTx, { type: 'mint' }>,
  isDevChain: boolean,
  mint: (
    entityId: string,
    tokenId: number,
    amount: bigint,
  ) => Promise<JEvent[]>,
): Promise<JSubmitResult> => {
  const entityId = String(jTx.data.entityId || jTx.entityId || '');
  const tokenId = Number(jTx.data.tokenId);
  const amount = jTx.data.amount;
  if (!entityId || !Number.isFinite(tokenId) || amount <= 0n) {
    return { success: false, error: 'Invalid mint payload' };
  }
  if (!isDevChain) {
    return {
      success: false,
      error: 'Mint not supported on non-dev RPC chains',
    };
  }
  try {
    const events = await mint(entityId, tokenId, amount);
    const blockNumber = events.at(-1)?.blockNumber;
    return {
      success: true,
      events,
      ...(typeof blockNumber === 'number' ? { blockNumber } : {}),
    };
  } catch (error) {
    submitLog.error('mint.failed', {
      entityId,
      tokenId,
      error: error instanceof Error ? error.message : String(error),
    });
    return makeJAdapterFailureResult(error);
  }
};
