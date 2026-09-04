import { describe, expect, test } from 'bun:test';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';

import { ethers } from 'ethers';

import { applyEntityTx } from '../../../entity/tx/apply';

import { applyAccountTxToMutableReplica as applyAccountTx } from '../../../account/tx/apply';

import { proposeAccountFrame } from '../../../account/consensus/proposal/propose';

import { accountInputAck, accountInputProposal } from '../../../account/consensus/flush';

import { computeAccountStateRoot } from '../../../account/commitment/state-root';

import {
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
} from '../../../entity/tx/handlers/account/index';

import { applyEntityInput, mergeEntityInputs } from '../../../entity/consensus/index';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';

import {
  appendDefaultProposerCrossJMaterializations,
  entityTxContainsCrossJMaterialization,
  selectCrossJCommitPhaseTxs,
  selectCrossJOpeningAccountProposalTxs,
} from '../../../entity/transition/cross-j-proposer-materialization';

import { prepareLocallyAuthoredEntityTxs } from '../../../entity/command';

import {
  createEmptyEnv,
  handleInboundP2PEntityInputs,
  admitAtomicCrossJAccountInputs,
  submitCrossJurisdictionIntent,
  submitCrossJurisdictionSwap,
} from '../../../runtime';

import { buildCrossJurisdictionSwapSubmission } from '../../../runtime/j-submit/api';

import { hashHtlcSecret } from '../../../protocol/htlc/utils';

import type { AccountReplica, AccountTx, SwapOffer } from '../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityInput, EntityReplica } from '../../../entity/types';
import type { RuntimeEntityInputsEnvelope, RoutedEntityInput } from '../../../runtime/types';
import type { EntityTx } from '../../../types/entity-tx';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';

import { encodeBoard, generateLazyEntityId, hashBoard } from '../../../entity/factory';

import { createDefaultDelta } from '../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';

import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import { cloneEntityReplica } from '../../../entity/replica/replica-clone';

import { projectAccountDoc, projectEntityCoreDoc } from '../../../storage/read/projections';

import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../../../entity/tx/handlers/account-cross-j-followups';

import {
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute as buildPreparedCrossJurisdictionRouteCanonical,
  deriveCrossJurisdictionPrivateSeed,
  deriveCrossJurisdictionRouteHash,
  hasCrossJurisdictionCommittedFill,
  hashCrossJurisdictionCloseBinary,
  isCrossJurisdictionRouteTransitionAllowed,
  validateCrossJurisdictionFillProgress,
  withCanonicalCrossJurisdictionRouteHash as withCanonicalCrossJurisdictionRouteHashCanonical,
  withCrossJurisdictionCloseProofProgress,
  cloneCrossJurisdictionCloseProof,
  cloneCrossJurisdictionRoute,
} from '../../../extensions/cross-j/index';

const TEST_DISPUTE_CONFIG = { leftResponseSeconds: 10, rightResponseSeconds: 10 } as const;
type TestRouteInput = Omit<CrossJurisdictionSwapRoute, 'sourceDisputeConfig' | 'targetDisputeConfig'>;
// Explicit fixture policy; production rejects a route that omits either
// bilateral Account clock instead of supplying compatibility defaults.
const withFixtureDisputeConfig = (route: TestRouteInput): CrossJurisdictionSwapRoute => ({
  ...route,
  sourceDisputeConfig: TEST_DISPUTE_CONFIG,
  targetDisputeConfig: TEST_DISPUTE_CONFIG,
} as CrossJurisdictionSwapRoute);
const buildPreparedCrossJurisdictionRoute = (
  route: TestRouteInput,
  options: { runtimeSeed?: string; now: number },
): CrossJurisdictionSwapRoute => buildPreparedCrossJurisdictionRouteCanonical(
  withFixtureDisputeConfig(route),
  options,
);
const withCanonicalCrossJurisdictionRouteHash = (
  route: TestRouteInput,
): CrossJurisdictionSwapRoute => withCanonicalCrossJurisdictionRouteHashCanonical(
  withFixtureDisputeConfig(route),
);

