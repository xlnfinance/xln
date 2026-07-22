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

import type {
  EntityState,
  EntityTx,
  EntityInput,
  Env,
  AccountMachine,
  SwapOffer,
  RuntimeOverlayRecord,
} from '../../../types';
import type { ProofBodyStruct } from '../../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { isUsableContractAddress } from '../../../jurisdiction/contract-address';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import {
  initJBatch,
  batchAddRevealSecret,
  J_BATCH_CONTRACT_LIMITS,
  getBatchSize,
  encodeJBatch,
  assertDisputeArgumentsWithinContractLimits,
  assertDisputeProofBodyWithinContractLimits,
  sanitizeOptionalDisputeStarterArgumentPair,
  type OptionalDisputeArgumentWarning,
} from '../../../jurisdiction/batch';
import { getEntityCertifiedJurisdictionHeight } from '../../../jurisdiction/height';
import {
  createDisputeProofHashWithNonce,
  hashProofBodyStruct,
  type DepositoryHankoDomain,
} from '../../../protocol/dispute/proof-builder';
import {
  buildAccountProofBodyFromEnv,
  requireAccountDeltaTransformerAddress,
} from '../../../account/consensus/helpers';
import { inspectHankoForHash, verifyHankoForHash } from '../../../hanko/signing';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../jurisdiction/board-registry';
import {
  buildDisputeArgumentsForSnapshot,
  collectKnownDisputeSecretsForSnapshot,
  requireDisputeArgumentSnapshot,
  type DisputeArgumentSide,
} from '../../../protocol/dispute/arguments';
import { removeBookOrderById } from '../../../orderbook/cross-j';
import { swapKey } from '../../../orderbook/swap-keys';
import { crossJurisdictionBookOwnerRef } from '../../../extensions/cross-j/orderbook';
import { isCrossJurisdictionTerminalStatus } from '../../../extensions/cross-j';
import { createStructuredLogger, shouldLogFullPayloads, shortHash, shortId } from '../../../infra/logger';
import { crossJurisdictionRouteSignerHint } from '../cross-j-outputs';
import {
  freezeAccountForDispute,
  isDisputeStartedByLeft,
} from '../../../account/consensus/dispute-policy';

const disputeLog = createStructuredLogger('entity.dispute');

const warnDisputeUnlessQuiet = (
  env: Env,
  message: string,
  fields: Record<string, unknown>,
): void => {
  if (env.quietRuntimeLogs === true) return;
  disputeLog.warn(message, fields);
};

const reportOptionalArgumentWarnings = (
  env: Env,
  counterpartyEntityId: string,
  warnings: readonly OptionalDisputeArgumentWarning[],
): void => {
  for (const warning of warnings) {
    warnDisputeUnlessQuiet(env, 'arguments.sanitized', {
      counterparty: shortId(counterpartyEntityId),
      ...warning,
    });
  }
};

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

export const canonicalizeProofBodyStruct = (
  value: ProofBodyStruct,
  entityId: string,
  counterpartyEntityId: string,
  source: string,
): ProofBodyStruct => {
  const proofBody = requireProofBodyStruct(value, entityId, counterpartyEntityId, source);
  return {
    watchSeed: requireBytesLike(proofBody.watchSeed, `${source}.watchSeed`),
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

function resolveDepositoryHankoDomain(entityState: EntityState): DepositoryHankoDomain | null {
  const jurisdiction = entityState.config.jurisdiction;
  const address = jurisdiction?.depositoryAddress || '';
  if (!isUsableContractAddress(address)) return null;
  const chainId = Number(jurisdiction?.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`DISPUTE_HANKO_CHAIN_ID_INVALID:${String(jurisdiction?.chainId)}`);
  }
  return { chainId, depositoryAddress: address };
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

const removeOrderbookRowForDispute = (
  state: EntityState,
  outputs: EntityInput[],
  counterpartyEntityId: string,
  offerId: string,
  offer: SwapOffer,
  storageChanges: RuntimeOverlayRecord[],
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
      localRemoved: removeBookOrderById(state, swapKey(counterpartyEntityId, offerId), storageChanges),
      remoteQueued: false,
    };
  }

  const route = offer.crossJurisdiction;
  const bookOwnerEntityId = crossJurisdictionBookOwnerRef(route);
  const sourceEntityId = route.source.entityId;
  if (bookOwnerEntityId === String(state.entityId).toLowerCase()) {
    return {
      localRemoved: removeBookOrderById(state, swapKey(sourceEntityId, offerId), storageChanges),
      remoteQueued: false,
    };
  }

  const signerId = crossJurisdictionRouteSignerHint(route, bookOwnerEntityId);
  if (!signerId) {
    throw new Error(
      `DISPUTE_CROSS_J_BOOK_OWNER_SIGNER_MISSING: order=${offerId} owner=${bookOwnerEntityId} source=${sourceEntityId}`,
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
        sourceAccountId: counterpartyEntityId,
        route,
        reason: 'account_dispute_prepare',
      },
    }],
  });
  return { localRemoved: false, remoteQueued: true };
};

