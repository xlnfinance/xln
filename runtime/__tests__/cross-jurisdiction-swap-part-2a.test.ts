import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../state-helpers';

import { ethers } from 'ethers';

import { applyEntityTx } from '../entity/tx/apply';

import { applyAccountTx } from '../account/tx/apply';

import { proposeAccountFrame } from '../account/consensus/propose';

import { accountInputAck, accountInputProposal } from '../account/consensus/flush';

import { handlePullCancel } from '../account/tx/handlers/pull';

import { computeAccountStateRoot } from '../account/state-root';

import {
  collectCommittedCrossJurisdictionCancelAcks,
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
} from '../entity/tx/handlers/account';

import { applyEntityInput, mergeEntityInputs } from '../entity/consensus/index';

import {
  appendDefaultProposerCrossJMaterializations,
  entityTxContainsCrossJMaterialization,
  selectCrossJCommitPhaseTxs,
  selectCrossJOpeningAccountProposalTxs,
} from '../entity/cross-j-proposer-materialization';

import { prepareLocallyAuthoredEntityTxs } from '../entity/command';

import {
  createEmptyEnv,
  handleInboundP2PEntityInputs,
  prepareAtomicCrossJAccountInputs,
  submitCrossJurisdictionIntent,
  submitCrossJurisdictionSwap,
} from '../runtime';

import { buildCrossJurisdictionSwapSubmission } from '../runtime/jurisdiction-api';

import { hashHtlcSecret } from '../protocol/htlc/utils';

import type {
  AccountTx,
  CrossJurisdictionSwapRoute,
  EntityInput,
  EntityReplica,
  EntityTx,
  JurisdictionEvent,
  RuntimeEntityInputsEnvelope,
  RoutedEntityInput,
} from '../types';

import { generateLazyEntityId } from '../entity/factory';

import { createDefaultDelta } from '../validation-utils';

import { cloneAccountState, cloneEntityReplica, cloneEntityState } from '../state-helpers';

import { projectAccountDoc, projectEntityCoreDoc } from '../storage/projections';

import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../entity/tx/handlers/account-cross-j-followups';

import {
  CROSS_J_TARGET_REVEAL_SAFETY_MS,
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
  deriveCrossJurisdictionRouteHash,
  hasCrossJurisdictionCommittedFill,
  hashCrossJurisdictionCloseBinary,
  isCrossJurisdictionRouteTransitionAllowed,
  projectCrossJurisdictionQuantizedClaim,
  validateCrossJurisdictionFillProgress,
  validateCrossJurisdictionQuantization,
  withCanonicalCrossJurisdictionRouteHash,
  withCrossJurisdictionClaimProgress,
  withCrossJurisdictionCloseProofProgress,
  cloneCrossJurisdictionRoute,
} from '../extensions/cross-j/index';

import {
  buildCrossJurisdictionCancelAck,
  buildCrossJurisdictionFillAck,
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionRouteRemainingAmounts,
  mergeCrossJurisdictionBookAdmission,
  resolveCrossJurisdictionExecutionPriceTicks,
} from '../extensions/cross-j/orderbook';

import { buildCrossJurisdictionPendingFillFromAck } from '../extensions/cross-j/fill-ack';

import { committedCrossJSourceDisputeDelayMs } from '../extensions/cross-j/prepared-route';

import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
} from '../extensions/cross-j/market';

import { getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenIdsForJurisdiction } from '../account/utils';

import { normalizeEntitySwapTradingPairs } from '../runtime/swap-pairs';

import { verifyHashLadderBinary } from '../protocol/htlc/hash-ladder';

import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE, quoteAmountAtPrice } from '../orderbook/types';

import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../protocol/dispute/proof-builder';

import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../protocol/dispute/arguments';

import { signEntityHashes } from '../hanko/signing';

import { hashCertifiedEntityOutputSemantic } from '../entity/consensus/output-certification';

import { queueCrossJurisdictionSourceDisputeFromTargetDispute } from '../entity/tx/j-events-htlc';

import { applyMergedEntityInputs } from '../runtime/entity-inputs';

import { crossBookQtyLots } from '../entity/tx/handlers/account/orderbook-matching-cross';

import {
  createRuntimeOutputRoutingDeps,
  registerEntityRuntimeHintWithDeps,
  selectPotentialCrossJAccountInputPairs,
  selectMatchedCrossJAccountInputPairs,
  validateInboundP2PEntityInputsEnvelope,
  type RuntimeEntityRoutingDeps,
} from '../runtime/entity-routing';

import {
  buildPendingNetworkOutputs,
  buildRouteOutputKey,
  dispatchEntityOutputs,
  planEntityOutputs,
  pruneReceiptedReliableOutputs,
  rescheduleDeferredOutputs,
  splitPendingOutputsByRetryWindow,
} from '../runtime/output-routing';

import { deliveryAccepted, deliveryDeferred } from '../protocol/payments/delivery-result';

import {
  addReplica,
  addr,
  entity,
  installJurisdictions,
  jref,
  makeAccount,
  makeJurisdiction,
  makeState,
  partialBinary,
  registerTestSigner,
  secret,
  prepareJEventInput,
} from './helpers/cross-j';

import { applyJEventRange, buildJEventRangeData } from './helpers/j-history';

import { buildLocalEntityProfile } from '../networking/gossip-helper';

import { collectLocalProfileEncryptionAnnouncements } from '../networking/profile-encryption';

import { LIMITS } from '../constants';

import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';

import { assertRuntimeOutputAuthorization } from '../entity/authorization';

import { cloneIsolatedRoutedEntityInputs } from '../protocol/runtime-input-clone';

import { createDueScheduledWakeInputs } from '../runtime/scheduled-wake';

import { ACCOUNT_PENDING_RESEND_AFTER_MS } from '../entity/scheduler';

