import { applyEntityAccountEnvelopeUpdate } from "../../../entity/account-envelope-update";
import { rejectFrozenAccountInput } from "../../../entity/tx/handlers/account/frozen-input";
import { DEFAULT_SPREAD_DISTRIBUTION } from '../../../orderbook/types';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { createEntityFrameCandidateState } from '../../../entity/state-clone';
import { describe, expect, spyOn, test } from 'bun:test';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';

import { x25519 } from '@noble/curves/ed25519.js';

import {
  applyAccountInput,
  proposeAccountFrame,
} from '../../../account/consensus/index';

import { computeAccountStateRoot, computeAccountStateRootCold } from '../../../account/commitment/state-root';

import { resolveCertifiedAccountCounterpartyProposer } from '../../../runtime/delivery/topology/account-counterparty-route';

import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../../../account/crypto';

import { deriveAccountWatchSeed } from '../../../protocol/identity/account-watch-seed';

import { applyAccountTx } from '../../../account/tx/apply';


import { handleHtlcLock } from '../../../account/tx/handlers/htlc/lock';

import { handleHtlcResolve } from '../../../account/tx/handlers/htlc/resolve';

import { createSettlementWorkspaceHash } from '../../../account/tx/handlers/settlement/transition';

import { hashHtlcSecret } from '../../../protocol/htlc/utils';

import { buildHashLadderProof, revealHashLadder } from '../../../protocol/htlc/hash-ladder';


import { checkAutoRebalance, handleRequestCollateral } from '../../../account/tx/handlers/rebalance/request-collateral';

import { handleSwapOffer } from '../../../account/tx/handlers/swap/offer/index';

import { computeFrameHash, MAX_ACCOUNT_FRAME_TXS } from '../../../account/consensus/frame/hash';

import { resolveAutoRebalanceFeePolicy, runPostFrameAutoRebalanceCheck } from '../../../account/consensus/helpers';

import { HTLC, LIMITS } from '../../../config/constants';

import { executeCrontab, initCrontab } from '../../../entity/scheduler';

import { encodeBoard, generateLazyEntityId, generateNumberedEntityId, hashBoard } from '../../../entity/factory';

import { isLeftEntity } from '../../../entity/id';

import {
  applyEntityInput,
} from '../../../entity/consensus/index';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';

import { createEntityFrameHash } from '../../../entity/consensus/frame';

import { buildSignedEntityCommand, prepareLocallyAuthoredEntityTxs } from '../../../entity/command';

import { signedEntityCommandTx } from '../../../entity/command/command-codec';

import { buildCollectiveEntityProposalTx } from '../../../entity/auth/authorization';

import { generateProposalId } from '../../../entity/tx/processing/proposals';

import { buildEntityHashesToSign } from '../../../entity/consensus/input/hanko-witness';
import {
  applyStorageChanges,
  publishEntityCandidateEffects,
} from '../../../runtime/observability/env-events';

import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
  computeEntityAccountValueHash,
  computeEntityFrameAuthorityRoot,
} from '../../../entity/consensus/state-root';

import {
  assertCrossJurisdictionOrderAdmissible,
  findCrossJurisdictionBookAdmissionForAck,
} from '../../../orderbook/cross-j/orderbook';

import {
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionBookAdmissionError,
  mergeCrossJurisdictionBookAdmission,
} from '../../../extensions/cross-j/orderbook';

