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

export async function handleMintReserves(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'mintReserves' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs: JInput[] }> {
  const { tokenId, amount } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`💰 mintReserves: ${entityState.entityId.slice(-4)} minting ${amount} token ${tokenId}`);

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

  // Route to J-machine via standard jOutput flow
  const jurisdictionName = env.activeJurisdiction || 'default';
  const jOutputs: JInput[] = [{
    jurisdictionName,
    jTxs: [jTx],
  }];

  addMessage(newState, `💰 Minting ${amount} of token ${tokenId}`);

  console.log(`✅ mintReserves: Queued direct mint for ${entityState.entityId.slice(-4)}`);
  console.log(`   Token: ${tokenId}, Amount: ${amount}`);

  return { newState, outputs, jOutputs };
}