const makeLocalCrossJRoutingDeps = (): RuntimeEntityRoutingDeps => ({
  ensureRuntimeState: current => {
    if (!current.runtimeState) throw new Error('TEST_RUNTIME_STATE_REQUIRED');
    return current.runtimeState;
  },
  enqueueRuntimeInputs: () => {
    throw new Error('TEST_UNEXPECTED_RUNTIME_REQUEUE');
  },
  extractEntityId: replicaKey => replicaKey.split(':')[0] || '',
  hasLocalSignerForEntity: (current, entityId) =>
    Array.from(current.eReplicas.values()).some(replica => replica.entityId.toLowerCase() === entityId.toLowerCase()),
  hasLocalSignerForEntitySigner: (current, entityId, signerId) =>
    Array.from(current.eReplicas.values()).some(
      replica =>
        replica.entityId.toLowerCase() === entityId.toLowerCase() &&
        replica.signerId.toLowerCase() === signerId.toLowerCase(),
    ),
  resolveSoleLocalSignerForEntity: (current, entityId) => {
    const signers = Array.from(current.eReplicas.values())
      .filter(replica => replica.entityId.toLowerCase() === entityId.toLowerCase())
      .map(replica => replica.signerId);
    return signers.length === 1 ? signers[0]! : null;
  },
  getP2P: () => null,
});