const removeDisputedAccountOrdersFromBook = (
  state: EntityState,
  outputs: EntityInput[],
  counterpartyEntityId: string,
  account: AccountMachine,
  storageChanges: RuntimeOverlayRecord[],
): { localRemoved: number; remoteQueued: number; remoteOrderIds: string[] } => {
  let localRemoved = 0;
  let remoteQueued = 0;
  const remoteOrderIds: string[] = [];
  for (const [offerId, offer] of account.swapOffers ?? new Map<string, SwapOffer>()) {
    const result = removeOrderbookRowForDispute(
      state,
      outputs,
      counterpartyEntityId,
      offerId,
      offer,
      storageChanges,
    );
    if (result.localRemoved) localRemoved++;
    if (result.remoteQueued) {
      remoteQueued++;
      remoteOrderIds.push(offerId);
    }
  }
  if (localRemoved > 0 || remoteQueued > 0) {
    addMessage(
      state,
      `⚔️ Dispute removed ${localRemoved} local orderbook row(s), queued ${remoteQueued} remote row removal(s)`,
    );
  }
  return { localRemoved, remoteQueued, remoteOrderIds };
};

const collectDisputeEvidenceReadinessIssues = (
  account: AccountMachine,
  now: number,
): string[] => {
  const issues: string[] = [];
  const readyAfter = Number(account.disputePrepare?.readyAfter ?? 0);
  if (readyAfter > now) issues.push(`cooldown:${readyAfter - now}ms`);
  const pendingOrderbookRemovals = account.disputePrepare?.pendingOrderbookRemovalIds?.length ?? 0;
  if (pendingOrderbookRemovals > 0) issues.push(`orderbookRemovals:${pendingOrderbookRemovals}`);
  return issues;
};

const markAccountDisputePreparing = (
  state: EntityState,
  account: AccountMachine,
  description: string,
  minCooldownMs: number,
  pendingOrderbookRemovalIds: readonly string[],
  startIntent: NonNullable<AccountMachine['disputePrepare']>['startIntent'],
): void => {
  const startedAt = Number(state.timestamp ?? 0);
  account.status = 'dispute_preparing';
  account.disputePrepare = {
    startedAt,
    readyAfter: startedAt + Math.max(0, Math.floor(minCooldownMs)),
    reason: description || 'prepare-dispute',
    ...(pendingOrderbookRemovalIds.length > 0
      ? { pendingOrderbookRemovalIds: [...pendingOrderbookRemovalIds].sort() }
      : {}),
    ...(startIntent ? { startIntent } : {}),
  };

  // Freeze optimistic account traffic. Optional resolve evidence remains in
  // the Account mempool, but ordinary bilateral proposals must not keep
  // changing the signed ProofBody while preparing an adversarial on-chain path.
  freezeAccountForDispute(account, true);
};

/**
 * Handle prepareDispute - local cleanup/cooldown before any on-chain dispute op.
 *
 * This is intentionally not a contract action. It removes matchable orders and
 * stops normal bilateral account traffic so transformer arguments can settle
 * before disputeStart/counter-finalize calldata is committed. The jurisdiction
 * only sees the later disputeStart/disputeFinalize, once readiness checks pass.
 */
