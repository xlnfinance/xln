import { ethers } from 'ethers';

import type { EntityInput, EntityState, EntityTx } from '../../types';
import { initJBatch, batchAddExternalTokenToReserve } from '../../j-batch';
import { addMessage, cloneEntityState } from '../../state-helpers';

export async function handleE2R(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'e2r' }>,
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { contractAddress, amount } = entityTx.data;
  const tokenType = typeof entityTx.data.tokenType === 'number' ? entityTx.data.tokenType : 0;
  const externalTokenId = typeof entityTx.data.externalTokenId === 'bigint' ? entityTx.data.externalTokenId : 0n;
  const internalTokenId = typeof entityTx.data.internalTokenId === 'number' ? entityTx.data.internalTokenId : 0;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  if (!ethers.isAddress(contractAddress) || contractAddress === ethers.ZeroAddress) {
    const msg = `❌ Invalid external token contract: ${contractAddress}`;
    addMessage(newState, msg);
    throw new Error(msg);
  }
  if (amount <= 0n) {
    const msg = `❌ External → Reserve amount must be positive`;
    addMessage(newState, msg);
    throw new Error(msg);
  }

  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  batchAddExternalTokenToReserve(
    newState.jBatchState,
    entityState.entityId,
    contractAddress,
    amount,
    tokenType,
    externalTokenId,
    internalTokenId,
  );

  addMessage(
    newState,
    `📦 Queued E→R: ${amount} via ${contractAddress.slice(0, 10)}... (use j_broadcast to commit)`,
  );

  return { newState, outputs };
}
