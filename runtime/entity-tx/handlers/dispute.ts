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
import type { ProofBodyStruct } from '../../typechain/Depository';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { initJBatch, batchAddRevealSecret } from '../../j-batch';
import { getDeltaTransformerAddress } from '../../proof-builder';
import { getRuntimeJurisdictionDefaultDisputeDelayBlocks, getRuntimeJurisdictionHeight } from '../../j-height';
import {
  buildAccountProofBody,
  createDisputeProofHash,
  createDisputeProofHashWithNonce,
  buildInitialDisputeProof,
} from '../../proof-builder';
import { inspectHankoForHash, verifyHankoForHash } from '../../hanko/signing';
import { compareCanonicalText, swapKey } from '../../swap-execution';

// === Delta Transformer Arguments (inlined from transformer-args.ts) ===
const MAX_FILL_RATIO = 0xffff;

type BuildArgsOptions = {
  fillRatiosByOfferId?: Map<string, number>;
  leftSecrets?: string[];
  rightSecrets?: string[];
};

const isProofBodyStruct = (value: unknown): value is ProofBodyStruct => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.offdeltas) &&
    Array.isArray(candidate.tokenIds) &&
    Array.isArray(candidate.transformers)
  );
};

const requireProofBodyStruct = (
  value: unknown,
  entityId: string,
  counterpartyEntityId: string,
  source: string,
): ProofBodyStruct => {
  if (!isProofBodyStruct(value)) {
    throw new Error(
      `DISPUTE_FINALIZE_PROOFBODY_INVALID: entity=${entityId} counterparty=${counterpartyEntityId} source=${source}`,
    );
  }
  return value;
};

const toBigIntStrict = (value: unknown, label: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`DISPUTE_FINALIZE_PROOFBODY_VALUE_INVALID:${label}`);
};

const requireBytesLike = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`DISPUTE_FINALIZE_PROOFBODY_BYTES_INVALID:${label}`);
  }
  return value;
};

const requireAddressLike = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.startsWith('0x') || value.length !== 42) {
    throw new Error(`DISPUTE_FINALIZE_PROOFBODY_ADDRESS_INVALID:${label}`);
  }
  return value;
};