export async function handlePrepareDispute(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'prepareDispute' }>,
  env: Env,
  storageChanges: RuntimeOverlayRecord[] = [],
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { counterpartyEntityId, description = 'prepare-dispute', minCooldownMs = 0 } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    addMessage(newState, `❌ No account with ${counterpartyEntityId.slice(-4)} - cannot prepare dispute`);
    return { newState, outputs };
  }
  if (account.activeDispute || (account.status ?? 'active') === 'disputed') {
    addMessage(newState, `ℹ️ Dispute already active/queued for ${counterpartyEntityId.slice(-4)}`);
    return { newState, outputs };
  }
  if ((account.status ?? 'active') === 'dispute_preparing') {
    const issues = collectDisputeEvidenceReadinessIssues(account, Number(newState.timestamp ?? 0));
    if (issues.length === 0) {
      return draftPreparedDisputeStartIfReady(newState, counterpartyEntityId, env, storageChanges);
    }
    addMessage(
      newState,
      issues.length > 0
        ? `⏳ Dispute preparation still pending for ${counterpartyEntityId.slice(-4)}: ${issues.join('; ')}`
        : `⏳ Dispute already prepared for ${counterpartyEntityId.slice(-4)}; queue disputeStart when ready`,
    );
    return { newState, outputs };
  }

  const removal = removeDisputedAccountOrdersFromBook(
    newState,
    outputs,
    counterpartyEntityId,
    account,
    storageChanges,
  );
  markAccountDisputePreparing(
    newState,
    account,
    description,
    minCooldownMs,
    removal.remoteOrderIds,
    {
      description,
      ...(entityTx.data.crossJurisdictionRouteId !== undefined
        ? { crossJurisdictionRouteId: entityTx.data.crossJurisdictionRouteId }
        : {}),
      ...(entityTx.data.starterInitialArguments !== undefined
        ? { starterInitialArguments: entityTx.data.starterInitialArguments }
        : {}),
      ...(entityTx.data.allowUnsafeCrossJTargetDispute === true
        ? { allowUnsafeCrossJTargetDispute: true }
        : {}),
      ...(entityTx.data.acceptedCrossJTargetLossAmount !== undefined
        ? { acceptedCrossJTargetLossAmount: entityTx.data.acceptedCrossJTargetLossAmount }
        : {}),
    },
  );

  const issues = collectDisputeEvidenceReadinessIssues(account, Number(newState.timestamp ?? 0));
  addMessage(
    newState,
    issues.length > 0
      ? `⏳ Dispute prepared vs ${counterpartyEntityId.slice(-4)}; waiting for stable evidence: ${issues.join('; ')}`
      : `⏳ Dispute prepared vs ${counterpartyEntityId.slice(-4)}; evidence currently stable, queue disputeStart when ready`,
  );
  if (issues.length > 0) return { newState, outputs };
  const drafted = await draftPreparedDisputeStartIfReady(
    newState,
    counterpartyEntityId,
    env,
    storageChanges,
  );
  return { newState: drafted.newState, outputs: [...outputs, ...drafted.outputs] };
}

export async function draftPreparedDisputeStartIfReady(
  entityState: EntityState,
  counterpartyEntityId: string,
  env: Env,
  storageChanges: RuntimeOverlayRecord[] = [],
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const account = entityState.accounts.get(counterpartyEntityId);
  if (!account || (account.status ?? 'active') !== 'dispute_preparing') {
    return { newState: entityState, outputs: [] };
  }
  if (collectDisputeEvidenceReadinessIssues(account, Number(entityState.timestamp ?? 0)).length > 0) {
    return { newState: entityState, outputs: [] };
  }
  const intent = account.disputePrepare?.startIntent;
  return handleDisputeStart(
    entityState,
    {
      type: 'disputeStart',
      data: {
        counterpartyEntityId,
        ...(intent?.description !== undefined ? { description: intent.description } : {}),
        ...(intent?.crossJurisdictionRouteId !== undefined
          ? { crossJurisdictionRouteId: intent.crossJurisdictionRouteId }
          : {}),
        ...(intent?.starterInitialArguments !== undefined
          ? { starterInitialArguments: intent.starterInitialArguments }
          : {}),
        ...(intent?.allowUnsafeCrossJTargetDispute === true
          ? { allowUnsafeCrossJTargetDispute: true }
          : {}),
        ...(intent?.acceptedCrossJTargetLossAmount !== undefined
          ? { acceptedCrossJTargetLossAmount: intent.acceptedCrossJTargetLossAmount }
          : {}),
      },
    },
    env,
    storageChanges,
  );
}

