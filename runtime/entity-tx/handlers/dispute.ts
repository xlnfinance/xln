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

  const counterpartyIsLeft = account.leftEntity === counterpartyEntityId;

  const fillRatiosByOfferId = buildPendingSwapFillRatios(newState, counterpartyEntityId, account);
  const htlcSecrets = collectHtlcSecrets(newState, counterpartyEntityId);
  const { leftArguments, rightArguments } = buildDeltaTransformerArguments(account, {
    fillRatiosByOfferId,
    // disputeStart commits the argument blob later replayed as activeDispute.initialArguments
    // Keep secrets on the same side that we commit as initialArguments.
    leftSecrets: counterpartyIsLeft ? htlcSecrets : [],
    rightSecrets: counterpartyIsLeft ? [] : htlcSecrets,
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

  // Resolve the offchain nonce that matches the stored counterparty dispute signature.
  // This is the bilateral nonce at which the counterparty signed the dispute proof.
  // NOT the on-chain nonce (which is the last event-synced nonce from the J-machine).
  // Priority: exact hash→nonce map > stored counterparty sig nonce > proofHeader fallback.
  let signedNonce: number = account.proofHeader.nonce;
  let nonceSource = 'proofHeader';
  const mappedNonce = account.disputeProofNoncesByHash?.[proofBodyHashToUse];
  if (mappedNonce !== undefined) {
    signedNonce = mappedNonce;
    nonceSource = 'hashMap';
  } else if (account.counterpartyDisputeProofNonce !== undefined) {
    signedNonce = account.counterpartyDisputeProofNonce;
    nonceSource = 'counterpartySig';
  }

  // ASSERT: signedNonce must be positive (bilateral frames start nonces at 1)
  if (signedNonce <= 0) {
    addMessage(newState, `❌ Invalid dispute signedNonce=${signedNonce} — must be > 0`);
    console.error(`❌ disputeStart: signedNonce=${signedNonce} is invalid (source=${nonceSource})`);
    return { newState, outputs };
  }

  console.log(`   signedNonce=${signedNonce} (source=${nonceSource})`);

  // The signed nonce is passed directly to the contract. Solidity requires:
  //   nonce > _accounts[ch_key].nonce  (Account.sol:354)
  // On-chain nonce starts at 0 and only increments via settlements/disputes.
  // signedNonce >= 1 (from bilateral consensus) satisfies this.
  // CRITICAL: Do NOT add +1 — the hanko was signed over this exact nonce.
  newState.jBatchState.batch.disputeStarts.push({
    counterentity: counterpartyEntityId,
    nonce: signedNonce,
    proofbodyHash: proofBodyHashToUse,
    sig: counterpartyDisputeHanko,
    initialArguments,
  });

  console.log(`✅ disputeStart: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   proofBodyHash: ${proofBodyHashToUse.slice(0, 18)}...`);
  console.log(`   hankoLen: ${counterpartyDisputeHanko.length}, signedNonce: ${signedNonce}`);

  // NOTE: activeDispute will be set when DisputeStarted event arrives from J-machine
  // Event handler will query on-chain state and populate:
  // - startedByLeft, disputeTimeout, onChainNonce

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
  // Counter-dispute: our nonce is higher than the dispute's initial nonce (we have newer state)
  let isCounterDispute = account.proofHeader.nonce > account.activeDispute.initialNonce;

  // Resolve finalNonce — the offchain bilateral nonce for the finalization proof.
  // Counter-dispute: newer nonce from counterparty's signed proof (must be > initialNonce).
  // Unilateral: same as initialNonce (no sig needed, timeout enforces, contract does nonce++).
  // Priority: exact hash→nonce map > stored counterparty sig nonce > proofHeader fallback.
  const mappedFinalNonce = account.counterpartyDisputeProofBodyHash
    ? account.disputeProofNoncesByHash?.[account.counterpartyDisputeProofBodyHash]
    : undefined;
  let finalNonce: number;
  let finalNonceSource: string;
  if (!isCounterDispute) {
    finalNonce = account.activeDispute.initialNonce;
    finalNonceSource = 'initialNonce (unilateral)';
  } else if (mappedFinalNonce !== undefined) {
    finalNonce = mappedFinalNonce;
    finalNonceSource = 'hashMap';
  } else if (account.counterpartyDisputeProofNonce !== undefined) {
    finalNonce = account.counterpartyDisputeProofNonce;
    finalNonceSource = 'counterpartySig';
  } else {
    finalNonce = account.proofHeader.nonce;
    finalNonceSource = 'proofHeader (fallback)';
  }

  // ASSERT: finalNonce must be positive
  if (finalNonce <= 0) {
    addMessage(newState, `❌ Invalid dispute finalNonce=${finalNonce} — must be > 0`);
    console.error(`❌ disputeFinalize: finalNonce=${finalNonce} is invalid (source=${finalNonceSource})`);
    return { newState, outputs };
  }
  // Downgrade counter-dispute to unilateral if counterparty's signed nonce isn't actually newer
  if (isCounterDispute && finalNonce <= account.activeDispute.initialNonce) {
    console.warn(`⚠️ disputeFinalize: counter-dispute finalNonce=${finalNonce} <= initialNonce=${account.activeDispute.initialNonce} (source=${finalNonceSource}), downgrading to unilateral`);
    isCounterDispute = false;
    finalNonce = account.activeDispute.initialNonce;
    finalNonceSource = 'initialNonce (downgraded to unilateral)';
  }

  // Counter-dispute: use counterparty's DisputeProof hanko (proves they signed newer state)
  // Unilateral: no signature (timeout enforces)
  // Cooperative: use cooperative settlement sig (not implemented yet)
  const finalizeSig = isCounterDispute && account.counterpartyDisputeProofHanko
    ? account.counterpartyDisputeProofHanko
    : '0x';

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
    initialNonce: account.activeDispute.initialNonce,  // Nonce when dispute was started
    finalNonce,  // Counter-dispute: newer nonce (> initial). Unilateral: same as initial.
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
  console.log(`   initialNonce=${finalProof.initialNonce}, finalNonce=${finalProof.finalNonce} (source=${finalNonceSource})`);

  // Add to jBatch
  newState.jBatchState.batch.disputeFinalizations.push(finalProof);

  console.log(`✅ disputeFinalize: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Mode: ${cooperative ? 'cooperative' : 'unilateral'}`);

  addMessage(newState, `⚖️ Dispute finalized vs ${counterpartyEntityId.slice(-4)} ${description ? `(${description})` : ''} - use jBroadcast to commit`);

  return { newState, outputs };
}