const installSwapOffer = (account: AccountReplica, offer: SwapOffer): void => {
  putTestAccountSwapOffer(account, offer);
};

import {
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionRouteRemainingAmounts,
  mergeCrossJurisdictionBookAdmission,
  resolveCrossJurisdictionExecutionPriceTicks,
} from '../../../extensions/cross-j/orderbook';



import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
} from '../../../extensions/cross-j/market';

import { getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenIdsForJurisdiction } from '../../../account/utils';

import { normalizeEntitySwapTradingPairs } from '../../../runtime/swap-cmd/swap-pairs';

import { verifyHashLadderBinary } from '../../../protocol/htlc/hash-ladder';

import {
  getStaticSwapTokenDimensions,
  ORDERBOOK_PRICE_SCALE,
  SWAP_LOT_SCALE,
  quoteAmountAtPrice,
} from '../../../orderbook/types';

import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';


import { signEntityHashes } from '../../../hanko/signing';


import { queueCrossJurisdictionSourceDisputeFromTargetDispute } from '../../../entity/tx/j-events-htlc';

import { applyMergedEntityInputs } from '../../../runtime/mempool/entity-inputs';

import { crossBookQtyLots } from '../../../entity/tx/handlers/account/orderbook';

import {
  createRuntimeOutputRoutingDeps,
  registerEntityRuntimeHintWithDeps,
  selectPotentialCrossJAccountInputPairs,
  selectMatchedCrossJAccountInputPairs,
  validateInboundP2PEntityInputsEnvelope,
  type RuntimeEntityRoutingDeps,
} from '../../../runtime/delivery/topology/entity-routing';

import {
  buildPendingNetworkOutputs,
  buildRouteOutputKey,
  dispatchEntityOutputs,
  planEntityOutputs,
} from '../../../runtime/delivery/topology/output-routing';

import { deliveryAccepted, deliveryDeferred } from '../../../protocol/payments/delivery-result';

import {
  addReplica,
  addr,
  entity,
  installJurisdictions,
  jref,
  makeAccount,
  makeConfig,
  makeJurisdiction,
  makeState,
  partialBinary,
  getTestAccountForWrite,
  putTestAccountDelta,
  putTestAccountPull,
  putTestAccountSwapOffer,
  registerTestSigner,
  secret,
  prepareJEventInput,
} from '../../helpers/cross-j';

import { applyJEventRange, buildJEventRangeData } from '../../helpers/j-history';

import { buildLocalEntityProfile } from '../../../network/p2p/gossip/helper';


import { LIMITS } from '../../../config/constants';

import { getEffectiveEntityInputTxs } from '../../../entity/consensus/output/envelope';

import { assertRuntimeOutputAuthorization } from '../../../entity/auth/authorization';

const makeLocalCrossJRoutingDeps = (): RuntimeEntityRoutingDeps => ({
  ensureRuntimeInfrastructure: current => {
    if (!current.infrastructure) throw new Error('TEST_RUNTIME_STATE_REQUIRED');
    return current.infrastructure;
  },
  enqueueRuntimeInputs: () => {
    throw new Error('TEST_UNEXPECTED_RUNTIME_REQUEUE');
  },
  extractEntityId: replicaKey => replicaKey.split(':')[0] || '',
  hasLocalSignerForEntity: (current, entityId) =>
    Array.from(current.state.eReplicas.values()).some(replica => replica.entityId.toLowerCase() === entityId.toLowerCase()),
  hasLocalSignerForEntitySigner: (current, entityId, signerId) =>
    Array.from(current.state.eReplicas.values()).some(
      replica =>
        replica.entityId.toLowerCase() === entityId.toLowerCase() &&
        replica.signerId.toLowerCase() === signerId.toLowerCase(),
    ),
  resolveSoleLocalSignerForEntity: (current, entityId) => {
    const signers = Array.from(current.state.eReplicas.values())
      .filter(replica => replica.entityId.toLowerCase() === entityId.toLowerCase())
      .map(replica => replica.signerId);
    return signers.length === 1 ? signers[0]! : null;
  },
  getP2P: () => null,
});

