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
import type { EntityState, EntityTx, EntityInput, Env, AccountMachine, SwapOffer } from '../../types';
import type { ProofBodyStruct } from '../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { isUsableContractAddress } from '../../contract-address';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { initJBatch, batchAddRevealSecret, J_BATCH_CONTRACT_LIMITS, getBatchSize } from '../../j-batch';
import { getDeltaTransformerAddress } from '../../proof-builder';
import { getRuntimeJurisdictionDefaultDisputeDelayBlocks, getRuntimeJurisdictionHeight } from '../../j-height';
import {
  buildAccountProofBody,
  createDisputeProofHashWithNonce,
} from '../../proof-builder';
import { inspectHankoForHash, verifyHankoForHash } from '../../hanko/signing';
import { decodeHashLadderBinary } from '../../hashladder';
import {
  buildDisputeArgumentsForSnapshot,
  requireDisputeArgumentSnapshot,
  type DisputeArgumentSide,
} from '../../dispute-arguments';
import { removeBookOrderById } from '../../orderbook/cross-j';
import { swapKey } from '../../swap-keys';
import { crossJurisdictionBookOwnerRef } from '../../cross-jurisdiction-orderbook';

const isProofBodyStruct = (value: unknown): value is ProofBodyStruct => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate['offdeltas']) &&
    Array.isArray(candidate['tokenIds']) &&
    Array.isArray(candidate['transformers'])
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
  if (!isUsableContractAddress(value)) {
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

function hasNonZeroPullArgument(starterInitialArguments?: string): boolean {
  const raw = String(starterInitialArguments || '0x');
  if (!raw || raw === '0x') return false;
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  let argArray: string[];
  try {
    [argArray] = abiCoder.decode(['bytes[]'], raw) as unknown as [string[]];
  } catch {
    return false;
  }
  for (const arg of argArray) {
    if (!arg || arg === '0x') continue;
    try {
      const [decoded] = abiCoder.decode(
        ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
        arg,
      ) as unknown as [{ pulls?: Array<string> }];
      for (const binary of decoded.pulls || []) {
        try {
          if (decodeHashLadderBinary(binary).fillRatio > 0) return true;
        } catch {
          // Malformed pull evidence proves nothing. This mirrors the Solidity
          // no-op rule and avoids treating attacker garbage as target safety.
        }
      }
    } catch {
      // Ignore non-DeltaTransformer argument payloads.
    }
  }
  return false;
}

function targetCrossPullRiskAmount(state: EntityState, counterpartyEntityId: string, account: AccountMachine): bigint {
  const self = String(state.entityId || '').toLowerCase();
  const counterparty = String(counterpartyEntityId || '').toLowerCase();
  let total = 0n;
  for (const route of state.crossJurisdictionSwaps?.values() ?? []) {
    if (
      String(route.target.counterpartyEntityId || '').toLowerCase() === self &&
      String(route.target.entityId || '').toLowerCase() === counterparty &&
      route.targetPull?.pullId &&
      account.pulls?.has(route.targetPull.pullId)
    ) {
      total += BigInt(route.target.amount);
    }
  }
  return total;
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
  if (isUsableContractAddress(address)) return address;
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

const firstSignerForEntity = (env: Env, entityId: string): string | null => {
  for (const replica of env.eReplicas.values()) {
    if (String(replica.state.entityId).toLowerCase() !== String(entityId).toLowerCase()) continue;
    return replica.state.config.validators[0] ?? null;
  }
  return null;
};

const removeOrderbookRowForDispute = (
  env: Env,
  state: EntityState,
  outputs: EntityInput[],
  counterpartyEntityId: string,
  offerId: string,
  offer: SwapOffer,
): { localRemoved: boolean; remoteQueued: boolean } => {
  // Starting a dispute freezes account consensus. Any resting order from that
  // account must stop being matchable before the dispute batch is broadcast:
  // post-dispute fills would target an account state that can no longer ACK.
  //
  // Same-j rows live in this entity's book, so they are removed directly.
  // Cross-j rows may live in the deterministic book-owner entity; in that case
  // we queue an explicit removal. Do not "rehydrate" or resize cross-j rows
  // during dispute: either the row is fully matchable before dispute, or it is
  // removed forever because the underlying account is no longer live.
  if (!offer.crossJurisdiction) {
    return {
      localRemoved: removeBookOrderById(env, state, swapKey(counterpartyEntityId, offerId)),
      remoteQueued: false,
    };
  }

  const route = offer.crossJurisdiction;
  const bookOwnerEntityId = crossJurisdictionBookOwnerRef(route);
  const sourceEntityId = route.source.entityId;
  if (bookOwnerEntityId === String(state.entityId).toLowerCase()) {
    return {
      localRemoved: removeBookOrderById(env, state, swapKey(sourceEntityId, offerId)),
      remoteQueued: false,
    };
  }

  const signerId = firstSignerForEntity(env, bookOwnerEntityId);
  if (!signerId) {
    throw new Error(
      `DISPUTE_CROSS_J_BOOK_OWNER_MISSING: order=${offerId} owner=${bookOwnerEntityId} source=${sourceEntityId}`,
    );
  }
  outputs.push({
    entityId: bookOwnerEntityId,
    signerId,
    entityTxs: [{
      type: 'removeCrossJurisdictionBookOrder',
      data: {
        orderId: offerId,
        sourceEntityId,
        route,
        reason: 'account_dispute_start',
      },
    }],
  });
  return { localRemoved: false, remoteQueued: true };
};

const removeDisputedAccountOrdersFromBook = (
  env: Env,
  state: EntityState,
  outputs: EntityInput[],
  counterpartyEntityId: string,
  account: AccountMachine,
): void => {
  let localRemoved = 0;
  let remoteQueued = 0;
  for (const [offerId, offer] of account.swapOffers ?? new Map<string, SwapOffer>()) {
    const result = removeOrderbookRowForDispute(env, state, outputs, counterpartyEntityId, offerId, offer);
    if (result.localRemoved) localRemoved++;
    if (result.remoteQueued) remoteQueued++;
  }
  if (localRemoved > 0 || remoteQueued > 0) {
    addMessage(
      state,
      `⚔️ Dispute removed ${localRemoved} local orderbook row(s), queued ${remoteQueued} remote row removal(s)`,
    );
  }
};

/**
 * Handle disputeStart - Entity initiates dispute with signed proof
 */
export async function handleDisputeStart(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'disputeStart' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const {
    counterpartyEntityId,
    description,
    starterInitialArguments: overrideStarterInitialArguments,
    allowUnsafeCrossJTargetDispute,
    acceptedCrossJTargetLossAmount,
  } = entityTx.data;
  const overrideInitialArguments = overrideStarterInitialArguments;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  if (entityTx.data.starterIncrementedArguments !== undefined) {
    throw new Error('DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED');
  }

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

  removeDisputedAccountOrdersFromBook(env, newState, outputs, counterpartyEntityId, account);

  const targetCrossRiskAmount = targetCrossPullRiskAmount(newState, counterpartyEntityId, account);
  const explicitStarterPullArgs = hasNonZeroPullArgument(overrideInitialArguments);
  const snapshotCanSupplyStarterArgs = Boolean(
    account.counterpartyDisputeProofBodyHash &&
    account.disputeArgumentSnapshotsByHash?.[account.counterpartyDisputeProofBodyHash],
  );
  if (targetCrossRiskAmount > 0n && !explicitStarterPullArgs && !snapshotCanSupplyStarterArgs) {
    const acceptedLoss = BigInt(acceptedCrossJTargetLossAmount ?? 0n);
    if (!allowUnsafeCrossJTargetDispute || acceptedLoss < targetCrossRiskAmount) {
      addMessage(
        newState,
        `❌ Cross-j target dispute blocked: source pull arguments missing; accept possible loss up to ${targetCrossRiskAmount} or start source dispute first`,
      );
      return { newState, outputs };
    }
    addMessage(
      newState,
      `⚠️ Unsafe cross-j target dispute accepted: pull arguments missing, possible loss up to ${targetCrossRiskAmount}`,
    );
  }

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
  requireDisputeArgumentSnapshot(account, proofBodyHashToUse, 'disputeStart.initial');
  const starterIsLeft = account.leftEntity === newState.entityId;
  const starterSide: DisputeArgumentSide = starterIsLeft ? 'left' : 'right';
  const initialSnapshotArguments = buildDisputeArgumentsForSnapshot(
    account,
    newState,
    counterpartyEntityId,
    proofBodyHashToUse,
    { secretsSide: starterSide },
  );
  const starterInitialArguments =
    overrideInitialArguments && overrideInitialArguments !== '0x'
      ? overrideInitialArguments
      : (starterIsLeft ? initialSnapshotArguments.leftArguments : initialSnapshotArguments.rightArguments);
  if (targetCrossRiskAmount > 0n && !hasNonZeroPullArgument(starterInitialArguments)) {
    const acceptedLoss = BigInt(acceptedCrossJTargetLossAmount ?? 0n);
    if (!allowUnsafeCrossJTargetDispute || acceptedLoss < targetCrossRiskAmount) {
      addMessage(
        newState,
        `❌ Cross-j target dispute blocked: source pull arguments missing; accept possible loss up to ${targetCrossRiskAmount} or start source dispute first`,
      );
      return { newState, outputs };
    }
    addMessage(
      newState,
      `⚠️ Unsafe cross-j target dispute accepted: pull arguments missing, possible loss up to ${targetCrossRiskAmount}`,
    );
  }
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

  // Single-round dispute safety:
  // In normal sequential account consensus there is only one next signed proof:
  // nonce N+1. If we see multiple local newer snapshots, that is not a protocol
  // feature to encode into Solidity; it is corrupted local/recovered state.
  // Fail fast instead of guessing which positional swap/pull arguments belong
  // to which proof body.
  const localCounterCandidates = Object.values(account.disputeArgumentSnapshotsByHash ?? {})
    .filter((snapshot) => snapshot.side === starterSide && snapshot.nonce > signedNonce)
    .sort((left, right) => left.nonce - right.nonce);
  if (localCounterCandidates.length > 1) {
    throw new Error(
      `DISPUTE_START_IMPOSSIBLE_MULTIPLE_INCREMENTED_SNAPSHOTS:${counterpartyEntityId}:${localCounterCandidates.map((s) => `${s.nonce}:${s.proofbodyHash}`).join(',')}`,
    );
  }
  const starterIncrementedArguments = localCounterCandidates.length === 1
    ? (() => {
        const candidate = localCounterCandidates[0]!;
        const args = buildDisputeArgumentsForSnapshot(
          account,
          newState,
          counterpartyEntityId,
          candidate.proofbodyHash,
          { secretsSide: starterSide },
        );
        return starterIsLeft ? args.leftArguments : args.rightArguments;
      })()
    : '0x';

  const depositoryAddress = resolveDepositoryAddress(entityState);
  if (depositoryAddress) {
    const exactDisputeHash = createDisputeProofHashWithNonce(
      account,
      proofBodyHashToUse,
      depositoryAddress,
      signedNonce,
    );
    if (
      storedDisputeHash &&
      storedDisputeHash.startsWith('0x') &&
      storedDisputeHash.toLowerCase() !== exactDisputeHash.toLowerCase()
    ) {
      throw new Error(
        `DISPUTE_STORED_HASH_MISMATCH:${counterpartyEntityId}:${storedDisputeHash}:${exactDisputeHash}`,
      );
    }
    const disputeHashSource = storedDisputeHash ? 'stored+recomputed' : 'recomputed';
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
  if (newState.jBatchState.batch.disputeStarts.length >= J_BATCH_CONTRACT_LIMITS.maxDisputeStarts) {
    throw new Error(`J_BATCH_LIMIT_EXCEEDED: disputeStarts ${newState.jBatchState.batch.disputeStarts.length + 1}/${J_BATCH_CONTRACT_LIMITS.maxDisputeStarts}`);
  }
  if (getBatchSize(newState.jBatchState.batch) + 1 > J_BATCH_CONTRACT_LIMITS.maxTotalOps) {
    throw new Error(`J_BATCH_LIMIT_EXCEEDED: disputeStart would exceed total ops ${getBatchSize(newState.jBatchState.batch) + 1}/${J_BATCH_CONTRACT_LIMITS.maxTotalOps}`);
  }
  newState.jBatchState.batch.disputeStarts.push({
    counterentity: counterpartyEntityId,
    nonce: signedNonce,
    proofbodyHash: proofBodyHashToUse,
    sig: counterpartyDisputeHanko,
    starterInitialArguments,
    starterIncrementedArguments,
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
      starterInitialArguments,
      starterIncrementedArguments,
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

  // Build current proof only to compare against the stored dispute body.
  const currentProofResult = buildAccountProofBody(account);
  const counterProofBodyHash = account.counterpartyDisputeProofBodyHash;
  const counterProofNonce = account.counterpartyDisputeProofNonce;
  const counterProofHanko = account.counterpartyDisputeProofHanko;
  const counterProofBodyRaw = counterProofBodyHash
    ? account.disputeProofBodiesByHash?.[counterProofBodyHash]
    : undefined;
  const hasCounterProof =
    Boolean(counterProofHanko && counterProofHanko !== '0x') &&
    counterProofNonce !== undefined &&
    counterProofNonce > account.activeDispute.initialNonce &&
    Boolean(counterProofBodyHash) &&
    isProofBodyStruct(counterProofBodyRaw);

  const finalNonce = hasCounterProof
    ? counterProofNonce!
    : account.activeDispute.initialNonce;
  const finalNonceSource = hasCounterProof ? 'counterpartyDisputeProof' : 'initialNonce (unilateral)';

  // ASSERT: finalNonce must be positive
  if (finalNonce <= 0) {
    addMessage(newState, `❌ Invalid dispute finalNonce=${finalNonce} — must be > 0`);
    console.error(`❌ disputeFinalize: finalNonce=${finalNonce} is invalid (source=${finalNonceSource})`);
    return { newState, outputs };
  }
  const finalizeSig = hasCounterProof ? counterProofHanko! : '0x';

  const callerIsLeft = account.leftEntity === newState.entityId;
  const callerSide: DisputeArgumentSide = callerIsLeft ? 'left' : 'right';

  const storedProofBodyRaw = account.activeDispute.initialProofbodyHash
    ? account.disputeProofBodiesByHash?.[account.activeDispute.initialProofbodyHash]
    : undefined;
  const currentProofBody = canonicalizeProofBodyStruct(
    currentProofResult.proofBodyStruct,
    entityState.entityId,
    counterpartyEntityId,
    'current',
  );
  const storedProofBody = isProofBodyStruct(storedProofBodyRaw)
    ? canonicalizeProofBodyStruct(
        storedProofBodyRaw,
        entityState.entityId,
        counterpartyEntityId,
        'stored',
      )
    : null;
  const counterProofBody = hasCounterProof
    ? canonicalizeProofBodyStruct(
        counterProofBodyRaw as ProofBodyStruct,
        entityState.entityId,
        counterpartyEntityId,
        'counter',
      )
    : null;
  const shouldUseCounterProof = counterProofBody !== null && counterProofBodyHash !== undefined;
  const shouldUseStoredProof = !shouldUseCounterProof && storedProofBody !== null;

  if (!shouldUseCounterProof && currentProofResult.proofBodyHash !== account.activeDispute.initialProofbodyHash) {
    console.warn(`⚠️ disputeFinalize: current proofBodyHash != initial (current=${currentProofResult.proofBodyHash.slice(0, 10)}..., initial=${account.activeDispute.initialProofbodyHash.slice(0, 10)}...)`);
    if (!storedProofBody) {
      throw new Error('disputeFinalize: missing stored proofBody for unilateral finalize');
    }
  }

  if (shouldUseCounterProof && account.counterpartyDisputeHash) {
    const depositoryAddress = resolveDepositoryAddress(entityState);
    if (!depositoryAddress) {
      throw new Error('DISPUTE_COUNTER_FINALIZE_DEPOSITORY_MISSING');
    }
    const expectedHash = createDisputeProofHashWithNonce(
      account,
      counterProofBodyHash!,
      depositoryAddress,
      finalNonce,
    );
    if (account.counterpartyDisputeHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error(
        `DISPUTE_COUNTER_FINALIZE_HASH_MISMATCH:${counterpartyEntityId}:${account.counterpartyDisputeHash}:${expectedHash}`,
      );
    }
  }

  const finalProofbody = shouldUseCounterProof
    ? counterProofBody!
    : shouldUseStoredProof
      ? storedProofBody
      : currentProofBody;
  const finalProofbodyHash = shouldUseCounterProof
    ? counterProofBodyHash!
    : account.activeDispute.initialProofbodyHash;

  // Finalization arguments are built for the exact proof body being revealed,
  // not from whichever live account maps exist now. In counter-dispute mode the
  // starter side is immutable and must equal the starterIncrementedArguments
  // committed by DisputeStartedV2; the finalizer only supplies its own side.
  // Counterexample: if the starter opened with proof N and had already sent N+1
  // with 75% fill progress, using starterInitialArguments for the counter proof
  // would reveal only the N-side evidence and underclaim the committed N+1 state.
  const builtArguments = buildDisputeArgumentsForSnapshot(
    account,
    newState,
    counterpartyEntityId,
    finalProofbodyHash,
    { secretsSide: callerSide },
  );
  const starterArgumentsForFinalProof = shouldUseCounterProof
    ? account.activeDispute.starterIncrementedArguments
    : account.activeDispute.starterInitialArguments;
  const leftArguments = account.activeDispute.startedByLeft
    ? starterArgumentsForFinalProof
    : builtArguments.leftArguments;
  const rightArguments = account.activeDispute.startedByLeft
    ? builtArguments.rightArguments
    : starterArgumentsForFinalProof;

  const finalProof = {
    counterentity: counterpartyEntityId,
    initialNonce: account.activeDispute.initialNonce,  // Nonce when dispute was started
    finalNonce,
    initialProofbodyHash: account.activeDispute.initialProofbodyHash,  // From disputeStart (commit)
    finalProofbody,  // REVEAL
    leftArguments,
    rightArguments,
    starterInitialArguments: account.activeDispute.starterInitialArguments,
    starterIncrementedArguments: account.activeDispute.starterIncrementedArguments,
    sig: finalizeSig,
    startedByLeft: account.activeDispute.startedByLeft,  // From on-chain
    disputeUntilBlock: account.activeDispute.disputeTimeout,  // From on-chain
    cooperative: false,
  };

  // Optional fallback: on-chain HTLC registry (Sprites-style)
  if (entityTx.data.useOnchainRegistry) {
    const htlcSecrets = collectHtlcSecrets(newState, counterpartyEntityId);
    const transformerAddress = getDeltaTransformerAddress();
    if (!isUsableContractAddress(transformerAddress)) {
      throw new Error('DISPUTE_FINALIZE_MISSING_DELTA_TRANSFORMER_ADDRESS');
    }
    for (const secret of htlcSecrets) {
      batchAddRevealSecret(newState.jBatchState, transformerAddress, secret);
    }
  }

  console.log(`   Mode: ${shouldUseCounterProof ? 'counter' : 'unilateral'}, timeout=${account.activeDispute.disputeTimeout}`);
  console.log(`   initialNonce=${finalProof.initialNonce}, finalNonce=${finalProof.finalNonce} (source=${finalNonceSource})`);

  // Protocol rule (matches Depository.sol):
  // - dispute starter must wait until timeout for unilateral finalize
  // - counterparty may finalize immediately (same-proof path) without waiting
  const callerIsStarter = callerIsLeft === account.activeDispute.startedByLeft;
  if (!shouldUseCounterProof && callerIsStarter) {
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
  if (newState.jBatchState.batch.disputeFinalizations.length >= J_BATCH_CONTRACT_LIMITS.maxDisputeFinalizations) {
    throw new Error(`J_BATCH_LIMIT_EXCEEDED: disputeFinalizations ${newState.jBatchState.batch.disputeFinalizations.length + 1}/${J_BATCH_CONTRACT_LIMITS.maxDisputeFinalizations}`);
  }
  if (getBatchSize(newState.jBatchState.batch) + 1 > J_BATCH_CONTRACT_LIMITS.maxTotalOps) {
    throw new Error(`J_BATCH_LIMIT_EXCEEDED: disputeFinalize would exceed total ops ${getBatchSize(newState.jBatchState.batch) + 1}/${J_BATCH_CONTRACT_LIMITS.maxTotalOps}`);
  }
  newState.jBatchState.batch.disputeFinalizations.push(finalProof);
  account.activeDispute.finalizeQueued = true;

  console.log(`✅ disputeFinalize: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Mode: ${shouldUseCounterProof ? 'counter' : 'unilateral'}`);

  addMessage(newState, `⚖️ Dispute finalized vs ${counterpartyEntityId.slice(-4)} ${description ? `(${description})` : ''} - use jBroadcast to commit`);

  return { newState, outputs };
}