describe('cross-jurisdiction hashledger swap', () => {
  const makeTargetDisputeRouteSelectionFixture = (scenario: string) => {
    const env = createEmptyEnv(scenario);
    env.scenarioMode = true;
    env.timestamp = 50_000;
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
            createdAt: env.timestamp,
            updatedAt: env.timestamp,
          },
          { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp },
        ),
        status: options.status ?? 'resting',
      };
      if (options.withoutTargetPull) delete route.targetPull;
      return route;
    };
    return { env, state, sourceUser, sourceHub, targetHub, sourceSigner, buildRoute };
  };

  test('swap_offer created event carries only public cross-j route', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('d1');
    const sourceHub = entity('d2');
    const targetHub = entity('d3');
    const targetUser = entity('d4');
    const account = makeAccount(sourceHub, sourceUser);
    const preparedRoute = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-public-created-event',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000_000_000_000_000_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: 1_000_000_000_000_000_000n,
        },
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-public-created-event', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    const route = {
      ...preparedRoute,
      status: 'resting' as const,
    };
    account.pulls ??= new Map();
    account.pulls.set(route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: route.sourcePull!.tokenId,
      amount: route.sourcePull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
      fullHash: route.sourcePull!.fullHash,
      partialRoot: route.sourcePull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
      createdHeight: 1,
      createdTimestamp: 1_000,
    });
    const result = await applyAccountTx(
      account,
      {
        type: 'swap_offer',
        data: {
          offerId: route.orderId,
          giveTokenId: route.source.tokenId,
          giveAmount: route.source.amount,
          wantTokenId: route.target.tokenId,
          wantAmount: route.target.amount,
          crossJurisdiction: route,
        },
      },
      account.leftEntity === sourceUser,
      1_000,
      1,
    );

    expect(result.success).toBe(true);
    expect(result.swapOfferCreated?.crossJurisdiction).toEqual(route);
    expect(account.swapOffers.get(route.orderId)?.crossJurisdiction).toEqual(route);
  });

  test('account layer rejects source pull reveal before clear', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('e1');
    const sourceHub = entity('e2');
    const targetHub = entity('e3');
    const targetUser = entity('e4');
    const account = makeAccount(sourceHub, sourceUser);
    const route = {
      ...buildPreparedCrossJurisdictionRoute(
        {
          orderId: 'cross-early-source-reveal',
          makerEntityId: sourceUser,
          hubEntityId: sourceHub,
          source: {
            jurisdiction: jref(eth),
            entityId: sourceUser,
            counterpartyEntityId: sourceHub,
            tokenId: 1,
            amount: 1_000_000_000_000_000_000n,
          },
          target: {
            jurisdiction: jref(base),
            entityId: targetHub,
            counterpartyEntityId: targetUser,
            tokenId: 2,
            amount: 1_000_000_000_000_000_000n,
          },
          status: 'resting',
          createdAt: 1_000,
          updatedAt: 1_000,
          expiresAt: 61_000,
        },
        { runtimeSeed: 'cross-early-source-reveal', sourceDisputeDelayMs: 5_000, now: 1_000 },
      ),
      status: 'resting' as const,
    };
    account.pulls ??= new Map();
    account.pulls.set(route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: route.sourcePull!.tokenId,
      amount: route.sourcePull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
      fullHash: route.sourcePull!.fullHash,
      partialRoot: route.sourcePull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
      createdHeight: 1,
      createdTimestamp: 1_000,
    });
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: route.source.tokenId,
      giveAmount: route.source.amount,
      wantTokenId: route.target.tokenId,
      wantAmount: route.target.amount,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 1,
      crossJurisdiction: route,
    });
    const before = account.deltas.get(route.source.tokenId)!.offdelta;
    const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-early-source-reveal', route);
    const binary = buildCrossJurisdictionPullReveal(route, 65_535, privateSeed).binary;
    const result = await applyAccountTx(
      account,
      {
        type: 'pull_resolve',
        data: { pullId: route.sourcePull!.pullId, binary },
      },
      route.sourcePull!.signedAmount > 0n,
      2_000,
      1,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('CROSS_J_SOURCE_PULL_RESOLVE_BEFORE_CLEAR');
    expect(account.deltas.get(route.source.tokenId)!.offdelta).toBe(before);
  });

  test('canonical route hash binds cross-j economic terms and terminal states reject overwrite', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('61');
    const sourceHub = entity('62');
    const targetHub = entity('63');
    const targetUser = entity('64');
    const signer = addr('65');
    const baseRoute = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'route-hash-test',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 90n,
      },
      priceTicks: 2500n,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    });
    const { routeHash: _routeHash, ...baseRouteWithoutHash } = baseRoute;
    const changedTerms = withCanonicalCrossJurisdictionRouteHash({
      ...baseRouteWithoutHash,
      target: { ...baseRoute.target, amount: 91n },
    });
    expect(changedTerms.routeHash).not.toBe(baseRoute.routeHash);

    const existingState = makeState(targetUser, signer, base, targetHub);
    existingState.crossJurisdictionSwaps?.set(baseRoute.orderId, { ...baseRoute, status: 'settled' });
    const env = createEmptyEnv('cross-terminal-overwrite');
    env.timestamp = 10_000;
    installJurisdictions(env, eth, base);
    const result = await applyEntityTx(env, existingState, {
      type: 'registerCrossJurisdictionSwap',
      data: { route: { ...baseRoute, status: 'target_prepared' } },
    } as any);

    expect(result.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.status).toBe('settled');
    expect(readEntityFrameEventMessages(result.newState).some(message => message.includes('terminal state settled'))).toBe(true);
  });

  test('route hash binds domain, settlement policy, and time policy', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('6a');
    const sourceHub = entity('6b');
    const targetHub = entity('6c');
    const targetUser = entity('6d');
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'route-policy-hash-test',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000_000n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 900_000n,
      },
      settlementPolicy: { roundingMode: 'uint16_ceil', maxSourceDust: 16n, maxTargetDust: 14n },
      priceTicks: 2500n,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    });
    const { routeHash: _routeHash, ...withoutHash } = route;

    expect(
      withCanonicalCrossJurisdictionRouteHash({
        ...withoutHash,
        domain: { ...route.domain!, sourceAssetRef: `${jref(eth)}:external:1` },
      }).routeHash,
    ).not.toBe(route.routeHash);
    expect(
      withCanonicalCrossJurisdictionRouteHash({
        ...withoutHash,
        settlementPolicy: { ...route.settlementPolicy!, maxSourceDust: route.settlementPolicy!.maxSourceDust + 1n },
      }).routeHash,
    ).not.toBe(route.routeHash);
    expect(
      withCanonicalCrossJurisdictionRouteHash({
        ...withoutHash,
        timePolicy: { ...route.timePolicy!, runtimeExpiresAtMs: route.timePolicy!.runtimeExpiresAtMs + 1 },
      }).routeHash,
    ).not.toBe(route.routeHash);
  });

  test('cross-j rejects non-collateralized risk modes until an executable policy exists', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    expect(() =>
      withCanonicalCrossJurisdictionRouteHash({
        orderId: 'route-risk-mode-test',
        makerEntityId: entity('6e'),
        hubEntityId: entity('6f'),
        source: {
          jurisdiction: jref(eth),
          entityId: entity('70'),
          counterpartyEntityId: entity('71'),
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: entity('72'),
          counterpartyEntityId: entity('73'),
          tokenId: 2,
          amount: 900n,
        },
        riskMode: 'credit_line',
        status: 'intent',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      }),
    ).toThrow('CROSS_J_RISK_MODE_UNSUPPORTED');
  });

  test('cross-j quantization policy rejects fills whose uint16 projection exceeds the dust budget', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const fillNumerator = 1n;
    const fillDenominator = 7n;
    const cumulativeFillRatio = 9_363;
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'route-quantization-policy-test',
      makerEntityId: entity('74'),
      hubEntityId: entity('75'),
      source: {
        jurisdiction: jref(eth),
        entityId: entity('76'),
        counterpartyEntityId: entity('77'),
        tokenId: 1,
        amount: 1_000_000n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: entity('78'),
        counterpartyEntityId: entity('79'),
        tokenId: 2,
        amount: 1_000_000n,
      },
      settlementPolicy: { roundingMode: 'uint16_ceil', maxSourceDust: 0n, maxTargetDust: 0n },
      status: 'intent',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    });
    const projected = projectCrossJurisdictionQuantizedClaim(route.source.amount, {
      cumulativeFillRatio,
      fillNumerator,
      fillDenominator,
    });

    expect(projected.exactClaim).toBe(142_857n);
    expect(projected.quantizedClaim).toBeGreaterThan(projected.exactClaim);
    expect(
      validateCrossJurisdictionQuantization(route, {
        cumulativeFillRatio,
        fillNumerator,
        fillDenominator,
        cumulativeSourceAmount: projected.exactClaim,
        cumulativeTargetAmount: projected.exactClaim,
      }),
    ).toContain('source quantization dust');
    expect(() =>
      projectCrossJurisdictionQuantizedClaim(route.source.amount, {
        cumulativeFillRatio,
        fillNumerator,
      }),
    ).toThrow('CROSS_J_EXACT_FILL_RATIO_INCOMPLETE');
    expect(() =>
      projectCrossJurisdictionQuantizedClaim(route.source.amount, {
        cumulativeFillRatio,
        fillNumerator: fillDenominator + 1n,
        fillDenominator,
        orderId: route.orderId,
      }),
    ).toThrow(`CROSS_J_EXACT_FILL_RATIO_INVALID:${route.orderId}`);
    const invalidProgress = validateCrossJurisdictionFillProgress(route, {
      cumulativeFillRatio,
      fillNumerator,
    });
    expect(invalidProgress.ok).toBe(false);
    if (!invalidProgress.ok) {
      expect(invalidProgress.error).toBe(`CROSS_J_EXACT_FILL_RATIO_INCOMPLETE:${route.orderId}`);
    }
  });

  test('cross-j register enforces participant and explicit lifecycle transitions', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('71');
    const sourceHub = entity('72');
    const targetHub = entity('73');
    const targetUser = entity('74');
    const signer = addr('75');
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-register-fsm',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 90n,
      },
      priceTicks: 2500n,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    });

    const targetState = makeState(targetUser, signer, base, targetHub);
    targetState.crossJurisdictionSwaps?.set(route.orderId, route);
    const transitionEnv = createEmptyEnv('cross-register-fsm');
    installJurisdictions(transitionEnv, eth, base);
    const invalidTransition = await applyEntityTx(transitionEnv, targetState, {
      type: 'registerCrossJurisdictionSwap',
      data: { route: { ...route, status: 'settled' } },
    } as any);
    expect(invalidTransition.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('resting');
    expect(
      readEntityFrameEventMessages(invalidTransition.newState).some(message => message.includes('invalid transition resting->settled')),
    ).toBe(true);

    const outsiderState = makeState(entity('76'), signer, base, targetHub);
    const outsiderEnv = createEmptyEnv('cross-register-outsider');
    installJurisdictions(outsiderEnv, eth, base);
    const nonParticipant = await applyEntityTx(outsiderEnv, outsiderState, {
      type: 'registerCrossJurisdictionSwap',
      data: { route: { ...route, status: 'target_prepared' } },
    } as any);
    expect(nonParticipant.newState.crossJurisdictionSwaps?.has(route.orderId)).toBe(false);
    expect(readEntityFrameEventMessages(nonParticipant.newState).some(message => message.includes('non-participant entity'))).toBe(true);
  });

  test('route hash ignores mutable clearing policy but still binds economic terms', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('66');
    const sourceHub = entity('67');
    const targetHub = entity('68');
    const targetUser = entity('69');
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'route-clearing-policy-mutable',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 90n,
      },
      priceTicks: 2500n,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    });

    const clearingRoute = {
      ...route,
      status: 'clearing' as const,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    expect(withCanonicalCrossJurisdictionRouteHash(clearingRoute).routeHash).toBe(route.routeHash);

    const changedTerms = { ...route, target: { ...route.target, amount: 91n } };
    expect(() => withCanonicalCrossJurisdictionRouteHash(changedTerms)).toThrow(/CROSS_J_ROUTE_HASH_MISMATCH/);
  });

  test('partial cross-j fill ack is delayed-clearing and keeps order/pulls open', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('71');
    const sourceHub = entity('72');
    const targetHub = entity('73');
    const targetUser = entity('74');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-partial-delayed',
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
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-partial-delayed-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });
    account.pulls = new Map([
      [
        route.sourcePull!.pullId,
        {
          pullId: route.sourcePull!.pullId,
          tokenId: 1,
          amount: route.sourcePull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
          fullHash: route.sourcePull!.fullHash,
          partialRoot: route.sourcePull!.partialRoot,
          createdHeight: 0,
          createdTimestamp: 1_000,
        },
      ],
    ]);
    account.currentFrame.timestamp = 1_500;
    account.pendingFrame = { ...account.currentFrame, height: 1, timestamp: 9_000 };

    const result = await applyAccountTx(
      account,
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: 500n,
          incrementalTargetAmount: 450n,
          cumulativeSourceAmount: 500n,
          cumulativeTargetAmount: 450n,
          cumulativeFillRatio: 32_768,
          executionSourceAmount: 500n,
          executionTargetAmount: 450n,
          cancelRemainder: false,
          pairId: 'cross:ethereum:1/base:1',
        },
      },
      account.leftEntity === sourceHub,
      2_000,
      1,
    );

    expect(result.success).toBe(true);
    expect(account.swapOffers.has(route.orderId)).toBe(true);
    expect(account.pulls?.has(route.sourcePull!.pullId)).toBe(true);
    const updatedRoute = account.swapOffers.get(route.orderId)?.crossJurisdiction;
    expect(updatedRoute?.status).toBe('partially_filled');
    expect(updatedRoute?.fillSeq).toBe(1);
    expect(updatedRoute?.filledSourceAmount).toBe(500n);
    expect(updatedRoute?.updatedAt).toBe(2_000);
    expect(account.mempool.some(tx => tx.type === 'pull_resolve')).toBe(false);
  });

  test('cross-j fill ack records source-savings price improvement without changing hashledger ratio', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('79');
    const sourceHub = entity('7a');
    const targetHub = entity('7b');
    const targetUser = entity('7c');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-source-savings',
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
        priceImprovementMode: 'source_savings',
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-source-savings-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const result = await applyAccountTx(
      account,
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: 500n,
          incrementalTargetAmount: 450n,
          cumulativeSourceAmount: 500n,
          cumulativeTargetAmount: 450n,
          cumulativeFillRatio: 32_768,
          fillNumerator: 1n,
          fillDenominator: 2n,
          executionSourceAmount: 475n,
          executionTargetAmount: 450n,
          priceImprovementMode: 'source_savings',
          priceImprovementAmount: 25n,
          priceImprovementTokenId: 1,
          cancelRemainder: false,
          pairId: 'cross:ethereum:1/base:1',
        },
      },
      account.leftEntity === sourceHub,
      2_000,
      1,
    );

    expect(result.success).toBe(true);
    const updatedRoute = account.swapOffers.get(route.orderId)?.crossJurisdiction;
    expect(updatedRoute?.filledSourceAmount).toBe(500n);
    expect(updatedRoute?.priceImprovementSourceAmount).toBe(25n);
    const history = account.swapOrderHistory?.get(route.orderId);
    expect(history?.resolves.at(-1)?.executionGiveAmount).toBe(475n);
    expect(history?.resolves.at(-1)?.executionWantAmount).toBe(450n);
  });

  test('cross-j terminal fill ack copies final resolve into closed-order history', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('7d');
    const sourceHub = entity('7e');
    const targetHub = entity('7f');
    const targetUser = entity('80');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-terminal-history',
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
        priceImprovementMode: 'source_savings',
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-terminal-history-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const result = await applyAccountTx(
      account,
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: 1_000n,
          incrementalTargetAmount: 900n,
          cumulativeSourceAmount: 1_000n,
          cumulativeTargetAmount: 900n,
          cumulativeFillRatio: 65_535,
          fillNumerator: 1n,
          fillDenominator: 1n,
          executionSourceAmount: 950n,
          executionTargetAmount: 900n,
          priceImprovementMode: 'source_savings',
          priceImprovementAmount: 50n,
          priceImprovementTokenId: 1,
          cancelRemainder: false,
          pairId: 'cross:ethereum:1/base:1',
        },
      },
      account.leftEntity === sourceHub,
      2_000,
      1,
    );

    expect(result.success).toBe(true);
    expect(account.swapOffers.has(route.orderId)).toBe(false);
    const closed = account.swapClosedOrders?.get(route.orderId);
    expect(closed?.resolves).toHaveLength(1);
    expect(closed?.resolves[0]?.fillRatio).toBe(65_535);
    expect(closed?.resolves[0]?.executionGiveAmount).toBe(950n);
    expect(closed?.resolves[0]?.executionWantAmount).toBe(900n);
  });

  test('committed cross-j fill ack fails closed when source route mirror is missing', () => {
    const env = createEmptyEnv('cross-fill-ack-missing-route');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceHub = entity('7a');
    const sourceUser = entity('79');
    const state = makeState(sourceHub, addr('7a'), eth, sourceUser);
    state.crossJurisdictionSwaps = new Map();
    const outputs: EntityInput[] = [];
    const ackTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }> = {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: 'missing-source-route',
        fillSeq: 1,
        incrementalSourceAmount: 500n,
        incrementalTargetAmount: 450n,
        cumulativeSourceAmount: 500n,
        cumulativeTargetAmount: 450n,
        cumulativeFillRatio: 32_768,
        fillNumerator: 1n,
        fillDenominator: 2n,
        executionSourceAmount: 500n,
        executionTargetAmount: 450n,
        priceImprovementMode: 'source_savings',
        cancelRemainder: false,
        pairId: 'cross:ethereum:1/base:1',
      },
    };

    expect(() => applyCommittedCrossJurisdictionAccountTxFollowup(env, state, sourceUser, ackTx, outputs)).toThrow(
      'CROSS_J_FILL_ACK_ROUTE_MISSING',
    );
    expect(outputs).toHaveLength(0);
  });

  test('cross-j partial fill uses exact ratio amounts instead of uint16-rounded economics', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('7d');
    const sourceHub = entity('7e');
    const targetHub = entity('7f');
    const targetUser = entity('80');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-exact-quarter',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: 40_000_000_000_000_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 100_000_000_000_000_000_000n,
        },
        priceImprovementMode: 'source_savings',
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-exact-quarter-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 2,
      giveAmount: 40_000_000_000_000_000n,
      wantTokenId: 1,
      wantAmount: 100_000_000_000_000_000_000n,
      priceTicks: 2_500n,
      timeInForce: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const result = await applyAccountTx(
      account,
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: 10_000_000_000_000_000n,
          incrementalTargetAmount: 25_000_000_000_000_000_000n,
          cumulativeSourceAmount: 10_000_000_000_000_000n,
          cumulativeTargetAmount: 25_000_000_000_000_000_000n,
          cumulativeFillRatio: 16_384,
          fillNumerator: 1n,
          fillDenominator: 4n,
          executionSourceAmount: 10_000_000_000_000_000n,
          executionTargetAmount: 25_000_000_000_000_000_000n,
          priceImprovementMode: 'source_savings',
          cancelRemainder: false,
          pairId: 'cross:ethereum:2/base:1',
        },
      },
      account.leftEntity === sourceHub,
      2_000,
      1,
    );

    expect(result.success).toBe(true);
    const updatedRoute = account.swapOffers.get(route.orderId)?.crossJurisdiction;
    expect(updatedRoute?.status).toBe('partially_filled');
    expect(updatedRoute?.cumulativeFillRatio).toBe(16_384);
    expect(updatedRoute?.fillNumerator).toBe(1n);
    expect(updatedRoute?.fillDenominator).toBe(4n);
    expect(updatedRoute?.filledSourceAmount).toBe(10_000_000_000_000_000n);
    expect(updatedRoute?.filledTargetAmount).toBe(25_000_000_000_000_000_000n);
  });

  test('cross-j claim progress preserves exact filled amounts instead of uint16-rounded economics', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-exact-quarter-claim',
        makerEntityId: entity('7d'),
        hubEntityId: entity('7e'),
        source: {
          jurisdiction: jref(eth),
          entityId: entity('7d'),
          counterpartyEntityId: entity('7e'),
          tokenId: 2,
          amount: 40_000_000_000_000_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: entity('7f'),
          counterpartyEntityId: entity('80'),
          tokenId: 1,
          amount: 100_000_000_000_000_000_000n,
        },
        priceImprovementMode: 'source_savings',
        status: 'clearing',
        createdAt: 1_000,
        updatedAt: 2_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-exact-quarter-claim-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    const filledRoute = {
      ...route,
      fillSeq: 1,
      cumulativeFillRatio: 0,
      fillNumerator: 1n,
      fillDenominator: 4n,
      filledSourceAmount: 10_000_000_000_000_000n,
      filledTargetAmount: 25_000_000_000_000_000_000n,
      sourceClaimed: 10_000_000_000_000_000n,
      targetClaimed: 25_000_000_000_000_000_000n,
      claimedRatio: 0,
    };

    const claimed = withCrossJurisdictionClaimProgress(filledRoute, 16_384, 3_000);

    expect(claimed.claimedRatio).toBe(16_384);
    expect(claimed.sourceClaimed).toBe(10_000_000_000_000_000n);
    expect(claimed.targetClaimed).toBe(25_000_000_000_000_000_000n);
    expect(claimed.filledSourceAmount).toBe(10_000_000_000_000_000n);
    expect(claimed.filledTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect(claimed.cumulativeFillRatio).toBe(16_384);
    expect((40_000_000_000_000_000n * 16_384n) / 65_535n).not.toBe(claimed.filledSourceAmount);
  });

  test('cross-j close proof commits exact amounts instead of reconstructing them from uint16 ratio', () => {
    const route = {
      orderId: 'cross-close-exact-progress',
      source: { amount: 40_000_000_000_000_000n },
      target: { amount: 100_000_000_000_000_000_000n },
      cumulativeFillRatio: 16_384,
      claimedRatio: 0,
      filledSourceAmount: 10_000_045_777_065_690n,
      filledTargetAmount: 25_000_000_000_000_000_000n,
    } as CrossJurisdictionSwapRoute;
    const proof = {
      orderId: route.orderId,
      routeHash: `0x${'11'.repeat(32)}`,
      sourcePullId: `0x${'22'.repeat(32)}`,
      targetPullId: `0x${'33'.repeat(32)}`,
      fillRatio: 16_384,
      cumulativeSourceAmount: 10_200_000_000_000_000_000n,
      cumulativeTargetAmount: 10_197_960n,
      binaryHash: `0x${'44'.repeat(32)}`,
      closeMode: 'partial_cancel_remainder' as const,
    };

    const closed = withCrossJurisdictionCloseProofProgress(route, proof, 3_000);

    expect(closed.filledSourceAmount).toBe(proof.cumulativeSourceAmount);
    expect(closed.filledTargetAmount).toBe(proof.cumulativeTargetAmount);
    expect(closed.sourceClaimed).toBe(proof.cumulativeSourceAmount);
    expect(closed.targetClaimed).toBe(proof.cumulativeTargetAmount);
    expect(closed.claimedRatio).toBe(proof.fillRatio);
    expect(closed.updatedAt).toBe(3_000);
  });

  test('cross-j orderbook remaining and cancel ack use exact ratio fields before uint16 fallback', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-exact-quarter-cancel',
        makerEntityId: entity('89'),
        hubEntityId: entity('8a'),
        source: {
          jurisdiction: jref(eth),
          entityId: entity('89'),
          counterpartyEntityId: entity('8a'),
          tokenId: 2,
          amount: 40_000_000_000_000_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: entity('8b'),
          counterpartyEntityId: entity('8c'),
          tokenId: 1,
          amount: 100_000_000_000_000_000_000n,
        },
        priceImprovementMode: 'source_savings',
        status: 'partially_filled',
        createdAt: 1_000,
        updatedAt: 2_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-exact-quarter-cancel-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    const ratioOnlyExactRoute = {
      ...route,
      fillSeq: 1,
      fillNumerator: 1n,
      fillDenominator: 4n,
    };

    const remaining = getCrossJurisdictionRouteRemainingAmounts(ratioOnlyExactRoute);
    const cancelAck = buildCrossJurisdictionCancelAck(ratioOnlyExactRoute.orderId, ratioOnlyExactRoute);
    const closeProof = buildCrossJurisdictionCloseProof(ratioOnlyExactRoute, '0x');
    const sourceBinding = buildCrossJurisdictionPullBinding(ratioOnlyExactRoute, 'source');
    const targetBinding = buildCrossJurisdictionPullBinding(ratioOnlyExactRoute, 'target');
    const pendingFromExactAck = buildCrossJurisdictionPendingFillFromAck(
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: ratioOnlyExactRoute.orderId,
          fillSeq: 1,
          incrementalSourceAmount: 10_000_000_000_000_000n,
          incrementalTargetAmount: 25_000_000_000_000_000_000n,
          cumulativeSourceAmount: 10_000_000_000_000_000n,
          cumulativeTargetAmount: 25_000_000_000_000_000_000n,
          cumulativeFillRatio: 0,
          fillNumerator: 1n,
          fillDenominator: 4n,
          ackKind: 'fill',
          executionSourceAmount: 10_000_000_000_000_000n,
          executionTargetAmount: 25_000_000_000_000_000_000n,
          cancelRemainder: false,
          pairId: ratioOnlyExactRoute.venueId || '',
        },
      },
      2_000,
    );

    expect(hasCrossJurisdictionCommittedFill(route)).toBe(false);
    expect(hasCrossJurisdictionCommittedFill(ratioOnlyExactRoute)).toBe(true);
    expect(remaining.filledSourceAmount).toBe(10_000_000_000_000_000n);
    expect(remaining.filledTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect(remaining.sourceRemaining).toBe(30_000_000_000_000_000n);
    expect(remaining.targetRemaining).toBe(75_000_000_000_000_000_000n);
    expect(cancelAck.data.cumulativeSourceAmount).toBe(10_000_000_000_000_000n);
    expect(cancelAck.data.cumulativeTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect(cancelAck.data.cumulativeFillRatio).toBe(16_384);
    expect(cancelAck.data.fillNumerator).toBe(1n);
    expect(cancelAck.data.fillDenominator).toBe(4n);
    expect(closeProof.fillRatio).toBe(16_384);
    expect(pendingFromExactAck?.cumulativeFillRatio).toBe(16_384);
    expect(pendingFromExactAck?.fillNumerator).toBe(1n);
    expect(pendingFromExactAck?.fillDenominator).toBe(4n);
    expect(closeProof.cumulativeSourceAmount).toBe(10_000_000_000_000_000n);
    expect(closeProof.cumulativeTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect(sourceBinding.fillNumerator).toBe(1n);
    expect(sourceBinding.fillDenominator).toBe(4n);
    expect(sourceBinding.filledSourceAmount).toBe(10_000_000_000_000_000n);
    expect(sourceBinding.filledTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect(targetBinding.fillNumerator).toBe(1n);
    expect(targetBinding.fillDenominator).toBe(4n);
    expect(targetBinding.filledSourceAmount).toBe(10_000_000_000_000_000n);
    expect(targetBinding.filledTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect((40_000_000_000_000_000n * 16_384n) / 65_535n).not.toBe(remaining.filledSourceAmount);
  });

  test('cross-j next fill validates against exact previous ratio fields before uint16 fallback', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('8d');
    const sourceHub = entity('8e');
    const targetHub = entity('8f');
    const targetUser = entity('90');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-exact-quarter-next-fill',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: 40_000_000_000_000_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 100_000_000_000_000_000_000n,
        },
        priceImprovementMode: 'source_savings',
        status: 'partially_filled',
        createdAt: 1_000,
        updatedAt: 2_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-exact-quarter-next-fill-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    const ratioOnlyExactRoute = {
      ...route,
      fillSeq: 1,
      cumulativeFillRatio: 0,
      fillNumerator: 1n,
      fillDenominator: 4n,
    };
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 2,
      giveAmount: 40_000_000_000_000_000n,
      wantTokenId: 1,
      wantAmount: 100_000_000_000_000_000_000n,
      priceTicks: 2_500n,
      timeInForce: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: ratioOnlyExactRoute,
    });

    const result = await applyAccountTx(
      account,
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: route.orderId,
          previousFillSeq: 1,
          fillSeq: 2,
          incrementalSourceAmount: 10_000_000_000_000_000n,
          incrementalTargetAmount: 25_000_000_000_000_000_000n,
          cumulativeSourceAmount: 20_000_000_000_000_000n,
          cumulativeTargetAmount: 50_000_000_000_000_000_000n,
          cumulativeFillRatio: 0,
          fillNumerator: 1n,
          fillDenominator: 2n,
          executionSourceAmount: 10_000_000_000_000_000n,
          executionTargetAmount: 25_000_000_000_000_000_000n,
          priceImprovementMode: 'source_savings',
          cancelRemainder: false,
          pairId: 'cross:ethereum:2/base:1',
        },
      },
      account.leftEntity === sourceHub,
      3_000,
      2,
    );

    const updatedRoute = account.swapOffers.get(route.orderId)?.crossJurisdiction;
    expect(result.success).toBe(true);
    expect(updatedRoute?.fillSeq).toBe(2);
    expect(updatedRoute?.cumulativeFillRatio).toBe(32_768);
    expect(updatedRoute?.filledSourceAmount).toBe(20_000_000_000_000_000n);
    expect(updatedRoute?.filledTargetAmount).toBe(50_000_000_000_000_000_000n);
    expect((40_000_000_000_000_000n * 16_384n) / 65_535n).not.toBe(10_000_000_000_000_000n);
  });

  test('cross-j fill closes sub-lot remainder instead of leaving a zombie order', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const lot = SWAP_LOT_SCALE;
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-sub-lot-dust',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: 2n * lot,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 2n * lot,
        },
        priceImprovementMode: 'source_savings',
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-sub-lot-dust-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 2,
      giveAmount: 2n * lot,
      wantTokenId: 1,
      wantAmount: 2n * lot,
      priceTicks: 10_000n,
      timeInForce: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const cumulative = lot + 1n;
    const result = await applyAccountTx(
      account,
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: cumulative,
          incrementalTargetAmount: cumulative,
          cumulativeSourceAmount: cumulative,
          cumulativeTargetAmount: cumulative,
          cumulativeFillRatio: 32_768,
          fillNumerator: cumulative,
          fillDenominator: 2n * lot,
          executionSourceAmount: cumulative,
          executionTargetAmount: cumulative,
          priceImprovementMode: 'source_savings',
          cancelRemainder: false,
          pairId: 'cross:ethereum:2/base:1',
        },
      },
      account.leftEntity === sourceHub,
      2_000,
      1,
    );

    expect(result.success).toBe(true);
    expect(account.swapOffers.has(route.orderId)).toBe(false);
    const closed = account.swapClosedOrders?.get(route.orderId);
    expect(closed).toBeDefined();
    expect(closed?.resolves.at(-1)?.cancelRemainder).toBe(true);
    expect(closed?.resolves.at(-1)?.fillNumerator).toBe(cumulative);
    expect(closed?.resolves.at(-1)?.fillDenominator).toBe(2n * lot);
  });

  test('cross-j settles a resting bid and taker sell at the ask so both legs conserve', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const tron = makeJurisdiction('Tron', 728126428, '21', '22');
    const sourceUser = entity('91');
    const sourceHub = entity('92');
    const targetHub = entity('93');
    const targetUser = entity('94');
    const baseAmount = SWAP_LOT_SCALE;
    const askQuoteAmount = 24_900_000n;
    const bidQuoteAmount = 25_000_000n;

    const sellRoute = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-taker-sell-at-ask',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        bookOwnerEntityId: sourceHub,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: baseAmount,
        },
        target: {
          jurisdiction: jref(tron),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: askQuoteAmount,
        },
        priceImprovementMode: 'source_savings',
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-taker-sell-at-ask-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    const buyRoute = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-resting-bid-at-ask',
        makerEntityId: targetUser,
        hubEntityId: targetHub,
        bookOwnerEntityId: sourceHub,
        source: {
          jurisdiction: jref(tron),
          entityId: targetUser,
          counterpartyEntityId: targetHub,
          tokenId: 1,
          amount: bidQuoteAmount,
        },
        target: {
          jurisdiction: jref(eth),
          entityId: sourceHub,
          counterpartyEntityId: sourceUser,
          tokenId: 2,
          amount: baseAmount,
        },
        priceImprovementMode: 'source_savings',
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-resting-bid-at-ask-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    const sellMeta = buildCrossJurisdictionMarketOffer(
      {
        offerId: sellRoute.orderId,
        accountId: 'sell-account',
        makerIsLeft: false,
        fromEntity: sourceHub,
        toEntity: sourceUser,
        createdHeight: 1,
        giveTokenId: 2,
        giveAmount: baseAmount,
        quantizedGive: baseAmount,
        wantTokenId: 1,
        wantAmount: askQuoteAmount,
        quantizedWant: askQuoteAmount,
        timeInForce: 0,
        priceTicks: 0n,
        crossJurisdiction: { ...sellRoute, status: 'resting' as const },
      },
      sourceHub,
    );
    const buyMeta = buildCrossJurisdictionMarketOffer(
      {
        offerId: buyRoute.orderId,
        accountId: 'buy-account',
        makerIsLeft: false,
        fromEntity: targetHub,
        toEntity: targetUser,
        createdHeight: 1,
        giveTokenId: 1,
        giveAmount: bidQuoteAmount,
        quantizedGive: bidQuoteAmount,
        wantTokenId: 2,
        wantAmount: baseAmount,
        quantizedWant: baseAmount,
        timeInForce: 0,
        priceTicks: 0n,
        crossJurisdiction: { ...buyRoute, status: 'resting' as const },
      },
      sourceHub,
    );

    expect(sellMeta).not.toBeNull();
    expect(buyMeta).not.toBeNull();
    const executionPrice = resolveCrossJurisdictionExecutionPriceTicks(buyMeta!, sellMeta!);
    expect(executionPrice).toBe(sellMeta!.priceTicks);
    const fill = { filledLots: 1n, weightedCost: executionPrice };
    const sellAck = buildCrossJurisdictionFillAck(
      'sell-account',
      sellRoute.orderId,
      `sell-account:${sellRoute.orderId}`,
      sellMeta!,
      fill,
    );
    const buyAck = buildCrossJurisdictionFillAck(
      'buy-account',
      buyRoute.orderId,
      `buy-account:${buyRoute.orderId}`,
      buyMeta!,
      fill,
    );

    expect(sellAck?.instruction.executionSourceAmount).toBe(baseAmount);
    expect(sellAck?.instruction.executionTargetAmount).toBe(askQuoteAmount);
    expect(buyAck?.instruction.executionSourceAmount).toBe(askQuoteAmount);
    expect(buyAck?.instruction.executionTargetAmount).toBe(baseAmount);
    expect(buyAck?.instruction.priceImprovementAmount).toBe(bidQuoteAmount - askQuoteAmount);
  });

  test('cross-j source-savings fill ack uses target progress, not improved source spend', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const tron = makeJurisdiction('Tron', 728126428, '21', '22');
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const sourceTotal = 78n * 10n ** 6n;
    const executionSource = 75n * 10n ** 6n;
    const targetTotal = 3n * 10n ** 16n;
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-source-savings-full-buy',
        makerEntityId: sourceUser,
        hubEntityId: targetHub,
        bookOwnerEntityId: targetHub,
        source: {
          jurisdiction: jref(tron),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: sourceTotal,
        },
        target: {
          jurisdiction: jref(eth),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: targetTotal,
        },
        priceImprovementMode: 'source_savings',
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-source-savings-full-buy-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    const offer = {
      offerId: route.orderId,
      accountId: 'source-account',
      makerIsLeft: false,
      fromEntity: sourceHub,
      toEntity: sourceUser,
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: sourceTotal,
      quantizedGive: sourceTotal,
      wantTokenId: 2,
      wantAmount: targetTotal,
      quantizedWant: targetTotal,
      timeInForce: 0 as const,
      priceTicks: 26_000_000n,
      crossJurisdiction: { ...route, status: 'resting' as const },
    };
    const meta = buildCrossJurisdictionMarketOffer(offer, targetHub);
    expect(meta).not.toBeNull();
    const ack = buildCrossJurisdictionFillAck(
      'source-account',
      route.orderId,
      `source-account:${route.orderId}`,
      meta!,
      {
        filledLots: Number(targetTotal / SWAP_LOT_SCALE),
        weightedCost: 25_000_000n * (targetTotal / SWAP_LOT_SCALE),
      },
    );

    expect(ack).not.toBeNull();
    expect(ack?.instruction.fillRatio).toBe(65_535);
    expect(ack?.instruction.sourceAmount).toBe(sourceTotal);
    expect(ack?.instruction.targetAmount).toBe(targetTotal);
    expect(ack?.instruction.executionSourceAmount).toBe(executionSource);
    expect(ack?.instruction.executionTargetAmount).toBe(targetTotal);
    expect(ack?.instruction.priceImprovementMode).toBe('source_savings');
    expect(ack?.instruction.priceImprovementAmount).toBe(sourceTotal - executionSource);
    expect(ack?.tx.data.cancelRemainder).toBe(true);
  });

  test('paired cross-j ACKs conserve exact execution amounts and reject sub-lot liquidity', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const tron = makeJurisdiction('Tron', 728126428, '21', '22');
    const hub = entity('91');
    const seller = entity('92');
    const buyer = entity('93');
    const lot = SWAP_LOT_SCALE;
    const makerPrice = 25_000_000n;
    const takerLimit = 26_000_000n;
    const quoteAt = (price: bigint) => quoteAmountAtPrice(2, 1, lot, price);
    const sellRoute = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'paired-sell',
        makerEntityId: seller,
        hubEntityId: hub,
        bookOwnerEntityId: hub,
        source: { jurisdiction: jref(eth), entityId: seller, counterpartyEntityId: hub, tokenId: 2, amount: 2n * lot },
        target: {
          jurisdiction: jref(tron),
          entityId: hub,
          counterpartyEntityId: seller,
          tokenId: 1,
          amount: 2n * quoteAt(makerPrice),
        },
        status: 'resting',
        createdAt: 1,
        updatedAt: 1,
      },
      { runtimeSeed: 'paired-sell', sourceDisputeDelayMs: 5_000, now: 1 },
    );
    const buyRoute = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'paired-buy',
        makerEntityId: buyer,
        hubEntityId: hub,
        bookOwnerEntityId: hub,
        source: {
          jurisdiction: jref(tron),
          entityId: buyer,
          counterpartyEntityId: hub,
          tokenId: 1,
          amount: quoteAt(takerLimit),
        },
        target: { jurisdiction: jref(eth), entityId: hub, counterpartyEntityId: buyer, tokenId: 2, amount: lot },
        status: 'resting',
        createdAt: 1,
        updatedAt: 1,
      },
      { runtimeSeed: 'paired-buy', sourceDisputeDelayMs: 5_000, now: 1 },
    );
    const offer = (route: typeof sellRoute, accountId: string) => ({
      offerId: route.orderId,
      accountId,
      makerIsLeft: false,
      fromEntity: hub,
      toEntity: route.makerEntityId,
      createdHeight: 1,
      giveTokenId: route.source.tokenId,
      giveAmount: route.source.amount,
      quantizedGive: route.source.amount,
      wantTokenId: route.target.tokenId,
      wantAmount: route.target.amount,
      quantizedWant: route.target.amount,
      timeInForce: 0 as const,
      crossJurisdiction: { ...route, status: 'resting' as const },
    });
    const sellMeta = buildCrossJurisdictionMarketOffer(offer(sellRoute, 'sell-account'), hub)!;
    const buyMeta = buildCrossJurisdictionMarketOffer(offer(buyRoute, 'buy-account'), hub)!;
    const fill = { filledLots: 1n, weightedCost: makerPrice };
    const sellAck = buildCrossJurisdictionFillAck(
      'sell-account',
      sellRoute.orderId,
      'sell-account:paired-sell',
      sellMeta,
      fill,
    )!;
    const buyAck = buildCrossJurisdictionFillAck(
      'buy-account',
      buyRoute.orderId,
      'buy-account:paired-buy',
      buyMeta,
      fill,
    )!;

    expect(sellAck.instruction.executionSourceAmount).toBe(buyAck.instruction.executionTargetAmount);
    expect(sellAck.instruction.executionTargetAmount).toBe(buyAck.instruction.executionSourceAmount);
    expect(buyAck.instruction.priceImprovementAmount).toBe(quoteAt(takerLimit) - quoteAt(makerPrice));
    expect(crossBookQtyLots(2, lot - 1n)).toBe(0n);
  });
});