describe('cross-jurisdiction hashledger swap', () => {
  test('close-proof cloning rejects non-canonical ratio and mode instead of rewriting evidence', () => {
    const valid = {
      orderId: 'clone-proof',
      routeHash: `0x${'11'.repeat(32)}`,
      sourcePullId: 'source-pull',
      targetPullId: 'target-pull',
      fillRatio: 1,
      cumulativeSourceAmount: 1n,
      cumulativeTargetAmount: 1n,
      binaryHash: `0x${'22'.repeat(32)}`,
      closeMode: 'partial_cancel_remainder' as const,
    };
    expect(cloneCrossJurisdictionCloseProof(valid)).toEqual(valid);
    expect(() => cloneCrossJurisdictionCloseProof({ ...valid, fillRatio: 65_536 }))
      .toThrow('CROSS_J_CLOSE_PROOF_FILL_RATIO_INVALID');
    expect(() => cloneCrossJurisdictionCloseProof({ ...valid, fillRatio: 1.5 }))
      .toThrow('CROSS_J_CLOSE_PROOF_FILL_RATIO_INVALID');
    expect(() => cloneCrossJurisdictionCloseProof({
      ...valid,
      closeMode: 'invalid_cancel' as never,
    })).toThrow('CROSS_J_CLOSE_PROOF_MODE_INVALID');
  });

  const makeTargetDisputeRouteSelectionFixture = (scenario: string) => {
    const env = createEmptyEnv(scenario);
    env.scenarioMode = true;
    env.state.timestamp = 50_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Ethereum', 1, '11', '12');
    const targetJ = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('51');
    const sourceHub = entity('52');
    const targetHub = entity('53');
    const targetUser = entity('54');
    const sourceSigner = addr('81');
    const targetSigner = addr('82');
    const state = makeState(targetUser, targetSigner, targetJ, targetHub);
    const sourceState = makeState(sourceUser, sourceSigner, sourceJ, sourceHub);
    addReplica(env, sourceState, sourceSigner);
    addReplica(env, state, targetSigner);
    const buildRoute = (
      orderId: string,
      options: {
        status?: 'resting' | 'settled' | 'cancelled' | 'expired' | 'failed';
        targetHub?: string;
        withoutTargetPull?: boolean;
      } = {},
    ) => {
      const route = {
        ...buildPreparedCrossJurisdictionRoute(
          {
            orderId,
            makerEntityId: sourceUser,
            hubEntityId: sourceHub,
            sourceSignerId: sourceSigner,
            source: {
              jurisdiction: jref(sourceJ),
              entityId: sourceUser,
              counterpartyEntityId: sourceHub,
              tokenId: 1,
              amount: 100n,
            },
            target: {
              jurisdiction: jref(targetJ),
              entityId: options.targetHub ?? targetHub,
              counterpartyEntityId: targetUser,
              tokenId: 1,
              amount: 90n,
            },
            status: 'resting',
            createdAt: env.state.timestamp,
            updatedAt: env.state.timestamp,
          },
          { runtimeSeed: 'test-seed', now: env.state.timestamp },
        ),
        status: options.status ?? 'resting',
      };
      if (options.withoutTargetPull) delete route.targetPull;
      return route;
    };
    return { env, state, sourceUser, sourceHub, targetHub, sourceSigner, buildRoute };
  };

  test('clear request reveals one source pull binary and can cancel remainder', async () => {
    const env = createEmptyEnv('cross-clear-delayed-seed');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const sourceHubSigner = addr('85');
    const targetHubSigner = addr('86');
    const targetUserSigner = addr('87');
    const state = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    const targetState = makeState(targetHub, targetHubSigner, base, targetUser);
    addReplica(env, state, sourceHubSigner);
    addReplica(env, targetState, targetHubSigner);
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-clear-delayed',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        sourceHubSignerId: sourceHubSigner,
        targetHubSignerId: targetHubSigner,
        targetSignerId: targetUserSigner,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 900n,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    targetState.crossJurisdictionSwaps?.set(route.orderId, cloneCrossJurisdictionRoute(route));
    const account = getTestAccountForWrite(state, sourceUser);
    const sourcePullAbsAmount =
      route.sourcePull!.signedAmount >= 0n ? route.sourcePull!.signedAmount : -route.sourcePull!.signedAmount;
    const sourcePullPayerIsLeft = route.sourcePull!.signedAmount < 0n;
    const sourceDelta = {
      ...(account.state.deltas.get(route.sourcePull!.tokenId) ?? createDefaultDelta(route.sourcePull!.tokenId)),
    };
    if (sourcePullPayerIsLeft) sourceDelta.leftHold = sourcePullAbsAmount;
    else sourceDelta.rightHold = sourcePullAbsAmount;
    putTestAccountDelta(account, sourceDelta);
    account.state.pulls = PersistentAccountStateMap.fromEntries('pulls', [
      [
        route.sourcePull!.pullId,
        {
          pullId: route.sourcePull!.pullId,
          tokenId: 1,
          amount: route.sourcePull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: route.sourcePull!.fullHash,
          partialRoot: route.sourcePull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(
            { ...route, status: 'clearing', clearingPolicy: 'cancel_and_clear' },
            'source',
          ),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);
    const targetAccount = getTestAccountForWrite(targetState, targetUser);
    const targetPullAbsAmount =
      route.targetPull!.signedAmount >= 0n ? route.targetPull!.signedAmount : -route.targetPull!.signedAmount;
    const targetPullPayerIsLeft = route.targetPull!.signedAmount < 0n;
    const targetDelta = {
      ...(targetAccount.state.deltas.get(route.targetPull!.tokenId) ?? createDefaultDelta(route.targetPull!.tokenId)),
    };
    if (targetPullPayerIsLeft) targetDelta.leftHold = targetPullAbsAmount;
    else targetDelta.rightHold = targetPullAbsAmount;
    putTestAccountDelta(targetAccount, targetDelta);
    targetAccount.state.pulls = PersistentAccountStateMap.fromEntries('pulls', [
      [
        route.targetPull!.pullId,
        {
          pullId: route.targetPull!.pullId,
          tokenId: route.targetPull!.tokenId,
          amount: route.targetPull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: route.targetPull!.fullHash,
          partialRoot: route.targetPull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });

    expect(result.accountTxs).toEqual([]);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
    const [clearMaterialization] = appendDefaultProposerCrossJMaterializations(
      env,
      {
        entityId: sourceHub,
        signerId: sourceHubSigner,
        entityEncPubKey: '',
        state: result.newState,
        mempool: [],
      } as EntityReplica,
      [],
    );
    expect(clearMaterialization?.type).toBe('materializeCrossJurisdictionClear');
    const sourceAccountRootBeforeMaterialization = computeAccountStateRoot(result.newState.accounts.get(sourceUser)!.state);
    const materialized = await applyEntityTx(env, result.newState, clearMaterialization!);
    expect(materialized.accountTxs?.map(op => op.tx.type)).toEqual(['cross_pull_close']);
    expect(materialized.accountTxs?.[0]?.accountId).toBe(sourceUser);
    expect((materialized.accountTxs?.[0]?.tx as any).data.binary).toMatch(/^0x/);
    expect((materialized.accountTxs?.[0]?.tx as any).data.proof.fillRatio).toBe(32_768);
    const targetCloseOutput = materialized.outputs.find(output => output.entityId === targetHub);
    expect(targetCloseOutput).toMatchObject({
      entityId: targetHub,
      signerId: targetHubSigner,
    });
    expect(targetCloseOutput?.entityTxs?.map(tx => tx.type)).toEqual(['crossPullClose']);
    expect(materialized.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clearing');
    expect(computeAccountStateRoot(materialized.newState.accounts.get(sourceUser)!.state)).toBe(
      sourceAccountRootBeforeMaterialization,
    );
    const targetCloseCommand = targetCloseOutput!.entityTxs![0]!;
    const stagedTargetClose = await applyEntityTx(env, targetState, targetCloseCommand);
    expect(stagedTargetClose.accountTxs?.map(op => op.tx.type)).toEqual(['cross_pull_close']);
    expect(stagedTargetClose.accountTxs?.[0]?.accountId).toBe(targetUser);
    expect(stagedTargetClose.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clearing');
    const byTargetHub = targetHub.toLowerCase() < targetUser.toLowerCase();
    const targetCloseResult = await applyAccountTx(
      getTestAccountForWrite(stagedTargetClose.newState, targetUser),
      stagedTargetClose.accountTxs![0]!.tx,
      byTargetHub,
      env.state.timestamp,
      1,
    );
    expect(targetCloseResult.ok, targetCloseResult.ok ? undefined : targetCloseResult.rejection.message).toBe(true);
    expect(stagedTargetClose.newState.accounts.get(targetUser)!.state.pulls?.has(route.targetPull!.pullId)).toBe(false);

    const accountAfterClear = getTestAccountForWrite(materialized.newState, sourceUser);
    const invalidProposalAccount = forkAccountReplicaShell(accountAfterClear);
    const validClose = materialized.accountTxs![0]!.tx;
    if (validClose.type !== 'cross_pull_close') throw new Error('TEST_CROSS_J_CLOSE_REQUIRED');
    const invalidClose: Extract<AccountTx, { type: 'cross_pull_close' }> = {
      ...validClose,
      data: {
        ...validClose.data,
        binary: '0x00',
        proof: {
          ...validClose.data.proof,
          binaryHash: hashCrossJurisdictionCloseBinary('0x00'),
        },
      },
    };
    invalidProposalAccount.mempool = [invalidClose];
    await expect(
      proposeAccountFrame(createAccountConsensusContext(env), invalidProposalAccount, env.state.timestamp, state.lastFinalizedJHeight),
    ).rejects.toThrow('CROSS_J_PULL_CLOSE_PROPOSAL_FAILED');
    expect(invalidProposalAccount.mempool).toEqual([invalidClose]);
    expect(invalidProposalAccount.pendingFrame).toBeUndefined();

    const bySourceHub = sourceHub.toLowerCase() < sourceUser.toLowerCase();
    const resolveResult = await applyAccountTx(
      accountAfterClear,
      materialized.accountTxs![0]!.tx,
      bySourceHub,
      env.state.timestamp,
      1,
    );
    expect(resolveResult.ok, resolveResult.ok ? undefined : resolveResult.rejection.message).toBe(true);
    expect(accountAfterClear.state.pulls?.has(route.sourcePull!.pullId)).toBe(false);
    const releasedDelta = accountAfterClear.state.deltas.get(route.sourcePull!.tokenId)!;
    expect(sourcePullPayerIsLeft ? releasedDelta.leftHold : releasedDelta.rightHold).toBe(0n);
  });

  test('target cross_pull_close rejects a lower reveal binary than the proof it carries', async () => {
    const env = createEmptyEnv('cross-close-lower-ratio-reject');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('86');
    const sourceHub = entity('87');
    const targetHub = entity('88');
    const targetUser = entity('89');
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-close-lower-ratio-reject',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 900n,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const highRatio = 0x8000;
    const lowRatio = 0x4000;
    const highRoute = {
      ...prepared,
      status: 'clearing' as const,
      fillSeq: 1,
      cumulativeFillRatio: highRatio,
      claimedRatio: highRatio,
      fillNumerator: BigInt(highRatio),
      fillDenominator: 65_535n,
      filledSourceAmount: (BigInt(prepared.source.amount) * BigInt(highRatio)) / 65_535n,
      filledTargetAmount: (BigInt(prepared.target.amount) * BigInt(highRatio)) / 65_535n,
      sourceClaimed: (BigInt(prepared.source.amount) * BigInt(highRatio)) / 65_535n,
      targetClaimed: (BigInt(prepared.target.amount) * BigInt(highRatio)) / 65_535n,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    const lowRoute = {
      ...highRoute,
      cumulativeFillRatio: lowRatio,
      claimedRatio: lowRatio,
      fillNumerator: BigInt(lowRatio),
      fillDenominator: 65_535n,
      filledSourceAmount: (BigInt(prepared.source.amount) * BigInt(lowRatio)) / 65_535n,
      filledTargetAmount: (BigInt(prepared.target.amount) * BigInt(lowRatio)) / 65_535n,
      sourceClaimed: (BigInt(prepared.source.amount) * BigInt(lowRatio)) / 65_535n,
      targetClaimed: (BigInt(prepared.target.amount) * BigInt(lowRatio)) / 65_535n,
    };
    const privateSeed = deriveCrossJurisdictionPrivateSeed(env.runtimeSeed!, highRoute);
    const highBinary = buildCrossJurisdictionPullReveal(highRoute, highRatio, privateSeed).binary;
    const lowBinary = buildCrossJurisdictionPullReveal(lowRoute, lowRatio, privateSeed).binary;
    const highProof = buildCrossJurisdictionCloseProof(highRoute, highBinary);
    const account = makeAccount(targetUser, targetHub);
    const targetDelta = {
      ...(account.state.deltas.get(highRoute.targetPull!.tokenId) ?? createDefaultDelta(highRoute.targetPull!.tokenId)),
    };
    const targetAbsAmount =
      highRoute.targetPull!.signedAmount >= 0n
        ? highRoute.targetPull!.signedAmount
        : -highRoute.targetPull!.signedAmount;
    if (highRoute.targetPull!.signedAmount > 0n) targetDelta.rightHold = targetAbsAmount;
    else targetDelta.leftHold = targetAbsAmount;
    putTestAccountDelta(account, targetDelta);
    account.state.pulls = PersistentAccountStateMap.fromEntries('pulls', [
      [
        highRoute.targetPull!.pullId,
        {
          pullId: highRoute.targetPull!.pullId,
          tokenId: highRoute.targetPull!.tokenId,
          amount: highRoute.targetPull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: highRoute.targetPull!.fullHash,
          partialRoot: highRoute.targetPull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(highRoute, 'target'),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);
    const byTargetUser = targetUser.toLowerCase() < targetHub.toLowerCase();

    const lowerBinaryResult = await applyAccountTx(
      account,
      {
        type: 'cross_pull_close',
        data: { pullId: highRoute.targetPull!.pullId, binary: lowBinary, proof: highProof },
      },
      byTargetUser,
      env.state.timestamp,
      2,
    );
    expect(lowerBinaryResult.ok).toBe(false);
    expect(lowerBinaryResult.ok ? undefined : lowerBinaryResult.rejection.message).toContain('binary');
    expect(account.state.pulls?.has(highRoute.targetPull!.pullId)).toBe(true);
  });

  test('target cross_pull_close rejects user-authored economics before target binding has fill progress', async () => {
    const env = createEmptyEnv('cross-close-forged-target-economics');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('7a');
    const sourceHub = entity('7b');
    const targetHub = entity('7c');
    const targetUser = entity('7d');
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-close-forged-target-economics',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 900n,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      {
        runtimeSeed: env.runtimeSeed,
        now: env.state.timestamp,
      },
    );
    const fillRatio = 0x8000;
    const filledRoute = {
      ...prepared,
      status: 'clearing' as const,
      cumulativeFillRatio: fillRatio,
      claimedRatio: fillRatio,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    const privateSeed = deriveCrossJurisdictionPrivateSeed(env.runtimeSeed!, prepared);
    const binary = buildCrossJurisdictionPullReveal(prepared, fillRatio, privateSeed).binary;
    // The proof is economically consistent (chain-proportional for the
    // revealed ratio), so the rejection must come from the authorization gate:
    // a close authored by the user side is never accepted, whatever it pays.
    const forgedProof = buildCrossJurisdictionCloseProof(filledRoute, binary);
    const account = makeAccount(targetUser, targetHub);
    const targetPull = prepared.targetPull!;
    const targetDelta = { ...(account.state.deltas.get(targetPull.tokenId) ?? createDefaultDelta(targetPull.tokenId)) };
    const targetAbsAmount = targetPull.signedAmount >= 0n ? targetPull.signedAmount : -targetPull.signedAmount;
    if (targetPull.signedAmount > 0n) targetDelta.rightHold = targetAbsAmount;
    else targetDelta.leftHold = targetAbsAmount;
    putTestAccountDelta(account, targetDelta);
    account.state.pulls = PersistentAccountStateMap.fromEntries('pulls', [
      [
        targetPull.pullId,
        {
          pullId: targetPull.pullId,
          tokenId: targetPull.tokenId,
          amount: targetPull.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: targetPull.fullHash,
          partialRoot: targetPull.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(prepared, 'target'),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);
    const before = computeAccountStateRoot(account.state);
    const result = await applyAccountTx(
      account,
      {
        type: 'cross_pull_close',
        data: {
          pullId: targetPull.pullId,
          binary,
          proof: forgedProof,
        },
      },
      targetUser.toLowerCase() < targetHub.toLowerCase(),
      env.state.timestamp,
      1,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.rejection.message).toContain('Only the target Hub');
    expect(computeAccountStateRoot(account.state)).toBe(before);
    expect(account.state.pulls?.has(targetPull.pullId)).toBe(true);
  });

  test('source cross_pull_close cannot invent fill progress or a cumulative debit', async () => {
    const env = createEmptyEnv('cross-close-forged-source-economics');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('6a');
    const sourceHub = entity('6b');
    const targetHub = entity('6c');
    const targetUser = entity('6d');
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-close-forged-source-economics',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 900n,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const fillRatio = 0x8000;
    const privateSeed = deriveCrossJurisdictionPrivateSeed(env.runtimeSeed!, prepared);
    const binary = buildCrossJurisdictionPullReveal(prepared, fillRatio, privateSeed).binary;
    const honestProof = buildCrossJurisdictionCloseProof({
      ...prepared,
      status: 'clearing',
      cumulativeFillRatio: fillRatio,
      claimedRatio: fillRatio,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    }, binary);
    const account = makeAccount(sourceUser, sourceHub);
    const sourcePull = prepared.sourcePull!;
    const delta = { ...(account.state.deltas.get(sourcePull.tokenId) ?? createDefaultDelta(sourcePull.tokenId)) };
    const held = sourcePull.signedAmount >= 0n ? sourcePull.signedAmount : -sourcePull.signedAmount;
    if (sourcePull.signedAmount > 0n) delta.rightHold = held;
    else delta.leftHold = held;
    putTestAccountDelta(account, delta);
    account.state.pulls = PersistentAccountStateMap.fromEntries('pulls', [
      [sourcePull.pullId, {
        pullId: sourcePull.pullId,
        tokenId: sourcePull.tokenId,
        amount: sourcePull.signedAmount,
        claimedRatio: 0,
        claimedAmount: 0n,
        fullHash: sourcePull.fullHash,
        partialRoot: sourcePull.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(prepared, 'source'),
        createdHeight: 0,
        createdTimestamp: env.state.timestamp,
      }],
    ]);
    const initialRoot = computeAccountStateRoot(account.state);
    const uncommittedResult = await applyAccountTx(
      account,
      {
        type: 'cross_pull_close',
        data: {
          pullId: sourcePull.pullId,
          binary,
          proof: { ...honestProof, cumulativeSourceAmount: 999n },
        },
      },
      sourceHub.toLowerCase() < sourceUser.toLowerCase(),
      env.state.timestamp,
      1,
    );

    expect(uncommittedResult.ok).toBe(false);
    expect(uncommittedResult.ok ? undefined : uncommittedResult.rejection.message).toContain('chain-proportional');
    expect(computeAccountStateRoot(account.state)).toBe(initialRoot);
    expect(account.state.pulls?.has(sourcePull.pullId)).toBe(true);

    const committedAccount = forkAccountReplicaShell(account);
    const committedPull = committedAccount.state.pulls!.get(sourcePull.pullId)!;
    putTestAccountPull(committedAccount, sourcePull.pullId, {
      ...committedPull,
      crossJurisdiction: {
        ...committedPull.crossJurisdiction!,
        status: 'clearing',
        cumulativeFillRatio: fillRatio,
        fillNumerator: 1n,
        fillDenominator: 2n,
        filledSourceAmount: 500n,
        filledTargetAmount: 450n,
      },
    });
    const committedRoot = computeAccountStateRoot(committedAccount.state);
    const forgedAmountResult = await applyAccountTx(
      committedAccount,
      {
        type: 'cross_pull_close',
        data: {
          pullId: sourcePull.pullId,
          binary,
          proof: { ...honestProof, cumulativeSourceAmount: 999n },
        },
      },
      sourceHub.toLowerCase() < sourceUser.toLowerCase(),
      env.state.timestamp,
      2,
    );

    expect(forgedAmountResult.ok).toBe(false);
    expect(forgedAmountResult.ok ? undefined : forgedAmountResult.rejection.message).toContain('source amount 999 != chain-proportional 500');
    expect(computeAccountStateRoot(committedAccount.state)).toBe(committedRoot);

    const canonicalAmountResult = await applyAccountTx(
      committedAccount,
      {
        type: 'cross_pull_close',
        data: { pullId: sourcePull.pullId, binary, proof: honestProof },
      },
      sourceHub.toLowerCase() < sourceUser.toLowerCase(),
      env.state.timestamp,
      3,
    );
    expect(canonicalAmountResult.ok, canonicalAmountResult.ok ? undefined : canonicalAmountResult.rejection.message).toBe(true);
    expect(committedAccount.state.pulls?.has(sourcePull.pullId)).toBe(false);
  });

  test('source user routes cross-j clear through the source Account', async () => {
    const env = createEmptyEnv('cross-clear-source-account');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const state = makeState(sourceUser, addr('85'), eth, sourceHub);
    await expect(
      applyEntityTx(env, state, {
        type: 'requestCrossJurisdictionClear',
        data: { orderId: 'missing-cross-j-route', cancelRemainder: true },
      }),
    ).rejects.toThrow('CROSS_J_CLEAR_ROUTE_MISSING:missing-cross-j-route');
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-clear-source-account',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 900n,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const restingRoute = {
      ...prepared,
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(restingRoute.orderId, restingRoute);
    const account = getTestAccountForWrite(state, sourceHub);
    putTestAccountSwapOffer(account, {
      offerId: restingRoute.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      maxFee: 0n,
      minNetReceive: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...restingRoute },
    });

    const ignored = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: restingRoute.orderId, cancelRemainder: false },
    });
    expect(ignored.accountTxs).toEqual([]);
    expect(ignored.newState.crossJurisdictionSwaps?.get(restingRoute.orderId)?.status).toBe('resting');

    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    installSwapOffer(getTestAccountForWrite(state, sourceHub), {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(1, 1),
      giveTokenId: 1,
      giveAmount: 500n,
      wantTokenId: 1,
      wantAmount: 450n,
      maxFee: 0n,
      minNetReceive: 450n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });

    expect(result.outputs).toEqual([]);
    expect(result.accountTxs).toEqual([
      {
        accountId: sourceHub,
        tx: { type: 'swap_cancel_request', data: { offerId: route.orderId } },
      },
    ]);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
  });
});