import {
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j/index';

import { applyEntityTx } from '../../../entity/tx/apply';

import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../../../entity/tx/handlers/account-cross-j-followups';

import { buildCrossJurisdictionEntityOutput } from '../../../entity/tx/j-events-htlc/cross-j-outputs';


import {
  handleAdmitCrossJurisdictionBookOrderEntityTx,
} from '../../../entity/tx/handlers/cross-j/book-order';
import { handleCrossJurisdictionBookOrderRemovedEntityTx } from '../../../entity/tx/handlers/cross-j/book-removal-ack';

import type { SwapOfferEvent } from '../../../entity/tx/handlers/account/index';

import { handleDisputeFinalize, handleDisputeStart, handlePrepareDispute } from '../../../entity/tx/handlers/dispute/index';

import { handleJAbortSentBatch } from '../../../entity/tx/handlers/j-batch/j-abort-sent-batch';

import { handleJRebroadcast } from '../../../entity/tx/handlers/j-batch/j-rebroadcast';

import { handleSetHubConfigEntityTx, handleSetRebalancePolicyEntityTx } from '../../../entity/tx/handlers/account/lifecycle/admin';

import { buildSettlementHankoDraft, processCommittedSettlementTransitionFollowup } from '../../../entity/tx/handlers/payments/settle';

import { applyJEvent } from '../../../entity/tx/j-events';

import { applyJEventRange, buildJEventRangeData } from '../../helpers/j-history';


import { queueCrossJurisdictionSalvageFromFinalizedArguments } from '../../../entity/tx/j-events-htlc';

import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../../../jurisdiction/machine/event-observation';

import { getRuntimeJurisdictionHeight } from '../../../jurisdiction/machine/history/height';

import { recordValidatorJHistory } from '../../../jurisdiction/machine/local-history';

import { buildLocalJPrefixAttestation } from '../../../jurisdiction/machine/history/j-prefix-consensus';

import { createEmptyBatch, encodeJBatch } from '../../../jurisdiction/machine/batch';

import {
  getCertifiedBoardNodeStore,
  resolveCertifiedRegisteredBoardHash,
  resolveObserverCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';

import {
  applyCommand,
  createBook,
  getBookOrder,
  getSwapLotScale,
  ORDERBOOK_PRICE_SCALE,
  SWAP_LOT_SCALE,
  type OrderbookExtState,
} from '../../../orderbook';

import {
  createEmptyEnv,
  processRuntime,
  registerEntityRuntimeHint,
  sendEntityInput,
  validateRuntimeInputAdmission,
} from '../../../runtime';

import { createJReplica } from '../../../scenarios/harness/boot';

import { applyMergedEntityInputs, RuntimeEntityInputApplyError } from '../../../runtime/mempool/entity-inputs';

import { MalformedEntityFrameInputError } from '../../../entity/tx/processing/invariant-errors';

import { submitRuntimeJOutbox } from '../../../runtime/j-submit/j-submit';

import { registerStructuredLogSink } from '../../../support/logger';

import { buildJSubmitAttemptId, registerPendingCommittedJOutbox } from '../../../runtime/j-submit/j-submit-state';

import { buffersEqual, safeStringify } from '../../../protocol/serialization';

import type { ProofBodyStruct } from '../../../protocol/dispute/proof-body';

import { hydrateAccountDocFromStorage, projectAccountDoc } from '../../../storage/read/projections';

import { validateStorageAccountDocValue } from '../../../storage/schema/authoritative-schema';

import { decodeValidatedBuffer, encodeBuffer } from '../../../storage/codec/codec';

import { createDefaultDelta } from '../../../account/state/delta';


import {
  buildAccountProofBody,
  createDisputeProofHashWithNonce,
  hashProofBodyStruct,
} from '../../../protocol/dispute/proof-builder';

import { encodeSignedHanko } from '../../../hanko/codec';

import { resolveHankoBoardDelays } from '../../../hanko/claims';

import { signEntityHashes, verifyHankoForHash } from '../../../hanko/signing';


import { handleMeshBootstrapLoopError } from '../../../orchestrator/mesh/mesh-bootstrap-fail-fast';

import { fitCrossAmountsToOrderbook } from '../../../orchestrator/mm-node';
import {
  clearReplayOutputSignerHints,
  installReplayOutputSignerHints,
  resolveEntityProposerId,
} from '../../../runtime/delivery/entity-output-signer';

import { QUOTE_EXPIRY_MS } from '../../../types/finance/rebalance';

import type { AccountFrame, AccountInput, AccountReplica, AccountState, AccountTx } from '../../../types/account';
import type { ConsensusConfig, EntityInput, EntityReplica, EntityState, JurisdictionConfig } from '../../../entity/types';
import type { RuntimeReplica, RuntimeTx } from '../../../runtime/types';
import type { JInput } from '../../../jurisdiction/machine/input';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { DisputeFinalizationEvidence, JurisdictionEvent } from '../../../types/jurisdiction-events';
import type { EntityTx } from '../../../types/entity-tx';

import { installCanonicalRegisteredBoardAuthority } from '../../helpers/registration-evidence';

import { ethers } from 'ethers';
import {
  isProposedAccountFrame,
} from '../../../account/consensus/result';

const makeSingleSignerConfig = (): EntityState['config'] => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: ['1'],
  shares: { '1': 1n },
  jurisdiction: {
    name: 'AuditTestnet',
    chainId: 31337,
    depositoryAddress: `0x${'dd'.repeat(20)}`,
    entityProviderAddress: `0x${'ee'.repeat(20)}`,
  },
});