/**
 * Handle disputeStart - Entity initiates dispute with signed proof
 */
export async function handleDisputeStart(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'disputeStart' }>,
  env: Env,
  _storageChanges: RuntimeOverlayRecord[] = [],
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const {
    counterpartyEntityId,
    description,
    starterInitialArguments: overrideStarterInitialArguments,
  } = entityTx.data;
  const overrideInitialArguments = overrideStarterInitialArguments;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const crossJurisdictionRouteId = entityTx.data.crossJurisdictionRouteId;
  if (crossJurisdictionRouteId) {
    const route = newState.crossJurisdictionSwaps?.get(crossJurisdictionRouteId);
    if (!route || route.orderId !== crossJurisdictionRouteId) {
      throw new Error(`DISPUTE_START_CROSS_J_ROUTE_MISSING:${crossJurisdictionRouteId}`);
    }
    const localEntityId = newState.entityId.toLowerCase();
    const localCounterpartyId = counterpartyEntityId.toLowerCase();
    const isSourceAccount =
      route.source.entityId.toLowerCase() === localEntityId &&
      route.source.counterpartyEntityId.toLowerCase() === localCounterpartyId;
    const isTargetAccount =
      route.target.counterpartyEntityId.toLowerCase() === localEntityId &&
      route.target.entityId.toLowerCase() === localCounterpartyId;
    if (!isSourceAccount && !isTargetAccount) {
      throw new Error(`DISPUTE_START_CROSS_J_ROUTE_ROLE_MISMATCH:${crossJurisdictionRouteId}`);
    }
    if (isCrossJurisdictionTerminalStatus(route.status) || !route.targetPull) {
      throw new Error(
        `DISPUTE_START_CROSS_J_ROUTE_INACTIVE:${crossJurisdictionRouteId}:${route.status}`,
      );
    }
  }

  if (entityTx.data.starterIncrementedArguments !== undefined) {
    throw new Error('DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED');
  }

  disputeLog.debug('start.begin', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyEntityId),
  });

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

  const accountStatus = account.status ?? 'active';
  if (accountStatus === 'disputed') {
    addMessage(newState, `❌ Account with ${counterpartyEntityId.slice(-4)} is disputed - reopen required`);
    return { newState, outputs };
  }
  if (accountStatus !== 'dispute_preparing') {
    addMessage(
      newState,
      `❌ Account with ${counterpartyEntityId.slice(-4)} must enter dispute preparation before disputeStart`,
    );
    return { newState, outputs };
  }
  freezeAccountForDispute(account, true);
  const readinessIssues = collectDisputeEvidenceReadinessIssues(
    account,
    Number(newState.timestamp ?? 0),
  );
  if (readinessIssues.length > 0) {
    addMessage(
      newState,
      `⏳ disputeStart blocked until evidence is stable for ${counterpartyEntityId.slice(-4)}: ${readinessIssues.join('; ')}`,
    );
    return { newState, outputs };
  }
  if (hasQueuedDisputeStart(newState, counterpartyEntityId)) {
    addMessage(
      newState,
      `ℹ️ disputeStart already queued for ${counterpartyEntityId.slice(-4)} (awaiting batch lifecycle)`,
    );
    return { newState, outputs };
  }

  // Use stored counterparty dispute hanko AND proofBodyHash (exchanged during bilateral consensus)
  // CRITICAL: Must use the SAME proofBodyHash that the hanko signed, not a fresh one!
  const counterpartyDisputeHanko = account.counterpartyDisputeProofHanko;
  const storedProofBodyHash = account.counterpartyDisputeProofBodyHash;
  const storedDisputeHash = account.counterpartyDisputeHash;

  if (!counterpartyDisputeHanko || counterpartyDisputeHanko === '0x' || counterpartyDisputeHanko.length <= 2) {
    addMessage(newState, `❌ Missing counterparty dispute hanko - cannot start dispute`);
    disputeLog.error('start.hanko_missing', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs };
  }

  disputeLog.debug('start.hanko_loaded', {
    counterparty: shortId(counterpartyEntityId),
    length: counterpartyDisputeHanko.length,
    prefix: shortHash(counterpartyDisputeHanko, 18),
    sigBytes: Math.max(counterpartyDisputeHanko.length - 2, 0) / 2,
  });

  if (!storedProofBodyHash) {
    addMessage(newState, `❌ Missing stored counterparty proofBodyHash - cannot start dispute safely`);
    disputeLog.error('start.proof_body_hash_missing', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs };
  }
  const proofBodyHashToUse = storedProofBodyHash;
  const initialProofbody = canonicalizeProofBodyStruct(
    requireProofBodyStruct(
      account.disputeProofBodiesByHash?.[proofBodyHashToUse],
      entityState.entityId,
      counterpartyEntityId,
      'disputeStart.initial',
    ),
    entityState.entityId,
    counterpartyEntityId,
    'disputeStart.initial',
  );
  assertDisputeProofBodyWithinContractLimits(initialProofbody, 'disputeStart.initial');
  const revealedProofbodyHash = hashProofBodyStruct(initialProofbody);
  if (revealedProofbodyHash.toLowerCase() !== proofBodyHashToUse.toLowerCase()) {
    throw new Error(
      `DISPUTE_START_PROOFBODY_HASH_MISMATCH:${counterpartyEntityId}:${proofBodyHashToUse}:${revealedProofbodyHash}`,
    );
  }
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
  const rawStarterInitialArguments =
    overrideInitialArguments && overrideInitialArguments !== '0x'
      ? overrideInitialArguments
      : (starterIsLeft ? initialSnapshotArguments.leftArguments : initialSnapshotArguments.rightArguments);
  disputeLog.debug('start.proof_body_hash_loaded', {
    counterparty: shortId(counterpartyEntityId),
    proofBodyHash: shortHash(storedProofBodyHash),
  });

  // Resolve the offchain nonce that matches the stored counterparty dispute signature.
  // This is the bilateral nonce at which the counterparty signed the dispute proof.
  // NOT the on-chain nonce (which is the last event-synced nonce from the J-machine).
  // Priority: exact hash→nonce map > stored counterparty sig nonce > proofHeader fallback.
  let signedNonce: number = account.proofHeader.nextProofNonce;
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
    disputeLog.error('start.signed_nonce_invalid', { counterparty: shortId(counterpartyEntityId), signedNonce, nonceSource });
    return { newState, outputs };
  }

  const jNonce = Number(account.jNonce ?? 0);
  disputeLog.debug('start.nonce', {
    counterparty: shortId(counterpartyEntityId),
    signedNonce,
    nonceSource,
    jNonce,
  });

  // On-chain requires nonce > stored nonce for disputeStart.
  // If stale, caller must execute manual reopen flow first.
  if (signedNonce <= jNonce) {
    const msg = `❌ Stale dispute proof nonce ${signedNonce} (on-chain=${jNonce}) - reopen required`;
    addMessage(newState, msg);
    disputeLog.warn('start.nonce_stale', { counterparty: shortId(counterpartyEntityId), signedNonce, jNonce });
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
  const argumentWarnings = [...initialSnapshotArguments.warnings];
  let rawStarterIncrementedArguments = '0x';
  if (localCounterCandidates.length === 1) {
    const candidate = localCounterCandidates[0]!;
    const args = buildDisputeArgumentsForSnapshot(
      account,
      newState,
      counterpartyEntityId,
      candidate.proofbodyHash,
      { secretsSide: starterSide },
    );
    rawStarterIncrementedArguments = starterIsLeft ? args.leftArguments : args.rightArguments;
    argumentWarnings.push(...args.warnings);
  }
  const sanitizedStarterArguments = sanitizeOptionalDisputeStarterArgumentPair(
    rawStarterInitialArguments,
    rawStarterIncrementedArguments,
    'disputeStart.starterArguments',
  );
  const starterInitialArguments = sanitizedStarterArguments.initial;
  const starterIncrementedArguments = sanitizedStarterArguments.incremented;
  argumentWarnings.push(...sanitizedStarterArguments.warnings);
  reportOptionalArgumentWarnings(env, counterpartyEntityId, argumentWarnings);
  assertDisputeArgumentsWithinContractLimits(
    [starterInitialArguments, starterIncrementedArguments],
    'disputeStart.starterArguments',
  );

  const hankoDomain = resolveDepositoryHankoDomain(entityState);
  if (hankoDomain) {
    const exactDisputeHash = createDisputeProofHashWithNonce(
      account,
      proofBodyHashToUse,
      hankoDomain,
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
    if (shouldLogFullPayloads()) {
      const hankoDebug = await inspectHankoForHash(counterpartyDisputeHanko, exactDisputeHash);
      const matchingClaim = hankoDebug.claims.find(
        (claim) => String(claim.entityId).toLowerCase() === String(counterpartyEntityId).toLowerCase(),
      );
      disputeLog.debug('start.preflight_payload', {
        contractGuard: 'EntityProvider.sol:469 require(entityId == boardHash)',
        entityId: entityState.entityId,
        counterpartyEntityId,
        signedNonce,
        nonceSource,
        jNonce,
        proofHeaderNonce: account.proofHeader.nextProofNonce,
        storedCounterpartyDisputeProofNonce: account.counterpartyDisputeProofNonce,
        proofBodyHash: proofBodyHashToUse,
        disputeHashSource,
        disputeHash: exactDisputeHash,
        depositoryAddress: hankoDomain.depositoryAddress,
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
      });
    }
    const counterpartyBoardHash = resolveObserverCertifiedBoardHash(
      entityState,
      getCertifiedBoardNodeStore(env),
      counterpartyEntityId,
    );
    const exactDisputeVerify = await verifyHankoForHash(
      counterpartyDisputeHanko,
      exactDisputeHash,
      counterpartyEntityId,
      env,
      counterpartyBoardHash ? { registeredBoardHash: counterpartyBoardHash } : undefined,
    );
    if (!exactDisputeVerify.valid) {
      const currentProofResult = buildAccountProofBodyFromEnv(env, account);
      const msg =
        `❌ Counterparty dispute proof invalid for current account snapshot; ` +
        `nonce=${signedNonce} onChain=${jNonce} source=${nonceSource}`;
      addMessage(newState, msg);
      disputeLog.error('start.preflight_failed', {
        entityId: entityState.entityId,
        counterpartyEntityId,
        signedNonce,
        nonceSource,
        jNonce,
        proofHeaderNonce: account.proofHeader.nextProofNonce,
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
        depositoryAddress: hankoDomain.depositoryAddress,
        recoveredEntityId: exactDisputeVerify.entityId,
        hankoBytes: Math.max(counterpartyDisputeHanko.length - 2, 0) / 2,
      });
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
    initialProofbody,
    watchSeed: String(initialProofbody.watchSeed),
    sig: counterpartyDisputeHanko,
    starterInitialArguments,
    starterIncrementedArguments,
  });
  encodeJBatch(newState.jBatchState.batch);
  if (crossJurisdictionRouteId) {
    newState.jBatchState.autoBroadcastDraft = true;
    if (!newState.jBatchState.sentBatch) {
      const signerId = newState.config.validators[0];
      if (!signerId) throw new Error('DISPUTE_START_CROSS_J_BROADCAST_SIGNER_MISSING');
      outputs.push({
        entityId: newState.entityId,
        signerId,
        entityTxs: [{ type: 'j_broadcast', data: {} }],
      });
    }
  }

  // Freeze account immediately once disputeStart is queued.
  // This is unilateral safety state on the local entity: no further business
  // frames should progress on this account while dispute is in-flight.
  account.status = 'disputed';
  delete account.disputePrepare;
  freezeAccountForDispute(account, false);
  // Local placeholder for UX continuity: account stays visible as "active dispute"
  // immediately after queueing disputeStart, before on-chain DisputeStarted event arrives.
  // On-chain event will overwrite this with authoritative timeout/nonce data.
  if (!account.activeDispute) {
    account.activeDispute = {
      startedByLeft: isDisputeStartedByLeft(entityState.entityId, account.leftEntity, account.rightEntity),
      initialProofbodyHash: proofBodyHashToUse,
      initialNonce: signedNonce,
      // The exact timeout is chosen by Depository at inclusion height and is
      // certified back through DisputeStarted. A validator-local chain tip is
      // neither authoritative nor deterministic, so pending state records the
      // timeout as unknown until that canonical event is finalized.
      disputeTimeout: 0,
      jNonce,
      starterInitialArguments,
      starterIncrementedArguments,
      observedOnChain: false,
      finalizeQueued: false,
    };
  }

  disputeLog.debug('start.jbatch_queued', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyEntityId),
    proofBodyHash: shortHash(proofBodyHashToUse),
    hankoLen: counterpartyDisputeHanko.length,
    signedNonce,
  });

  // NOTE: activeDispute will be set when DisputeStarted event arrives from J-machine
  // Event handler will query on-chain state and populate:
  // - startedByLeft, disputeTimeout, jNonce

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

  disputeLog.debug('finalize.begin', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyEntityId),
    cooperativeRequested,
  });

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
  if (account.activeDispute.observedOnChain !== true) {
    addMessage(
      newState,
      `⏳ disputeFinalize blocked until DisputeStarted is observed on-chain for ${counterpartyEntityId.slice(-4)}`,
    );
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
    warnDisputeUnlessQuiet(env, 'finalize.cooperative_rejected', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs };
  }
  freezeAccountForDispute(account, true);

  // Same readiness gate as disputeStart. If the counterparty starts first, we
  // still refuse to counter-finalize while evidence can change. Finalization
  // arguments are as security-critical as start arguments: both commit calldata
  // for a specific proof body, so pending secrets/fills must be settled first.
  const readinessIssues = collectDisputeEvidenceReadinessIssues(
    account,
    Number(newState.timestamp ?? 0),
  );
  if (readinessIssues.length > 0) {
    addMessage(
      newState,
      `⏳ disputeFinalize blocked until evidence is stable for ${counterpartyEntityId.slice(-4)}: ${readinessIssues.join('; ')}`,
    );
    return { newState, outputs };
  }

  // Build current proof only to compare against the stored dispute body.
  const currentProofResult = buildAccountProofBodyFromEnv(env, account);
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
    disputeLog.error('finalize.nonce_invalid', { counterparty: shortId(counterpartyEntityId), finalNonce, finalNonceSource });
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
    disputeLog.warn('finalize.proof_body_hash_mismatch', {
      counterparty: shortId(counterpartyEntityId),
      current: shortHash(currentProofResult.proofBodyHash),
      initial: shortHash(account.activeDispute.initialProofbodyHash),
    });
    if (!storedProofBody) {
      throw new Error('disputeFinalize: missing stored proofBody for unilateral finalize');
    }
  }

  if (shouldUseCounterProof && account.counterpartyDisputeHash) {
    const hankoDomain = resolveDepositoryHankoDomain(entityState);
    if (!hankoDomain) {
      throw new Error('DISPUTE_COUNTER_FINALIZE_DEPOSITORY_MISSING');
    }
    const expectedHash = createDisputeProofHashWithNonce(
      account,
      counterProofBodyHash!,
      hankoDomain,
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
  // committed by DisputeStarted; the finalizer only supplies its own side.
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
  reportOptionalArgumentWarnings(env, counterpartyEntityId, builtArguments.warnings);
  const starterArgumentsForFinalProof = shouldUseCounterProof
    ? account.activeDispute.starterIncrementedArguments
    : account.activeDispute.starterInitialArguments;
  const otherArgumentsForFinalProof = account.activeDispute.startedByLeft
    ? builtArguments.rightArguments
    : builtArguments.leftArguments;
  assertDisputeProofBodyWithinContractLimits(finalProofbody, 'disputeFinalize.final');
  const recomputedFinalProofbodyHash = hashProofBodyStruct(finalProofbody);
  if (recomputedFinalProofbodyHash.toLowerCase() !== finalProofbodyHash.toLowerCase()) {
    throw new Error(
      `DISPUTE_FINALIZE_PROOFBODY_HASH_MISMATCH:${counterpartyEntityId}:${finalProofbodyHash}:${recomputedFinalProofbodyHash}`,
    );
  }
  assertDisputeArgumentsWithinContractLimits(
    [starterArgumentsForFinalProof],
    'disputeFinalize.starterArguments',
  );
  assertDisputeArgumentsWithinContractLimits(
    [otherArgumentsForFinalProof],
    'disputeFinalize.otherArguments',
  );

  const finalProof = {
    counterentity: counterpartyEntityId,
    initialNonce: account.activeDispute.initialNonce,  // Nonce when dispute was started
    finalNonce,
    initialProofbodyHash: account.activeDispute.initialProofbodyHash,  // From disputeStart (commit)
    finalProofbody,  // REVEAL
    starterArguments: starterArgumentsForFinalProof,
    otherArguments: otherArgumentsForFinalProof,
    sig: finalizeSig,
    startedByLeft: account.activeDispute.startedByLeft,  // From on-chain
    cooperative: false,
  };

  // Registry publication is optional evidence, but the selected set is bound
  // to this exact signed ProofBody. Compute before timeout checks without
  // mutating the batch; an early finalize remains a true no-op.
  const registrySecrets = entityTx.data.useOnchainRegistry
    ? collectKnownDisputeSecretsForSnapshot(
        account,
        newState,
        counterpartyEntityId,
        finalProofbodyHash,
      )
    : [];
  const registryTransformerAddress = registrySecrets.length > 0
    ? requireAccountDeltaTransformerAddress(env, account)
    : '';
  if (registrySecrets.length > 0 && !isUsableContractAddress(registryTransformerAddress)) {
    throw new Error('DISPUTE_FINALIZE_MISSING_DELTA_TRANSFORMER_ADDRESS');
  }

  disputeLog.debug('finalize.proof_selected', {
    counterparty: shortId(counterpartyEntityId),
    mode: shouldUseCounterProof ? 'counter' : 'unilateral',
    timeout: account.activeDispute.disputeTimeout,
    initialNonce: finalProof.initialNonce,
    finalNonce: finalProof.finalNonce,
    finalNonceSource,
  });

  // Protocol rule (matches Depository.sol):
  // - dispute starter must wait until timeout for unilateral finalize
  // - counterparty may finalize immediately (same-proof path) without waiting
  const callerIsStarter = callerIsLeft === account.activeDispute.startedByLeft;
  if (!shouldUseCounterProof && callerIsStarter) {
    const currentJBlock = getEntityCertifiedJurisdictionHeight(newState);
    if (currentJBlock < account.activeDispute.disputeTimeout) {
      addMessage(
        newState,
        `❌ disputeFinalize too early for starter: currentBlock=${currentJBlock}, timeout=${account.activeDispute.disputeTimeout}`,
      );
      warnDisputeUnlessQuiet(env, 'finalize.too_early', {
        counterparty: shortId(counterpartyEntityId),
        currentJBlock,
        timeout: account.activeDispute.disputeTimeout,
      });
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
  for (const secret of registrySecrets) {
    batchAddRevealSecret(newState.jBatchState, registryTransformerAddress, secret);
  }
  newState.jBatchState.batch.disputeFinalizations.push(finalProof);
  encodeJBatch(newState.jBatchState.batch);
  account.activeDispute.finalizeQueued = true;

  disputeLog.debug('finalize.jbatch_queued', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyEntityId),
    mode: shouldUseCounterProof ? 'counter' : 'unilateral',
  });

  addMessage(newState, `⚖️ Dispute finalized vs ${counterpartyEntityId.slice(-4)} ${description ? `(${description})` : ''} - use jBroadcast to commit`);

  return { newState, outputs };
}
