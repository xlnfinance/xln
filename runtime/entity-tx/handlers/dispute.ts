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

import { ethers } from 'ethers';
import type { EntityState, EntityTx, EntityInput, Env, AccountMachine } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { initJBatch, batchAddRevealSecret, assertBatchNotPending } from '../../j-batch';
import { getDeltaTransformerAddress } from '../../proof-builder';
import { buildAccountProofBody, createDisputeProofHash, buildInitialDisputeProof } from '../../proof-builder';

// === Delta Transformer Arguments (inlined from transformer-args.ts) ===
const MAX_FILL_RATIO = 0xffff;

type BuildArgsOptions = {
  fillRatiosByOfferId?: Map<string, number>;
  leftSecrets?: string[];
  rightSecrets?: string[];
};

function clampFillRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= MAX_FILL_RATIO) return MAX_FILL_RATIO;
  return Math.floor(value);
}

function encodeDeltaTransformerArgs(fillRatios: number[], secrets: string[]): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const ratios = fillRatios.map(r => BigInt(clampFillRatio(r)));
  return abiCoder.encode(['uint32[]', 'bytes32[]'], [ratios, secrets]);
}

function wrapTransformerArgs(args: string): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(['bytes[]'], [[args]]);
}

function buildDeltaTransformerArguments(
  accountMachine: AccountMachine,
  options: BuildArgsOptions = {}
): { leftArguments: string; rightArguments: string } {
  const hasLocks = accountMachine.locks?.size ? accountMachine.locks.size > 0 : false;
  const hasSwaps = accountMachine.swapOffers?.size ? accountMachine.swapOffers.size > 0 : false;
  if (!hasLocks && !hasSwaps) {
    return { leftArguments: '0x', rightArguments: '0x' };
  }

  const leftFillRatios: number[] = [];
  const rightFillRatios: number[] = [];
  const sortedSwaps = Array.from(accountMachine.swapOffers.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  for (const [offerId, offer] of sortedSwaps) {
    const ratio = options.fillRatiosByOfferId?.get(offerId) ?? 0;
    if (offer.makerIsLeft) {
      rightFillRatios.push(ratio);
    } else {
      leftFillRatios.push(ratio);
    }
  }

  const leftSecrets = options.leftSecrets ?? [];
  const rightSecrets = options.rightSecrets ?? [];

  const leftArgs = encodeDeltaTransformerArgs(leftFillRatios, leftSecrets);
  const rightArgs = encodeDeltaTransformerArgs(rightFillRatios, rightSecrets);

  const hasLeftData = leftSecrets.length > 0 || leftFillRatios.some(r => r > 0);
  const hasRightData = rightSecrets.length > 0 || rightFillRatios.some(r => r > 0);

  return {
    leftArguments: hasLeftData ? wrapTransformerArgs(leftArgs) : '0x',
    rightArguments: hasRightData ? wrapTransformerArgs(rightArgs) : '0x',
  };
}

function buildPendingSwapFillRatios(
  entityState: EntityState,
  counterpartyEntityId: string,
  account: AccountMachine
): Map<string, number> {
  const pending = entityState.pendingSwapFillRatios;
  if (!pending || pending.size === 0) return new Map();

  const ratios = new Map<string, number>();
  for (const offerId of account.swapOffers.keys()) {
    const key = `${counterpartyEntityId}:${offerId}`;
    const ratio = pending.get(key);
    if (ratio !== undefined) {
      ratios.set(offerId, ratio);
    }
  }
  return ratios;
}

function collectHtlcSecrets(entityState: EntityState, counterpartyEntityId: string): string[] {
  const secrets: string[] = [];
  if (!entityState.htlcRoutes?.size) return secrets;
  const seen = new Set<string>();

  for (const route of entityState.htlcRoutes.values()) {
    if (!route.secret) continue;
    const involvesCounterparty =
      route.inboundEntity === counterpartyEntityId ||
      route.outboundEntity === counterpartyEntityId;
    if (!involvesCounterparty) continue;
    if (seen.has(route.secret)) continue;
    seen.add(route.secret);
    secrets.push(route.secret);
  }
  return secrets;
}

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

  // Block if batch has pending broadcast
  assertBatchNotPending(newState.jBatchState, 'disputeStart');

  // Get bilateral account
  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    addMessage(newState, `❌ No account with ${counterpartyEntityId.slice(-4)} - cannot start dispute`);
    return { newState, outputs };
  }

  const disputeNonce = account.proofHeader.disputeNonce;
  const counterpartyIsLeft = account.leftEntity === counterpartyEntityId;

  const fillRatiosByOfferId = buildPendingSwapFillRatios(newState, counterpartyEntityId, account);
  const { leftArguments, rightArguments } = buildDeltaTransformerArguments(account, {
    fillRatiosByOfferId,
  });

  const initialArguments = counterpartyIsLeft ? leftArguments : rightArguments;

  // Use stored counterparty dispute hanko AND proofBodyHash (exchanged during bilateral consensus)
  // CRITICAL: Must use the SAME proofBodyHash that the hanko signed, not a fresh one!
  const counterpartyDisputeHanko = account.counterpartyDisputeProofHanko;
  const storedProofBodyHash = account.counterpartyDisputeProofBodyHash;

  if (!counterpartyDisputeHanko || counterpartyDisputeHanko === '0x' || counterpartyDisputeHanko.length <= 2) {
    addMessage(newState, `❌ Missing counterparty dispute hanko - cannot start dispute`);
    console.error(`❌ Account ${counterpartyEntityId.slice(-4)} has empty counterpartyDisputeProofHanko`);
    return { newState, outputs };
  }

  console.log(`✅ Using stored counterparty dispute hanko:`);
  console.log(`   Length: ${counterpartyDisputeHanko.length} bytes`);
  console.log(`   First 66 chars: ${counterpartyDisputeHanko.slice(0, 66)}`);
  console.log(`   Sig bytes: ${(counterpartyDisputeHanko.length - 2) / 2}`);

  // Use stored proofBodyHash if available, otherwise build fresh (fallback for legacy)
  let proofBodyHashToUse: string;
  if (storedProofBodyHash) {
    proofBodyHashToUse = storedProofBodyHash;
    console.log(`✅ Using stored counterparty proofBodyHash: ${storedProofBodyHash.slice(0, 10)}...`);
  } else {
    // Fallback: build fresh (may not match hanko if state changed!)
    const proofResult = buildAccountProofBody(account);
    proofBodyHashToUse = proofResult.proofBodyHash;
    console.warn(`⚠️ No stored proofBodyHash - using fresh (may mismatch hanko!)`);
  }

  // Use cooperativeNonce that matches the stored counterparty dispute signature.
  // Prefer exact hash mapping, then cached nonce, then ackedTransitions fallback.
  const hasCounterpartySig = Boolean(account.counterpartyDisputeProofHanko);
  let cooperativeNonce = account.proofHeader.cooperativeNonce;
  let nonceSource = 'proofHeader';
  const mappedNonce = account.disputeProofNoncesByHash?.[proofBodyHashToUse];
  if (mappedNonce !== undefined) {
    cooperativeNonce = mappedNonce;
    nonceSource = 'hashMap';
  } else if (account.counterpartyDisputeProofCooperativeNonce !== undefined) {
    cooperativeNonce = account.counterpartyDisputeProofCooperativeNonce;
    nonceSource = 'counterpartySig';
  } else if (hasCounterpartySig && account.ackedTransitions > 0) {
    cooperativeNonce = account.ackedTransitions - 1;
    nonceSource = 'ackedTransitions-1';
  }
  console.log(`   Using cooperativeNonce=${cooperativeNonce} (${nonceSource}), disputeNonce=${disputeNonce}`);

  // Add to jBatch (sig = hanko for entity signing)
  newState.jBatchState.batch.disputeStarts.push({
    counterentity: counterpartyEntityId,
    cooperativeNonce,
    disputeNonce,
    proofbodyHash: proofBodyHashToUse,
    sig: counterpartyDisputeHanko,  // Hanko signature
    initialArguments,
  });

  console.log(`✅ disputeStart: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Proof hash: ${proofBodyHashToUse.slice(0, 10)}...`);
  console.log(`   Hanko sig length: ${counterpartyDisputeHanko?.length || 0}, first 40: ${counterpartyDisputeHanko?.slice(0, 40) || 'EMPTY'}`);
  console.log(`   cooperativeNonce: ${cooperativeNonce}, disputeNonce: ${disputeNonce}`);

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

  // Block if batch has pending broadcast
  assertBatchNotPending(newState.jBatchState, 'disputeFinalize');

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

  // Build current proof (for finalization reveal)
  const currentProofResult = buildAccountProofBody(account);
  const counterpartyProofBodyHash = account.counterpartyDisputeProofBodyHash;
  const counterpartyProofBody = counterpartyProofBodyHash
    ? account.disputeProofBodiesByHash?.[counterpartyProofBodyHash]
    : undefined;

  // Determine finalization mode
  const isCounterDispute = account.proofHeader.disputeNonce > account.activeDispute.initialDisputeNonce;

  // Counter-dispute: use counterparty's DisputeProof hanko (same as start, proves they signed newer state)
  // Unilateral: no signature (timeout enforces)
  // Cooperative: use cooperative settlement sig (not implemented yet)
  const finalizeSig = isCounterDispute && account.counterpartyDisputeProofHanko
    ? account.counterpartyDisputeProofHanko
    : '0x';

  const mappedFinalNonce = account.counterpartyDisputeProofBodyHash
    ? account.disputeProofNoncesByHash?.[account.counterpartyDisputeProofBodyHash]
    : undefined;
  const finalCooperativeNonce = isCounterDispute
    ? (mappedFinalNonce ?? account.counterpartyDisputeProofCooperativeNonce ?? account.proofHeader.cooperativeNonce)
    : account.activeDispute.onChainCooperativeNonce;

  const callerIsLeft = account.leftEntity === newState.entityId;
  const fillRatiosByOfferId = buildPendingSwapFillRatios(newState, counterpartyEntityId, account);
  const htlcSecrets = collectHtlcSecrets(newState, counterpartyEntityId);
  const { leftArguments, rightArguments } = buildDeltaTransformerArguments(account, {
    fillRatiosByOfferId,
    leftSecrets: callerIsLeft ? htlcSecrets : [],
    rightSecrets: callerIsLeft ? [] : htlcSecrets,
  });

  const finalArguments = callerIsLeft ? leftArguments : rightArguments;
  const initialArguments = account.activeDispute.initialArguments || (callerIsLeft ? rightArguments : leftArguments);

  const storedProofBody = account.activeDispute.initialProofbodyHash
    ? account.disputeProofBodiesByHash?.[account.activeDispute.initialProofbodyHash]
    : undefined;
  if (isCounterDispute && !counterpartyProofBody) {
    throw new Error('disputeFinalize: missing counterparty proof body for counter-dispute');
  }
  const shouldUseStoredProof = !isCounterDispute && !cooperative && storedProofBody;
  if (!isCounterDispute && !cooperative && currentProofResult.proofBodyHash !== account.activeDispute.initialProofbodyHash) {
    console.warn(`⚠️ disputeFinalize: current proofBodyHash != initial (current=${currentProofResult.proofBodyHash.slice(0, 10)}..., initial=${account.activeDispute.initialProofbodyHash.slice(0, 10)}...)`);
    if (!storedProofBody) {
      throw new Error('disputeFinalize: missing stored proofBody for unilateral finalize');
    }
  }

  const finalProofbody = isCounterDispute
    ? (counterpartyProofBody || currentProofResult.proofBodyStruct)
    : (shouldUseStoredProof ? storedProofBody : currentProofResult.proofBodyStruct);

  const finalProof = {
    counterentity: counterpartyEntityId,
    initialCooperativeNonce: account.activeDispute.initialCooperativeNonce,  // From disputeStart
    finalCooperativeNonce,
    initialDisputeNonce: account.activeDispute.initialDisputeNonce,
    finalDisputeNonce: isCounterDispute ? account.proofHeader.disputeNonce : account.activeDispute.initialDisputeNonce,
    initialProofbodyHash: account.activeDispute.initialProofbodyHash,  // From disputeStart (commit)
    finalProofbody,  // REVEAL
    finalArguments,
    initialArguments,
    sig: finalizeSig,  // Empty for unilateral, counterparty DisputeProof hanko for counter
    startedByLeft: account.activeDispute.startedByLeft,  // From on-chain
    disputeUntilBlock: account.activeDispute.disputeTimeout,  // From on-chain
    cooperative: cooperative || false,
  };

  // Optional fallback: on-chain HTLC registry (Sprites-style)
  if (entityTx.data.useOnchainRegistry) {
    const transformerAddress = getDeltaTransformerAddress();
    if (transformerAddress !== '0x0000000000000000000000000000000000000000') {
      for (const secret of htlcSecrets) {
        batchAddRevealSecret(newState.jBatchState, transformerAddress, secret);
      }
    } else {
      console.warn('⚠️ disputeFinalize: DeltaTransformer address not set - skipping on-chain HTLC reveals');
    }
  }

  console.log(`   Mode: ${isCounterDispute ? 'counter-dispute' : 'unilateral'}, timeout=${account.activeDispute.disputeTimeout}`);
  console.log(`   DEBUG: initialCooperativeNonce=${finalProof.initialCooperativeNonce}, onChainNonce=${finalProof.finalCooperativeNonce}`);

  // Add to jBatch
  newState.jBatchState.batch.disputeFinalizations.push(finalProof);

  console.log(`✅ disputeFinalize: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Mode: ${cooperative ? 'cooperative' : 'unilateral'}`);

  addMessage(newState, `⚖️ Dispute finalized vs ${counterpartyEntityId.slice(-4)} ${description ? `(${description})` : ''} - use jBroadcast to commit`);

  return { newState, outputs };
}
