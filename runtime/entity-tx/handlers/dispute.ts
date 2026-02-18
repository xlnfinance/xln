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

function getEnvJAdapter(env: Env) {
  if (!env.jReplicas || env.jReplicas.size === 0) return null;
  const active = env.activeJurisdiction ? env.jReplicas.get(env.activeJurisdiction) : undefined;
  if (active?.jadapter) return active.jadapter;
  for (const replica of env.jReplicas.values()) {
    if (replica.jadapter) return replica.jadapter;
  }
  return null;
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

  if ((account.status ?? 'active') !== 'active') {
    addMessage(newState, `❌ Account with ${counterpartyEntityId.slice(-4)} is disputed - reopen required`);
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

  if (!storedProofBodyHash) {
    addMessage(newState, `❌ Missing stored counterparty proofBodyHash - cannot start dispute safely`);
    console.error(`❌ disputeStart blocked: missing stored counterpartyDisputeProofBodyHash`);
    return { newState, outputs };
  }
  const proofBodyHashToUse = storedProofBodyHash;
  console.log(`✅ Using stored counterparty proofBodyHash: ${storedProofBodyHash.slice(0, 10)}...`);

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

  if (
    account.counterpartyDisputeProofNonce !== undefined &&
    account.counterpartyDisputeProofNonce > signedNonce
  ) {
    signedNonce = account.counterpartyDisputeProofNonce;
    nonceSource = 'counterpartySig(fresher)';
  }

  // ASSERT: signedNonce must be positive (bilateral frames start nonces at 1)
  if (signedNonce <= 0) {
    addMessage(newState, `❌ Invalid dispute signedNonce=${signedNonce} — must be > 0`);
    console.error(`❌ disputeStart: signedNonce=${signedNonce} is invalid (source=${nonceSource})`);
    return { newState, outputs };
  }

  let onChainNonce = Number(account.onChainSettlementNonce ?? 0);
  const jadapter = getEnvJAdapter(env);
  if (jadapter && typeof jadapter.getAccountInfo === 'function') {
    try {
      const accountInfo = await jadapter.getAccountInfo(entityState.entityId, counterpartyEntityId);
      onChainNonce = Number(accountInfo.nonce);
      account.onChainSettlementNonce = onChainNonce;
    } catch (error) {
      console.warn(
        `⚠️ disputeStart: failed to read on-chain nonce for ${counterpartyEntityId.slice(-4)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`   signedNonce=${signedNonce} (source=${nonceSource}), onChainNonce=${onChainNonce}`);

  // On-chain requires nonce > stored nonce for disputeStart.
  // If stale, caller must execute manual reopen flow first.
  if (signedNonce <= onChainNonce) {
    const msg = `❌ Stale dispute proof nonce ${signedNonce} (on-chain=${onChainNonce}) - reopen required`;
    addMessage(newState, msg);
    console.warn(`⚠️ disputeStart blocked: ${msg}`);
    return { newState, outputs };
  }

  // The signed nonce is passed directly to the contract. Solidity requires:
  //   nonce > _accounts[ch_key].nonce  (Account.sol:354)
  // On-chain nonce starts at 0 and increments via settlements/disputes.
  // signedNonce must be strictly greater than latest on-chain nonce.
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
 * Handle disputeFinalize - Entity finalizes dispute unilaterally after timeout.
 * Cooperative finalize is intentionally disabled.
 */
export async function handleDisputeFinalize(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'disputeFinalize' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { counterpartyEntityId, description } = entityTx.data;
  const cooperativeRequested = entityTx.data.cooperative === true;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`⚖️ disputeFinalize: ${entityState.entityId.slice(-4)} vs ${counterpartyEntityId.slice(-4)}`);
  console.log(`   Cooperative requested: ${cooperativeRequested}`);

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

  if (cooperativeRequested) {
    addMessage(
      newState,
      `❌ disputeFinalize cooperative=true rejected for ${counterpartyEntityId.slice(-4)} (unilateral-only protocol)`,
    );
    console.warn(
      `⚠️ disputeFinalize rejected: cooperative=true for ${counterpartyEntityId.slice(-4)} (unilateral-only)`,
    );
    return { newState, outputs };
  }

  // Build current proof (for finalization reveal)
  const currentProofResult = buildAccountProofBody(account);
  const finalNonce = account.activeDispute.initialNonce;
  const finalNonceSource = 'initialNonce (unilateral-only)';

  // ASSERT: finalNonce must be positive
  if (finalNonce <= 0) {
    addMessage(newState, `❌ Invalid dispute finalNonce=${finalNonce} — must be > 0`);
    console.error(`❌ disputeFinalize: finalNonce=${finalNonce} is invalid (source=${finalNonceSource})`);
    return { newState, outputs };
  }
  // Unilateral-only protocol: no counterparty signature on finalize.
  const finalizeSig = '0x';

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
  const shouldUseStoredProof = !!storedProofBody;
  if (currentProofResult.proofBodyHash !== account.activeDispute.initialProofbodyHash) {
    console.warn(`⚠️ disputeFinalize: current proofBodyHash != initial (current=${currentProofResult.proofBodyHash.slice(0, 10)}..., initial=${account.activeDispute.initialProofbodyHash.slice(0, 10)}...)`);
    if (!storedProofBody) {
      throw new Error('disputeFinalize: missing stored proofBody for unilateral finalize');
    }
  }

  const finalProofbody = shouldUseStoredProof
    ? storedProofBody
    : currentProofResult.proofBodyStruct;

  const finalProof = {
    counterentity: counterpartyEntityId,
    initialNonce: account.activeDispute.initialNonce,  // Nonce when dispute was started
    finalNonce,  // Unilateral-only: same as initial.
    initialProofbodyHash: account.activeDispute.initialProofbodyHash,  // From disputeStart (commit)
    finalProofbody,  // REVEAL
    finalArguments,
    initialArguments,
    sig: finalizeSig,  // Always empty for unilateral finalize
    startedByLeft: account.activeDispute.startedByLeft,  // From on-chain
    disputeUntilBlock: account.activeDispute.disputeTimeout,  // From on-chain
    cooperative: false,
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

  console.log(`   Mode: unilateral, timeout=${account.activeDispute.disputeTimeout}`);
  console.log(`   initialNonce=${finalProof.initialNonce}, finalNonce=${finalProof.finalNonce} (source=${finalNonceSource})`);

  // Enforce challenge-period expiry before enqueueing finalize.
  // disputeTimeout is tracked as J-layer block height from on-chain account state.
  const jadapter = getEnvJAdapter(env);
  if (jadapter?.provider) {
    const currentJBlock = Number(await jadapter.provider.getBlockNumber());
    if (currentJBlock < account.activeDispute.disputeTimeout) {
      addMessage(
        newState,
        `❌ disputeFinalize too early: currentBlock=${currentJBlock}, timeout=${account.activeDispute.disputeTimeout}`,
      );
      console.warn(
        `⚠️ disputeFinalize blocked (too early): currentBlock=${currentJBlock}, timeout=${account.activeDispute.disputeTimeout}`,
      );
      return { newState, outputs };
    }
  }

  // Add to jBatch
  newState.jBatchState.batch.disputeFinalizations.push(finalProof);

  console.log(`✅ disputeFinalize: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Mode: unilateral`);

  addMessage(newState, `⚖️ Dispute finalized vs ${counterpartyEntityId.slice(-4)} ${description ? `(${description})` : ''} - use jBroadcast to commit`);

  return { newState, outputs };
}