const makeSingleSignerConfigFor = (signerId: string): EntityState['config'] => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction: {
    name: 'AuditTestnet',
    chainId: 31337,
    depositoryAddress: `0x${'dd'.repeat(20)}`,
    entityProviderAddress: `0x${'ee'.repeat(20)}`,
  },
});

const hex20 = (byte: string): string => `0x${byte.repeat(byte.length === 2 ? 20 : 40)}`;

const HANKO_DELAYS = resolveHankoBoardDelays();

const makeProposalAccount = (mempool: AccountTx[], leftEntity: string, rightEntity: string): AccountReplica => {
  return {
    state: {
      leftEntity,
      rightEntity,
      domain: { chainId: 31337, depositoryAddress: `0x${'dd'.repeat(20)}` },
      watchSeed: deriveAccountWatchSeed({
        runtimeSeed: 'audit-failfast-test-helper',
        entityId: leftEntity,
        counterpartyId: rightEntity,
      }),
      deltas: PersistentAccountStateMap.empty('deltas'),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      jNonce: 0,
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
    },
    status: 'active',
    mempool: [...mempool],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: '',
      byLeft: true,
    },
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
};

const setSyntheticPendingAccountProposal = (
  account: AccountReplica,
  accountTxs: AccountTx[],
  timestamp: number,
): void => {
  const pendingFrame = {
    ...account.currentFrame,
    height: account.currentHeight + 1,
    timestamp,
    accountTxs: structuredClone(accountTxs),
    prevFrameHash: account.currentHeight === 0 ? 'genesis' : account.currentFrame.stateHash,
    stateHash: `0x${'f0'.repeat(32)}`,
  };
  account.pendingFrame = pendingFrame;
  account.pendingAccountInput = {
    kind: 'ack_frame',
    fromEntityId: account.proofHeader.fromEntity,
    toEntityId: account.proofHeader.toEntity,
    domain: structuredClone(account.state.domain),
    disputeConfig: structuredClone(account.state.disputeConfig),
    proposal: { frame: structuredClone(pendingFrame) },
  };
};

const attachSigningReplica = (env: ReturnType<typeof createEmptyEnv>, entityId: string, signerId: string): void => {
  const config = makeSingleSignerConfigFor(signerId);
  const jurisdiction = config.jurisdiction!;
  if (!env.state.jReplicas.has('__audit_test__')) {
    env.state.jReplicas.set('__audit_test__', {
      name: '__audit_test__',
      chainId: jurisdiction.chainId,
      rpcs: [],
      contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress },
      contracts: {
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
        account: hex20('98'),
        deltaTransformer: hex20('99'),
      },
      blockNumber: 0n,
      stateRoot: null,
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      watcherConfirmationDepth: 0,
      position: { x: 0, y: 0, z: 0 },
    });
  }
  env.state.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    entityEncPubKey: '',
    mempool: [],
    isProposer: true,
    state: {
      ...makeEntityState(entityId),
      config,
    },
  } satisfies EntityReplica);
};

const registerLazySigner = (seed: string, signerSlot: string): { signerId: string; entityId: string } => {
  const signerId = deriveSignerAddressSync(seed, signerSlot);
  const privateKey = deriveSignerKeySync(seed, signerSlot);
  registerSignerKey(seed, signerId, privateKey);
  return {
    signerId,
    entityId: generateLazyEntityId([signerId], 1n).toLowerCase(),
  };
};

