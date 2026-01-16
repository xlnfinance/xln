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
  const disputeHash = createDisputeProofHash(account, proofResult.proofBodyHash);

  // Extract counterparty's ECDSA signature from hanko
  let counterpartySig = '0x';
  if (account.counterpartyAccountProofHanko) {
    try {
      const { ethers } = await import('ethers');
      // Decode hanko ABI structure
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'],
        account.counterpartyAccountProofHanko
      );
      const packedSigs = decoded[0][1]; // packedSignatures field

      // Unpack to get first EOA signature
      const { unpackRealSignatures } = await import('../../hanko');
      const sigs = unpackRealSignatures(Buffer.from(packedSigs.slice(2), 'hex'));
      if (sigs.length > 0) {
        counterpartySig = '0x' + sigs[0]!.toString('hex');
        console.log(`   ✅ Extracted counterparty signature: ${counterpartySig.slice(0, 10)}...`);
      } else {
        addMessage(newState, `⚠️ No EOA signatures in counterparty hanko - using empty sig`);
      }
    } catch (error) {
      console.warn(`⚠️ Failed to extract signature from hanko: ${error}`);
      addMessage(newState, `⚠️ Failed to extract counterparty signature - dispute may fail`);
    }
  } else {
    console.warn(`⚠️ No counterpartyAccountProofHanko found - using empty signature`);
    addMessage(newState, `⚠️ No counterparty signature available - dispute may fail on-chain`);
  }

  const initialProof = buildInitialDisputeProof(account, counterpartySig, '0x');

  // Add to jBatch
  newState.jBatchState.batch.disputeStarts.push({
    counterentity: counterpartyEntityId,
    cooperativeNonce,
    disputeNonce,
    proofbodyHash: proofResult.proofBodyHash,
    sig: counterpartySig,
    initialArguments: '0x',
  });

  console.log(`✅ disputeStart: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Proof hash: ${proofResult.proofBodyHash.slice(0, 10)}...`);

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

  // Build proof
  const proofResult = buildAccountProofBody(account);

  // Determine who started (needed for contract logic)
  const startedByLeft = entityState.entityId < counterpartyEntityId;

  const finalProof = {
    counterentity: counterpartyEntityId,
    finalCooperativeNonce: account.proofHeader.cooperativeNonce,
    initialDisputeNonce: account.proofHeader.disputeNonce,
    finalDisputeNonce: account.proofHeader.disputeNonce,
    initialProofbodyHash: proofResult.proofBodyHash,
    finalProofbody: proofResult.proofBodyStruct,
    finalArguments: '0x',
    initialArguments: '0x',
    sig: cooperative ? '0x' : '0x',  // TODO: Get real signature if cooperative
    startedByLeft,
    disputeUntilBlock: 0,
    cooperative: cooperative || false,
  };

  // Add to jBatch
  newState.jBatchState.batch.disputeFinalizations.push(finalProof);

  console.log(`✅ disputeFinalize: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Mode: ${cooperative ? 'cooperative' : 'unilateral'}`);

  addMessage(newState, `⚖️ Dispute finalized vs ${counterpartyEntityId.slice(-4)} ${description ? `(${description})` : ''} - use jBroadcast to commit`);

  return { newState, outputs };
}