const canonicalizeProofBodyStruct = (
  value: ProofBodyStruct,
  entityId: string,
  counterpartyEntityId: string,
  source: string,
): ProofBodyStruct => {
  const proofBody = requireProofBodyStruct(value, entityId, counterpartyEntityId, source);
  return {
    offdeltas: proofBody.offdeltas.map((entry, index) => toBigIntStrict(entry, `${source}.offdeltas[${index}]`)),
    tokenIds: proofBody.tokenIds.map((entry, index) => toBigIntStrict(entry, `${source}.tokenIds[${index}]`)),
    transformers: proofBody.transformers.map((transformer, transformerIndex) => ({
      transformerAddress: requireAddressLike(
        transformer.transformerAddress,
        `${source}.transformers[${transformerIndex}].transformerAddress`,
      ),
      encodedBatch: requireBytesLike(
        transformer.encodedBatch,
        `${source}.transformers[${transformerIndex}].encodedBatch`,
      ),
      allowances: transformer.allowances.map((allowance, allowanceIndex) => ({
        deltaIndex: toBigIntStrict(
          allowance.deltaIndex,
          `${source}.transformers[${transformerIndex}].allowances[${allowanceIndex}].deltaIndex`,
        ),
        rightAllowance: toBigIntStrict(
          allowance.rightAllowance,
          `${source}.transformers[${transformerIndex}].allowances[${allowanceIndex}].rightAllowance`,
        ),
        leftAllowance: toBigIntStrict(
          allowance.leftAllowance,
          `${source}.transformers[${transformerIndex}].allowances[${allowanceIndex}].leftAllowance`,
        ),
      })),
    })),
  };
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
    .sort((a, b) => compareCanonicalText(a[0], b[0]));

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
    const key = swapKey(counterpartyEntityId, offerId);
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

function resolveDepositoryAddress(entityState: EntityState): string | null {
  const address = entityState.config.jurisdiction?.depositoryAddress || '';
  if (ethers.isAddress(address) && !/^0x0{40}$/i.test(address)) return address;
  return null;
}

function hasQueuedDisputeStart(state: EntityState, counterpartyEntityId: string): boolean {
  const target = String(counterpartyEntityId || '').toLowerCase();
  if (!target) return false;
  const draft = state.jBatchState?.batch?.disputeStarts || [];
  const sent = state.jBatchState?.sentBatch?.batch?.disputeStarts || [];
  return (
    draft.some((op) => String(op?.counterentity || '').toLowerCase() === target) ||
    sent.some((op) => String(op?.counterentity || '').toLowerCase() === target)
  );
}

function hasQueuedDisputeFinalize(state: EntityState, counterpartyEntityId: string): boolean {
  const target = String(counterpartyEntityId || '').toLowerCase();
  if (!target) return false;
  const draft = state.jBatchState?.batch?.disputeFinalizations || [];
  const sent = state.jBatchState?.sentBatch?.batch?.disputeFinalizations || [];
  return (
    draft.some((op) => String(op?.counterentity || '').toLowerCase() === target) ||
    sent.some((op) => String(op?.counterentity || '').toLowerCase() === target)
  );
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

  // Do not block dispute queueing when a previous batch is still in-flight.
  // New dispute ops are appended to CURRENT batch and can be broadcast after sentBatch finalizes.
  if (newState.jBatchState.sentBatch) {
    addMessage(
      newState,
      `ℹ️ disputeStart queued to current batch while sentBatch nonce=${newState.jBatchState.sentBatch.entityNonce} is still pending`,
    );
  }

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
  if (hasQueuedDisputeStart(newState, counterpartyEntityId)) {
    addMessage(
      newState,
      `ℹ️ disputeStart already queued for ${counterpartyEntityId.slice(-4)} (awaiting batch lifecycle)`,
    );
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
  const storedDisputeHash = account.counterpartyDisputeHash;

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

  const onChainNonce = Number(account.onChainSettlementNonce ?? 0);
  let currentJBlock = getRuntimeJurisdictionHeight(env, newState.lastFinalizedJHeight ?? 0);
  const defaultDisputeDelayBlocks = getRuntimeJurisdictionDefaultDisputeDelayBlocks(
    env,
    entityState.config.jurisdiction?.name,
    5,
  );

  console.log(`   signedNonce=${signedNonce} (source=${nonceSource}), onChainNonce=${onChainNonce}`);

  // On-chain requires nonce > stored nonce for disputeStart.
  // If stale, caller must execute manual reopen flow first.
  if (signedNonce <= onChainNonce) {
    const msg = `❌ Stale dispute proof nonce ${signedNonce} (on-chain=${onChainNonce}) - reopen required`;
    addMessage(newState, msg);
    console.warn(`⚠️ disputeStart blocked: ${msg}`);
    return { newState, outputs };
  }

  const depositoryAddress = resolveDepositoryAddress(entityState);
  if (depositoryAddress) {
    const exactDisputeHash =
      storedDisputeHash && storedDisputeHash.startsWith('0x')
        ? storedDisputeHash
        : createDisputeProofHashWithNonce(account, proofBodyHashToUse, depositoryAddress, signedNonce);
    const disputeHashSource =
      storedDisputeHash && storedDisputeHash.startsWith('0x') ? 'stored' : 'recomputed';
    const hankoDebug = await inspectHankoForHash(counterpartyDisputeHanko, exactDisputeHash);
    const matchingClaim = hankoDebug.claims.find(
      (claim) => String(claim.entityId).toLowerCase() === String(counterpartyEntityId).toLowerCase(),
    );
    console.log(
      `🧾 disputeStart.debug ${JSON.stringify({
        contractGuard: 'EntityProvider.sol:469 require(entityId == boardHash)',
        entityId: entityState.entityId,
        counterpartyEntityId,
        signedNonce,
        nonceSource,
        onChainNonce,
        proofHeaderNonce: account.proofHeader.nonce,
        storedCounterpartyDisputeProofNonce: account.counterpartyDisputeProofNonce,
        proofBodyHash: proofBodyHashToUse,
        disputeHashSource,
        disputeHash: exactDisputeHash,
        depositoryAddress,
        hankoBytes: Math.max(counterpartyDisputeHanko.length - 2, 0) / 2,
        recoveredAddresses: hankoDebug.recoveredAddresses,
        matchingClaim: matchingClaim
          ? {
              entityId: matchingClaim.entityId,
              threshold: matchingClaim.threshold,
              entityIndexes: matchingClaim.entityIndexes,
              weights: matchingClaim.weights,
              boardEntityIds: matchingClaim.boardEntityIds,
              reconstructedBoardHash: matchingClaim.reconstructedBoardHash,
              entityMatchesBoardHash:
                String(matchingClaim.entityId).toLowerCase() ===
                String(matchingClaim.reconstructedBoardHash).toLowerCase(),
            }
          : null,
      })}`,
    );
    const exactDisputeVerify = await verifyHankoForHash(
      counterpartyDisputeHanko,
      exactDisputeHash,
      counterpartyEntityId,
      env,
    );
    if (!exactDisputeVerify.valid) {
      const currentProofResult = buildAccountProofBody(account);
      const msg =
        `❌ Counterparty dispute proof invalid for current account snapshot; ` +
        `nonce=${signedNonce} onChain=${onChainNonce} source=${nonceSource}`;
      addMessage(newState, msg);
      console.error(
        `❌ disputeStart preflight failed: ${JSON.stringify({
          entityId: entityState.entityId,
          counterpartyEntityId,
          signedNonce,
          nonceSource,
          onChainNonce,
          proofHeaderNonce: account.proofHeader.nonce,
          counterpartyDisputeProofNonce: account.counterpartyDisputeProofNonce,
          storedProofBodyHash: proofBodyHashToUse,
          storedDisputeHash,
          currentProofBodyHash: currentProofResult.proofBodyHash,
          storedHashMatchesCurrent: proofBodyHashToUse === currentProofResult.proofBodyHash,
          pendingFrameHeight: account.pendingFrame?.height ?? null,
          currentFrameHeight: account.currentFrame?.height ?? null,
          currentHeight: account.currentHeight,
          lockCount: account.locks?.size ?? 0,
          swapOfferCount: account.swapOffers?.size ?? 0,
          knownDisputeProofHashes: Object.keys(account.disputeProofNoncesByHash ?? {}),
          disputeHashSource,
          disputeHash: exactDisputeHash,
          depositoryAddress,
          recoveredEntityId: exactDisputeVerify.entityId,
          hankoBytes: Math.max(counterpartyDisputeHanko.length - 2, 0) / 2,
        })}`,
      );
      return { newState, outputs };
    }
  } else {
    addMessage(newState, `❌ disputeStart blocked: missing jurisdiction depository address`);
    return { newState, outputs };
  }

  // The signed nonce is passed directly to the contract. Solidity requires:
  //   nonce > _accounts[acct_key].nonce  (Account.sol:354)
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

  // Freeze account immediately once disputeStart is queued.
  // This is unilateral safety state on the local entity: no further business
  // frames should progress on this account while dispute is in-flight.
  account.status = 'disputed';
  const beforeMempool = account.mempool?.length || 0;
  if (beforeMempool > 0) {
    account.mempool = (account.mempool || []).filter(
      (tx) => tx.type === 'j_event_claim' || tx.type === 'reopen_disputed',
    );
    const dropped = beforeMempool - account.mempool.length;
    if (dropped > 0) {
      console.warn(
        `⚠️ disputeStart: dropped ${dropped} pending account tx(s) for ${counterpartyEntityId.slice(-4)} while freezing`,
      );
    }
  }
  if (account.pendingFrame || account.pendingAccountInput) {
    console.warn(
      `⚠️ disputeStart: clearing pending frame/input for ${counterpartyEntityId.slice(-4)} while freezing account`,
    );
  }
  delete account.pendingFrame;
  delete account.pendingAccountInput;
  delete account.clonedForValidation;
  account.rollbackCount = 0;
  delete account.lastRollbackFrameHash;
  // Local placeholder for UX continuity: account stays visible as "active dispute"
  // immediately after queueing disputeStart, before on-chain DisputeStarted event arrives.
  // On-chain event will overwrite this with authoritative timeout/nonce data.
  if (!account.activeDispute) {
    account.activeDispute = {
      startedByLeft: account.leftEntity === entityState.entityId,
      initialProofbodyHash: proofBodyHashToUse,
      initialNonce: signedNonce,
      disputeTimeout: currentJBlock + defaultDisputeDelayBlocks,
      onChainNonce,
      initialArguments,
      finalizeQueued: false,
    };
  }

  console.log(`✅ disputeStart: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   proofBodyHash: ${proofBodyHashToUse.slice(0, 18)}...`);
  console.log(`   hankoLen: ${counterpartyDisputeHanko.length}, signedNonce: ${signedNonce}`);

  // NOTE: activeDispute will be set when DisputeStarted event arrives from J-machine
  // Event handler will query on-chain state and populate:
  // - startedByLeft, disputeTimeout, onChainNonce

  addMessage(
    newState,
    `⚔️ Dispute started vs ${counterpartyEntityId.slice(-4)} ${description ? `(${description})` : ''} - account frozen, use jBroadcast to commit`,
  );

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

  // Do not block dispute finalize queueing when previous batch is still pending.
  if (newState.jBatchState.sentBatch) {
    addMessage(
      newState,
      `ℹ️ disputeFinalize queued to current batch while sentBatch nonce=${newState.jBatchState.sentBatch.entityNonce} is still pending`,
    );
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
  if (account.activeDispute.finalizeQueued) {
    addMessage(
      newState,
      `ℹ️ disputeFinalize already queued for ${counterpartyEntityId.slice(-4)} (awaiting batch lifecycle)`,
    );
    return { newState, outputs };
  }
  if (hasQueuedDisputeFinalize(newState, counterpartyEntityId)) {
    account.activeDispute.finalizeQueued = true;
    addMessage(
      newState,
      `ℹ️ disputeFinalize already present in batch lifecycle for ${counterpartyEntityId.slice(-4)}`,
    );
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

  const storedProofBodyRaw = account.activeDispute.initialProofbodyHash
    ? account.disputeProofBodiesByHash?.[account.activeDispute.initialProofbodyHash]
    : undefined;
  const currentProofBody = canonicalizeProofBodyStruct(
    currentProofResult.proofBodyStruct,
    entityState.entityId,
    counterpartyEntityId,
    'current',
  );
  const storedProofBody = storedProofBodyRaw
    ? canonicalizeProofBodyStruct(
        storedProofBodyRaw,
        entityState.entityId,
        counterpartyEntityId,
        'stored',
      )
    : null;
  const shouldUseStoredProof = storedProofBody !== null;
  if (currentProofResult.proofBodyHash !== account.activeDispute.initialProofbodyHash) {
    console.warn(`⚠️ disputeFinalize: current proofBodyHash != initial (current=${currentProofResult.proofBodyHash.slice(0, 10)}..., initial=${account.activeDispute.initialProofbodyHash.slice(0, 10)}...)`);
    if (!storedProofBody) {
      throw new Error('disputeFinalize: missing stored proofBody for unilateral finalize');
    }
  }

  const finalProofbody = shouldUseStoredProof
    ? storedProofBody
    : currentProofBody;

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

  // Protocol rule (matches Depository.sol):
  // - dispute starter must wait until timeout for unilateral finalize
  // - counterparty may finalize immediately (same-proof path) without waiting
  const callerIsStarter = callerIsLeft === account.activeDispute.startedByLeft;
  if (callerIsStarter) {
    const currentJBlock = getRuntimeJurisdictionHeight(env, newState.lastFinalizedJHeight ?? 0);
    if (currentJBlock < account.activeDispute.disputeTimeout) {
      addMessage(
        newState,
        `❌ disputeFinalize too early for starter: currentBlock=${currentJBlock}, timeout=${account.activeDispute.disputeTimeout}`,
      );
      console.warn(
        `⚠️ disputeFinalize blocked (starter before timeout): currentBlock=${currentJBlock}, timeout=${account.activeDispute.disputeTimeout}`,
      );
      return { newState, outputs };
    }
  }

  // Add to jBatch
  newState.jBatchState.batch.disputeFinalizations.push(finalProof);
  account.activeDispute.finalizeQueued = true;

  console.log(`✅ disputeFinalize: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Mode: unilateral`);

  addMessage(newState, `⚖️ Dispute finalized vs ${counterpartyEntityId.slice(-4)} ${description ? `(${description})` : ''} - use jBroadcast to commit`);

  return { newState, outputs };
}
import { swapKey } from '../../swap-execution';
