/**
 * Mint Reserves Handler
 *
 * DIRECT MINT: Sends mint operation directly to J-machine (admin function)
 * Does NOT go through batch - minting is an admin operation, not a user transfer
 *
 * Flow:
 * 1. Entity requests mint
 * 2. J-machine directly mints via browserVM.debugFundReserves
 * 3. J-events route back with ReserveUpdated
 */

import type { EntityState, EntityTx, EntityInput, JInput, JTx, Env } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import {
  getJurisdictionConfigName,
  requireRuntimeJurisdictionConfigByName,
} from '../../jurisdiction/jurisdiction-runtime';
import { createStructuredLogger, shortId } from '../../logger';

const jBatchActionLog = createStructuredLogger('entity.jbatch');

export async function handleMintReserves(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'mintReserves' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs: JInput[] }> {
  const { tokenId, amount } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  jBatchActionLog.debug('mint.requested', {
    entity: shortId(entityState.entityId),
    tokenId,
    amount: amount.toString(),
  });

  // Create JTx for direct mint (bypasses batch - admin operation)
  const jTx: JTx = {
    type: 'mint',
    entityId: entityState.entityId,
    data: {
      entityId: entityState.entityId,
      tokenId,
      amount,
    },
    timestamp: newState.timestamp, // Entity-level timestamp for determinism
  };

  const configuredJurisdictionName = getJurisdictionConfigName(newState.config.jurisdiction);
  if (!configuredJurisdictionName) {
    addMessage(newState, '❌ Jurisdiction unavailable for mint: entity jurisdiction is not configured');
    return { newState, outputs, jOutputs: [] };
  }
  let jurisdictionName = configuredJurisdictionName;
  try {
    jurisdictionName = requireRuntimeJurisdictionConfigByName(
      env,
      configuredJurisdictionName,
      newState.config.jurisdiction,
    ).name;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addMessage(newState, `❌ Jurisdiction unavailable for mint: ${message}`);
    return { newState, outputs, jOutputs: [] };
  }
  const jOutputs: JInput[] = [{
    jurisdictionName,
    jTxs: [jTx],
  }];

  addMessage(newState, `💰 Minting ${amount} of token ${tokenId}`);

  jBatchActionLog.debug('mint.queued', {
    entity: shortId(entityState.entityId),
    jurisdiction: jurisdictionName,
    tokenId,
    amount: amount.toString(),
  });

  return { newState, outputs, jOutputs };
}
