/**
 * Dispute Handlers (disputeStart / disputeFinalize)
 *
 * Entity initiates dispute enforcement by adding proof to jBatch.
 * All validators sign the batch via hanko before broadcasting to jurisdiction.
 *
 * Flow:
 * 1. Entity creates disputeStart/disputeFinalize EntityTx
 * 2. Handler builds proof from current account state
 * 3. Add proof to jBatchState.batch.disputeStarts/disputeFinalizations
 * 4. Entity calls j_broadcast to submit to jurisdiction
 * 5. J-machine processes batch → emits DisputeStarted/DisputeFinalized events
 * 6. Events flow back to entities via j_event handlers
 */

import type { EntityState, EntityTx, EntityInput, Env } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { initJBatch } from '../../j-batch';
import { buildAccountProofBody, createDisputeProofHash, buildInitialDisputeProof } from '../../proof-builder';

/**
 * Handle disputeStart - Entity initiates dispute with signed proof
 */
export async function handleDisputeStart(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'disputeStart' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { counterpartyEntityId, description } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`⚔️ disputeStart: ${entityState.entityId.slice(-4)} vs ${counterpartyEntityId.slice(-4)}`);

  // Initialize jBatch if needed
  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  // Get bilateral account
  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    addMessage(newState, `❌ No account with ${counterpartyEntityId.slice(-4)} - cannot start dispute`);
    return { newState, outputs };
  }

  // Get on-chain cooperativeNonce (must match jurisdiction state)
  // In production, this would come from querying J-machine state
  // For now, use account's proofHeader.cooperativeNonce
  const cooperativeNonce = account.proofHeader.cooperativeNonce;
  const disputeNonce = account.proofHeader.disputeNonce;

  console.log(`   Using cooperativeNonce=${cooperativeNonce}, disputeNonce=${disputeNonce}`);

  // Build account proof
  const proofResult = buildAccountProofBody(account);

  // Use stored counterparty dispute hanko (exchanged during bilateral consensus)
  const counterpartyDisputeHanko = account.counterpartyDisputeProofHanko || '0x';
  if (!account.counterpartyDisputeProofHanko) {
    addMessage(newState, `⚠️ No counterparty dispute hanko - dispute may fail on-chain`);
    console.warn(`⚠️ Account ${counterpartyEntityId.slice(-4)} missing counterpartyDisputeProofHanko`);
  } else {
    console.log(`✅ Using stored counterparty dispute hanko: ${counterpartyDisputeHanko.slice(0, 20)}...`);
  }

  // Add to jBatch (sig = hanko for entity signing)
  newState.jBatchState.batch.disputeStarts.push({
    counterentity: counterpartyEntityId,
    cooperativeNonce,
    disputeNonce,
    proofbodyHash: proofResult.proofBodyHash,
    sig: counterpartyDisputeHanko,  // Hanko (or 65-byte ECDSA for backwards compat)
    initialArguments: '0x',
  });

  console.log(`✅ disputeStart: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Proof hash: ${proofResult.proofBodyHash.slice(0, 10)}...`);

  // NOTE: activeDispute will be set when DisputeStarted event arrives from J-machine
  // Event handler will query on-chain state and populate:
  // - startedByLeft, disputeTimeout, onChainCooperativeNonce

  addMessage(newState, `⚔️ Dispute started vs ${counterpartyEntityId.slice(-4)} ${description ? `(${description})` : ''} - use jBroadcast to commit`);

  return { newState, outputs };
}

/**
 * Handle disputeFinalize - Entity finalizes dispute after timeout or with cooperation
 */
export async function handleDisputeFinalize(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'disputeFinalize' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { counterpartyEntityId, cooperative, description } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`⚖️ disputeFinalize: ${entityState.entityId.slice(-4)} vs ${counterpartyEntityId.slice(-4)}`);
  console.log(`   Cooperative: ${cooperative || false}`);

  // Initialize jBatch if needed
  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  // Get bilateral account
  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    addMessage(newState, `❌ No account with ${counterpartyEntityId.slice(-4)} - cannot finalize dispute`);
    return { newState, outputs };
  }

  // Verify activeDispute exists (set by DisputeStarted j-event)
  if (!account.activeDispute) {
    addMessage(newState, `❌ No active dispute with ${counterpartyEntityId.slice(-4)} - must call disputeStart first`);
    return { newState, outputs };
  }

  // Build current proof (for counter-dispute, this might be newer state)
  const currentProofResult = buildAccountProofBody(account);

  // For unilateral finalization: use stored values from disputeStart
  // For counter-dispute: finalDisputeNonce > initialDisputeNonce with newer proof
  const isCounterDispute = cooperative || account.proofHeader.disputeNonce > account.activeDispute.initialDisputeNonce;

  const finalProof = {
    counterentity: counterpartyEntityId,
    finalCooperativeNonce: account.activeDispute.onChainCooperativeNonce,
    initialDisputeNonce: account.activeDispute.initialDisputeNonce,
    finalDisputeNonce: isCounterDispute ? account.proofHeader.disputeNonce : account.activeDispute.initialDisputeNonce,
    initialProofbodyHash: account.activeDispute.initialProofbodyHash,  // From disputeStart
    finalProofbody: currentProofResult.proofBodyStruct,
    finalArguments: '0x',
    initialArguments: '0x',
    sig: isCounterDispute && account.counterpartyDisputeProofHanko ? account.counterpartyDisputeProofHanko : '0x',
    startedByLeft: account.activeDispute.startedByLeft,  // From on-chain state
    disputeUntilBlock: account.activeDispute.disputeTimeout,  // From on-chain state
    cooperative: cooperative || false,
  };

  console.log(`   Using stored dispute state: startedByLeft=${account.activeDispute.startedByLeft}, timeout=${account.activeDispute.disputeTimeout}`);

  // Add to jBatch
  newState.jBatchState.batch.disputeFinalizations.push(finalProof);

  console.log(`✅ disputeFinalize: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Mode: ${cooperative ? 'cooperative' : 'unilateral'}`);

  addMessage(newState, `⚖️ Dispute finalized vs ${counterpartyEntityId.slice(-4)} ${description ? `(${description})` : ''} - use jBroadcast to commit`);

  return { newState, outputs };
}