const makeEntityState = (entityId: string): EntityState => createEntityFrameCandidateState({
  entityId,
  entityEncryptionPublicKey: `0x${'44'.repeat(32)}`,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: makeSingleSignerConfig(),
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  profile: {
    name: 'Audit Entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  paybook: { entries: new Map(), feesEarned: 0n },
  swapTradingPairs: [],
  crontabState: initCrontab(),
});

describe('audit fail-fast regressions', () => {

  test('cross-j fill ack admission secondary index requires matching route hash', () => {
    const env = createEmptyEnv('cross-fill-ack-admission-regression');
    env.state.timestamp = 10_000;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const sourceUser = `0x${'31'.repeat(32)}`;
    const targetHub = `0x${'32'.repeat(32)}`;
    const targetUser = `0x${'33'.repeat(32)}`;
    const orderId = 'source-admission-regression';
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId,
        sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        makerEntityId: sourceUser,
        hubEntityId: targetHub,
        bookOwnerEntityId: targetHub,
        venueId: 'cross:base:2/tron:1',
        sourceSignerId: 'source-user-signer',
        sourceHubSignerId: 'source-hub-signer',
        targetHubSignerId: 'target-hub-signer',
        targetSignerId: 'target-user-signer',
        bookHubSignerId: 'target-hub-signer',
        source: {
          jurisdiction: 'base',
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: 10n * SWAP_LOT_SCALE,
        },
        target: {
          jurisdiction: 'tron',
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 25_000n * SWAP_LOT_SCALE,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: env.state.timestamp + 60_000,
      },
      { runtimeSeed: 'cross-fill-ack-admission-regression', now: env.state.timestamp },
    );
    const state = makeEntityState(targetHub);
    const routeHash = route.routeHash || 'route-hash';
    const admission = {
      orderId,
      routeHash,
      sourceEntityId: sourceUser,
      bookOwnerEntityId: targetHub,
      status: 'admitted' as const,
      route,
      updatedAt: env.state.timestamp,
    };
    state.crossJurisdictionBookAdmissions = new Map([[`${sourceUser.toLowerCase()}:${orderId}`, admission]]);

    expect(findCrossJurisdictionBookAdmissionForAck(state, sourceUser, orderId)).toBe(admission);
    expect(findCrossJurisdictionBookAdmissionForAck(state, sourceUser, orderId, `0x${'ff'.repeat(32)}`)).toBeNull();
    expect(findCrossJurisdictionBookAdmissionForAck(state, sourceUser, orderId, routeHash)).toBe(admission);
    expect(findCrossJurisdictionBookAdmissionForAck(state, targetHub, orderId)).toBeNull();
    expect(findCrossJurisdictionBookAdmissionForAck(state, targetHub, orderId, `0x${'ff'.repeat(32)}`)).toBeNull();
    expect(findCrossJurisdictionBookAdmissionForAck(state, targetHub, orderId, routeHash)).toBe(admission);
  });

  test('committed cross-j output is independent of Runtime topology', () => {
    const target = `0x${'ab'.repeat(32)}`;
    const committedSigner = `0x${'cd'.repeat(20)}`;
    const txs: EntityTx[] = [{ type: 'j_broadcast', data: {} }];
    expect(() => buildCrossJurisdictionEntityOutput(target, '', txs)).toThrow(
      'CROSS_J_ENTITY_OUTPUT_ROUTE_MISSING',
    );
    expect(buildCrossJurisdictionEntityOutput(target.toUpperCase(), committedSigner.toUpperCase(), txs))
      .toEqual({
        entityId: target,
        signerId: committedSigner,
        entityTxs: txs,
      });
  });

  test('prepareDispute removes same-account orderbook rows before disputeStart', async () => {
    const env = createEmptyEnv('dispute-start-orderbook-freeze');
    const hubId = `0x${'90'.repeat(32)}`;
    const userId = `0x${'91'.repeat(32)}`;
    const offerId = 'dispute-freeze-offer';
    const pairId = '1/2';
    const namespacedOrderId = `${userId}:${offerId}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.state.swapOffers = account.state.swapOffers.updated(offerId, {
      offerId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 2,
      wantAmount: 2_000n,
      maxFee: 0n,
      minNetReceive: 2_000n,
      makerIsLeft: false,
      createdHeight: 1,
      quantizedGive: 1_000n,
      quantizedWant: 2_000n,
      priceTicks: 2_000n,
    });
    hubState.accounts.set(userId, account);
    let book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: userId,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 2_000n,
      qtyLots: 1n,
    }).state;
    hubState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[namespacedOrderId, [pairId]]]),
      referrals: new Map(),
      pairDimensions: new Map(),
      hubProfile: { entityId: hubId, name: 'Audit Hub', spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
        referenceTokenId: 1, usdQuoteAuthorityEntityId: hubId, minTradeSize: 0n, supportedPairs: [pairId] },
    } satisfies OrderbookExtState;

    const result = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    const nextBook = result.newState.orderbookExt?.books.get(pairId);
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes('Dispute removed 1 local orderbook row'))).toBe(true);
  });

  test('prepareDispute routes remote cross-j removal from the committed book signer', async () => {
    const env = createEmptyEnv('dispute-start-cross-j-remote-book');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceHub = `0x${'92'.repeat(32)}`;
    const sourceUser = `0x${'93'.repeat(32)}`;
    const targetHub = `0x${'94'.repeat(32)}`;
    const targetUser = `0x${'95'.repeat(32)}`;
    const offerId = 'dispute-cross-j-remote-book';
    const state = makeEntityState(sourceHub);
    state.config = makeSingleSignerConfigFor('source-hub-signer');
    const account = makeProposalAccount([], sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: offerId,
        sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        makerEntityId: sourceUser,
        hubEntityId: targetHub,
        bookOwnerEntityId: targetHub,
        sourceSignerId: 'source-user-signer',
        sourceHubSignerId: 'source-hub-signer',
        targetHubSignerId: 'committed-book-owner-signer',
        targetSignerId: 'target-user-signer',
        bookHubSignerId: 'committed-book-owner-signer',
        source: {
          jurisdiction: 'stack:31338:0x2222222222222222222222222222222222222222',
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: 'stack:31337:0x1111111111111111111111111111111111111111',
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: 2_000n,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: env.state.timestamp + 60_000,
      },
      { runtimeSeed: 'dispute-start-cross-j-remote-book', now: env.state.timestamp },
    );
    account.state.swapOffers = account.state.swapOffers.updated(offerId, {
      offerId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 2,
      wantAmount: 2_000n,
      maxFee: 0n,
      minNetReceive: 2_000n,
      makerIsLeft: false,
      createdHeight: 1,
      crossJurisdiction: route,
    });
    state.accounts.set(sourceUser, account);
    state.crossJurisdictionSwaps = new Map([[offerId, route]]);
    mergeCrossJurisdictionBookAdmission(state, route, env.state.timestamp).status = 'admitted';

    const result = await handlePrepareDispute(
      state,
      { type: 'prepareDispute', data: { counterpartyEntityId: sourceUser } },
      env,
    );

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({
      entityId: targetHub,
      signerId: 'committed-book-owner-signer',
      entityTxs: [
        {
          type: 'removeCrossJurisdictionBookOrder',
          data: { orderId: offerId, sourceEntityId: sourceUser, reason: 'account_dispute_prepare' },
        },
      ],
    });

    const afterAck = await handleCrossJurisdictionBookOrderRemovedEntityTx(env, result.newState, {
      type: 'crossJurisdictionBookOrderRemoved',
      data: {
        orderId: offerId,
        sourceEntityId: sourceUser,
        sourceAccountId: sourceUser,
        route,
        removedAt: env.state.timestamp,
        reason: 'account_dispute_prepare',
      },
    });
    const preparedAccount = afterAck.newState.accounts.get(sourceUser)!;
    expect(preparedAccount.disputePrepare?.pendingOrderbookRemovalIds).toBeUndefined();
    expect(readEntityFrameEventMessages(afterAck.newState).some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('prepareDispute freezes account and removes orderbook rows without queuing on-chain disputeStart', async () => {
    const env = createEmptyEnv('prepare-dispute-orderbook-freeze');
    const hubId = `0x${'92'.repeat(32)}`;
    const userId = `0x${'93'.repeat(32)}`;
    const offerId = 'prepare-dispute-offer';
    const pairId = '1/2';
    const namespacedOrderId = `${userId}:${offerId}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.state.swapOffers = account.state.swapOffers.updated(offerId, {
      offerId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 2,
      wantAmount: 2_000n,
      maxFee: 0n,
      minNetReceive: 2_000n,
      makerIsLeft: false,
      createdHeight: 1,
      quantizedGive: 1_000n,
      quantizedWant: 2_000n,
      priceTicks: 2_000n,
    });
    hubState.accounts.set(userId, account);
    let book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: userId,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 2_000n,
      qtyLots: 1n,
    }).state;
    hubState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[namespacedOrderId, [pairId]]]),
      referrals: new Map(),
      pairDimensions: new Map(),
      hubProfile: { entityId: hubId, name: 'Audit Hub', spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
        referenceTokenId: 1, usdQuoteAuthorityEntityId: hubId, minTradeSize: 0n, supportedPairs: [pairId] },
    } satisfies OrderbookExtState;

    const result = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId, description: 'test-prepare' },
      },
      env,
    );

    const nextAccount = result.newState.accounts.get(userId)!;
    const nextBook = result.newState.orderbookExt?.books.get(pairId);
    expect(nextAccount.status).toBe('dispute_preparing');
    expect(nextAccount.disputePrepare?.reason).toBe('test-prepare');
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);

    const reentered = await handlePrepareDispute(
      result.newState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId, description: 'retry-prepare' },
      },
      env,
    );
    const reenteredAccount = reentered.newState.accounts.get(userId)!;
    expect(reenteredAccount.status).toBe('dispute_preparing');
    expect(reenteredAccount.disputePrepare?.reason).toBe('test-prepare');
  });

  test('disputeStart freezes optimistic traffic and treats an unknown HTLC secret as optional evidence', async () => {
    const env = createEmptyEnv('prepare-dispute-awaiting-secret');
    const hubId = `0x${'94'.repeat(32)}`;
    const userId = `0x${'95'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount(
      [
        {
          type: 'set_credit_limit',
          data: { tokenId: 1, amount: 5n },
        } as AccountTx,
      ],
      hubId,
      userId,
    );
    setSyntheticPendingAccountProposal(
      account,
      [
        {
          type: 'set_credit_limit',
          data: { tokenId: 1, amount: 7n },
        } as AccountTx,
      ],
      hubState.timestamp,
    );
    hubState.accounts.set(userId, account);
    const hashlock = `0x${'44'.repeat(32)}`;
    hubState.paybook.entries.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: userId,
      createdTimestamp: hubState.timestamp,
    });
    account.state.locks = account.state.locks.updated(hashlock, {
      lockId: hashlock, hashlock, tokenId: 1, amount: 10n,
      timelock: BigInt(hubState.timestamp + 60_000), revealBeforeHeight: 100,
      senderIsLeft: false, createdHeight: 1, createdTimestamp: hubState.timestamp,
    });

    const prepared = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );
    const result = await handleDisputeStart(
      prepared.newState,
      { type: 'disputeStart', data: { counterpartyEntityId: userId } },
      env,
    );

    const nextAccount = result.newState.accounts.get(userId)!;
    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes('htlcAwaitingSecret'))).toBe(false);
    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
    expect(nextAccount.pendingFrame).toBeUndefined();
    expect(nextAccount.mempool).toEqual([]);
  });

  test('disputeStart ignores stale HTLC routes whose live lock is already gone', async () => {
    const env = createEmptyEnv('prepare-dispute-stale-htlc-route');
    const hubId = `0x${'94'.repeat(32)}`;
    const userId = `0x${'96'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    hubState.accounts.set(userId, makeProposalAccount([], hubId, userId));
    hubState.paybook.entries.set(`0x${'45'.repeat(32)}`, {
      hashlock: `0x${'45'.repeat(32)}`,
      tokenId: 1,
      amount: 10n,
      inboundEntity: userId,
      createdTimestamp: hubState.timestamp,
    });

    const prepared = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );
    const result = await handleDisputeStart(
      prepared.newState,
      { type: 'disputeStart', data: { counterpartyEntityId: userId } },
      env,
    );

    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes('htlcAwaitingSecret'))).toBe(false);
    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('disputeStart folds evidence tx mempool into dispute arguments instead of blocking', async () => {
    const env = createEmptyEnv('prepare-dispute-evidence-mempool');
    const hubId = `0x${'96'.repeat(32)}`;
    const userId = `0x${'97'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    hubState.accounts.set(
      userId,
      makeProposalAccount(
        [
          {
            type: 'swap_resolve',
            data: { offerId: 'pending-fill', fillRatio: 32_768, cancelRemainder: false },
          } as AccountTx,
        ],
        hubId,
        userId,
      ),
    );

    const prepared = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );
    const result = await handleDisputeStart(
      prepared.newState,
      { type: 'disputeStart', data: { counterpartyEntityId: userId } },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes('argumentMempool:swap_resolve'))).toBe(false);
    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('disputeStart treats pending cross_pull_close as foldable dispute evidence', async () => {
    const env = createEmptyEnv('prepare-dispute-cross-close-evidence');
    env.state.timestamp = 12_000;
    const hubSigner = registerLazySigner('prepare-dispute-cross-close-evidence', 'hub');
    const hubId = hubSigner.entityId;
    const userId = `0x${'ab'.repeat(32)}`;
    const targetHub = `0x${'ac'.repeat(32)}`;
    const targetUser = `0x${'ad'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor(hubSigner.signerId);
    attachSigningReplica(env, hubId, hubSigner.signerId);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-close-evidence',
        sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        makerEntityId: userId,
        hubEntityId: hubId,
        source: {
          jurisdiction: `stack:1:0x${'b1'.repeat(20)}`,
          entityId: userId,
          counterpartyEntityId: hubId,
          tokenId: 1,
          amount: 100n,
        },
        target: {
          jurisdiction: `stack:2:0x${'b2'.repeat(20)}`,
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: 200n,
        },
        cumulativeFillRatio: 0x4000,
        fillNumerator: 1n,
        fillDenominator: 4n,
        filledSourceAmount: 25n,
        filledTargetAmount: 50n,
        status: 'clearing',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      {
        runtimeSeed: 'prepare-dispute-cross-close-evidence',
        now: env.state.timestamp,
      },
    );
    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x4000,
      deriveCrossJurisdictionPrivateSeed('prepare-dispute-cross-close-evidence', route),
    ).binary;
    const closeTx: AccountTx = {
      type: 'cross_pull_close',
      data: {
        pullId: route.sourcePull!.pullId,
        binary,
        proof: buildCrossJurisdictionCloseProof(route, binary),
      },
    };
    const account = makeProposalAccount([closeTx], hubId, userId);
    account.state.pulls = PersistentAccountStateMap.fromEntries('pulls', [
      [
        route.sourcePull!.pullId,
        {
          pullId: route.sourcePull!.pullId,
          tokenId: route.sourcePull!.tokenId,
          amount: route.sourcePull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: route.sourcePull!.fullHash,
          partialRoot: route.sourcePull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);
    const delta = createDefaultDelta(route.sourcePull!.tokenId);
    delta.rightHold = BigInt(route.sourcePull!.amount);
    account.state.deltas = account.state.deltas.updated(route.sourcePull!.tokenId, delta);
    const proposed = await proposeAccountFrame(createAccountConsensusContext(env), account, env.state.timestamp);
    expect(isProposedAccountFrame(proposed)).toBe(true);
    const pendingHeight = proposed.accountInput!.proposal.frame.height;
    hubState.accounts.set(userId, account);

    const prepared = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );
    const result = await handleDisputeStart(
      prepared.newState,
      { type: 'disputeStart', data: { counterpartyEntityId: userId } },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes(`pendingFrame:${pendingHeight}`))).toBe(false);
    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes('argumentMempool:cross_pull_close'))).toBe(false);
    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('disputeFinalize queues the exact proof despite unknown HTLC evidence and stale optimistic traffic', async () => {
    const env = createEmptyEnv('counter-dispute-awaiting-secret');
    const hubId = `0x${'98'.repeat(32)}`;
    const userId = `0x${'99'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    attachSigningReplica(env, hubId, 'hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.state.deltas = account.state.deltas.updated(1, createDefaultDelta(1));
    const awaitSecretLockId = `0x${'55'.repeat(32)}`;
    account.state.locks = account.state.locks.updated(awaitSecretLockId, {
      lockId: awaitSecretLockId,
      hashlock: `0x${'55'.repeat(32)}`,
      timelock: BigInt(hubState.timestamp + 60_000),
      revealBeforeHeight: 100,
      amount: 10n,
      tokenId: 1,
      senderIsLeft: false,
      createdHeight: 1,
      createdTimestamp: hubState.timestamp,
    });
    const initialProof = buildAccountProofBody(account, hex20('99'));
    setSyntheticPendingAccountProposal(
      account,
      [
        {
          type: 'set_credit_limit',
          data: { tokenId: 1, amount: 9n },
        } as AccountTx,
      ],
      hubState.timestamp,
    );
    account.mempool = [
      {
        type: 'set_credit_limit',
        data: { tokenId: 1, amount: 11n },
      } as AccountTx,
    ];
    const lateInput = account.pendingAccountInput;
    if (!lateInput) throw new Error("AUDIT_PENDING_INPUT_MISSING");
    applyEntityAccountEnvelopeUpdate(env, userId, account, {
      type: "applyDisputeStarted",
      finality: {
        kind: "dispute_started", starterEntityId: userId,
        initialProofbodyHash: initialProof.proofBodyHash, initialNonce: 1, initialProposerIsLeft: false,
        disputeStartTimestamp: 1700000000, disputeTimeout: 1700000020,
        leftResponseSeconds: 10, rightResponseSeconds: 10, jNonce: 1,
        starterInitialArguments: "0x", starterCounterArguments: "0x",
        starterCounterProofCommitment: "0x" + "00".repeat(32), observedBlockNumber: 1,
      },
    });
    expect(account.status).toBe("disputed");
    expect(account.pendingFrame).toBeUndefined();
    expect(account.mempool).toEqual([]);
    expect(rejectFrozenAccountInput(hubState, account, lateInput, userId)).toBe(true);
    expect(account.pendingFrame).toBeUndefined();
    expect(account.mempool).toEqual([]);
    hubState.accounts.set(userId, account);
    const hashlock = `0x${'55'.repeat(32)}`;
    hubState.paybook.entries.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: userId,
      createdTimestamp: hubState.timestamp,
    });


    const result = await handleDisputeFinalize(
      hubState,
      {
        type: 'disputeFinalize',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    const finalization = result.newState.jBatchState?.batch.disputeFinalizations[0];
    const nextAccount = result.newState.accounts.get(userId)!;
    expect(finalization).toBeDefined();
    expect(finalization?.initialProofbodyHash).toBe(initialProof.proofBodyHash);
    expect(finalization?.finalProofbody).toEqual({
      ...initialProof.proofBodyStruct,
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
    });
    expect(finalization?.starterArguments).toBe('0x');
    expect(finalization?.otherArguments).toBe('0x');
    expect(readEntityFrameEventMessages(result.newState).some(msg => msg.includes('htlcAwaitingSecret'))).toBe(false);
    expect(nextAccount.pendingFrame).toBeUndefined();
    expect(nextAccount.mempool).toEqual([]);
    const duplicate = await handleDisputeFinalize(result.newState, {
      type: "disputeFinalize", data: { counterpartyEntityId: userId },
    }, env);
    expect(duplicate.newState.jBatchState?.batch.disputeFinalizations).toEqual([finalization]);
    expect(duplicate.newState.accounts.get(userId)?.pendingFrame).toBeUndefined();
    expect(duplicate.newState.accounts.get(userId)?.mempool).toEqual([]);

  });
});
