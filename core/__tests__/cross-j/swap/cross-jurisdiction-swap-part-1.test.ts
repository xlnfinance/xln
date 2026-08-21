import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';

import { ethers } from 'ethers';

import { applyEntityTx } from '../../../entity/tx/apply';

import { applyAccountTx } from '../../../account/tx/apply';

import { proposeAccountFrame } from '../../../account/consensus/proposal/propose';

import { accountInputAck, accountInputProposal } from '../../../account/consensus/flush';

import { computeAccountStateRoot } from '../../../account/commitment/state-root';

import {
  collectCommittedCrossJurisdictionCancelAcks,
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
} from '../../../entity/tx/handlers/account/index';

import { applyEntityInput, mergeEntityInputs } from '../../../entity/consensus/index';

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
import { markPotentialAtomicCrossJInputPairs } from '../../../runtime/frame/cross-j/atomic-admission';

import { buildCrossJurisdictionSwapSubmission } from '../../../runtime/j-submit/api';

import { hashHtlcSecret } from '../../../protocol/htlc/utils';

import type { AccountTx } from '../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityInput, EntityReplica } from '../../../entity/types';
import type { RoutedEntityInput } from '../../../runtime/types';
import { signRuntimeEntityInputsEnvelope } from '../../../runtime/admit/entity-input-envelope-auth.ts';
import type { EntityTx } from '../../../types/entity-tx';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';

import { generateLazyEntityId } from '../../../entity/factory';

import { createDefaultDelta } from '../../../account/state/delta';
import {
  PersistentAccountStateMap,
  requirePersistentAccountStateMap,
} from '../../../account/state/persistent-state-map';

import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
  rebaseCertifiedEntityLineageAtRuntimeCheckpoint,
  refreshRuntimeCheckpointLineageForEntity,
} from '../../../storage/replica/entity-lineage';
import { resolveEntityProposerId } from '../../../runtime/delivery/entity-output-signer';
import { forkEntityReplicaForInput } from '../../../entity/replica/replica-clone';
import { createEntityFrameCandidateState } from '../../../entity/state-clone';
import { buildCanonicalEntityReplicaSnapshot } from '../../../storage/wal/snapshot';
import { safeStringify } from '../../../protocol/serialization';

import { projectEntityCoreDoc } from '../../../storage/read/projections';

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
  projectCrossJurisdictionQuantizedClaim,
  validateCrossJurisdictionFillProgress,
  validateCrossJurisdictionQuantization,
  withCanonicalCrossJurisdictionRouteHash as withCanonicalCrossJurisdictionRouteHashCanonical,
  withCrossJurisdictionClaimProgress,
  withCrossJurisdictionCloseProofProgress,
  cloneCrossJurisdictionRoute,
} from '../../../extensions/cross-j/index';

const TEST_DISPUTE_CONFIG = { leftResponseSeconds: 10, rightResponseSeconds: 10 } as const;
type TestRouteInput = Omit<CrossJurisdictionSwapRoute, 'sourceDisputeConfig' | 'targetDisputeConfig'>;
// These historical fixtures all model the same bilateral response policy. The
// Explicit test adapter avoids reintroducing a production substitute.
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

import {
  buildCrossJurisdictionCancelAck,
  buildCrossJurisdictionFillAck,
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionRouteRemainingAmounts,
  mergeCrossJurisdictionBookAdmission,
  resolveCrossJurisdictionExecutionPriceTicks,
} from '../../../extensions/cross-j/orderbook';

import { buildCrossJurisdictionPendingFillFromAck } from '../../../extensions/cross-j/fill-ack';

import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
} from '../../../extensions/cross-j/market';

import { getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenIdsForJurisdiction } from '../../../account/utils';

import { normalizeEntitySwapTradingPairs } from '../../../runtime/swap-cmd/swap-pairs';

import { verifyHashLadderBinary } from '../../../protocol/htlc/hash-ladder';

import { createBook, recordAcceptedUsdAskPrice } from '../../../orderbook/core';
import {
  createOrderbookExtState,
  getStaticSwapTokenDimensions,
  ORDERBOOK_PRICE_SCALE,
  SWAP_LOT_SCALE,
  quoteAmountAtPrice,
} from '../../../orderbook/types';

import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';


import { signEntityHashes } from '../../../hanko/signing';

import { hashCertifiedEntityOutputSemantic } from '../../../entity/consensus/output/certification';

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
  rescheduleDeferredOutputs,
  splitPendingOutputsByRetryWindow,
} from '../../../runtime/delivery/topology/output-routing';
import { groupAtomicCrossJAdmissionOutputs } from '../../../runtime/delivery/pending';


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
  provisionTestEntityEncryptionKey,
  registerTestSigner,
  secret,
  prepareJEventInput,
} from '../../helpers/cross-j';

import { applyJEventRange, buildJEventRangeData } from '../../helpers/j-history';

import { buildLocalEntityProfile } from '../../../network/p2p/gossip/helper';
import { canonicalizeProfile, type Profile } from '../../../entity/profile';
import { computeProfileHash, computeProfileRouteHash, verifyProfileSignature } from '../../../entity/profile/profile-signing';
import { buildSingleSignerHanko } from '../../../hanko/batch';
import { getSignerPrivateKey, signDigest } from '../../../account/crypto';


import { LIMITS } from '../../../config/constants';

import { getEffectiveEntityInputTxs } from '../../../entity/consensus/output/envelope';

import { assertRuntimeOutputAuthorization } from '../../../entity/auth/authorization';
import { getConsumptionNodeStore } from '../../../entity/consumption/consumption-store';
import { getAccountJClaimNodeStore } from '../../../entity/account/account-j-claim-node-store';

import { cloneIsolatedEntityInput } from '../../../entity/state/input-clone';

import { createDueScheduledWakeInputs } from '../../../runtime/mempool/scheduled-wake';

import { ACCOUNT_PENDING_RESEND_AFTER_MS } from '../../../entity/scheduler';

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

const publishTestRuntimeCheckpoint = (env: RuntimeReplica): void => {
  applyCertifiedEntityLineagePlan(env, rebaseCertifiedEntityLineageAtRuntimeCheckpoint(env));
};

const installTestGenesisLineage = (env: RuntimeReplica): void => {
  applyCertifiedEntityLineagePlan(env, buildCertifiedEntityLineagePlan(env));
};

const registerVerifiedOwnerRoute = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
  runtimeId: string,
): void => {
  env.infrastructure!.verifiedProfileRoutes ??= new Map();
  env.infrastructure!.verifiedProfileRoutes.set(entityId.toLowerCase(), {
    runtimeId: runtimeId.toLowerCase(),
    runtimeSignerId: signerId.toLowerCase(),
    runtimeEncPubKey: '',
    lastUpdated: env.state.timestamp,
  });
};

const registerCryptographicallyVerifiedProfileRoute = async (
  env: ReturnType<typeof createEmptyEnv>,
  profile: Profile,
): Promise<void> => {
  const verification = await verifyProfileSignature(profile);
  if (!verification.valid || !verification.signerId) {
    throw new Error(
      `TEST_PROFILE_ROUTE_INVALID:entity=${profile.entityId}:reason=${verification.reason ?? 'unknown'}`,
    );
  }
  env.infrastructure!.verifiedProfileRoutes ??= new Map();
  env.infrastructure!.verifiedProfileRoutes.set(profile.entityId.toLowerCase(), {
    runtimeId: profile.runtimeId.toLowerCase(),
    runtimeSignerId: verification.signerId.toLowerCase(),
    runtimeEncPubKey: profile.runtimeEncPubKey,
    lastUpdated: profile.lastUpdated,
  });
};

const certifyNamedSignerProfile = (
  env: ReturnType<typeof createEmptyEnv>,
  profile: Profile,
  signerId: string,
): Profile => {
  const privateKey = getSignerPrivateKey(env, signerId);
  const entityCertified = canonicalizeProfile({
    ...profile,
    metadata: {
      ...profile.metadata,
      profileHanko: buildSingleSignerHanko(profile.entityId, computeProfileHash(profile), privateKey),
    },
  });
  return canonicalizeProfile({
    ...entityCertified,
    runtimeSignature: signDigest(env, signerId, computeProfileRouteHash(entityCertified)),
  });
};

describe('cross-jurisdiction hashledger swap', () => {
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

  test('cross-j close proposals are accepted only as one exact source+target cohort', () => {
    const env = createEmptyEnv('cross-j-close-cohort');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const targetJ = makeJurisdiction('Target', 2, '21', '22');
    const sourceUser = entity('51');
    const sourceHub = entity('52');
    const targetHub = entity('53');
    const targetUser = entity('54');
    const sourceUserSigner = addr('55');
    const targetUserSigner = addr('56');
    addReplica(env, makeState(sourceUser, sourceUserSigner, sourceJ, sourceHub), sourceUserSigner);
    addReplica(env, makeState(targetUser, targetUserSigner, targetJ, targetHub), targetUserSigner);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-j-close-cohort',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: jref(sourceJ),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: jref(targetJ),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 900n,
        },
        status: 'clearing',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const proof = buildCrossJurisdictionCloseProof(route, '0x');
    const closeInput = (
      entityId: string,
      signerId: string,
      fromEntityId: string,
      pullId: string,
      account: ReturnType<typeof makeAccount>,
      txProof = proof,
    ): RoutedEntityInput => ({
      entityId,
      signerId,
      from: env.runtimeId,
      runtimeId: env.runtimeId,
      sourceRuntimeFrame: { height: 7, timestamp: env.state.timestamp },
      entityTxs: [
        {
          type: 'accountInput',
          data: {
            kind: 'frame',
            fromEntityId,
            toEntityId: entityId,
            domain: account.state.domain,
            proposal: {
              frame: {
                ...account.currentFrame,
                height: 1,
                timestamp: env.state.timestamp,
                stateHash: secret('57'),
                accountStateRoot: secret('58'),
                accountTxs: [
                  {
                    type: 'cross_pull_close',
                    data: { pullId, binary: '0x', proof: txProof },
                  },
                ],
              },
            },
          },
        },
      ],
    });
    const sourceInput = closeInput(
      sourceUser,
      sourceUserSigner,
      sourceHub,
      route.sourcePull!.pullId,
      makeAccount(sourceUser, sourceHub, sourceJ),
    );
    const targetInput = closeInput(
      targetUser,
      targetUserSigner,
      targetHub,
      route.targetPull!.pullId,
      makeAccount(targetUser, targetHub, targetJ),
    );

    expect(selectPotentialCrossJAccountInputPairs([sourceInput])).toEqual([]);
    expect(selectMatchedCrossJAccountInputPairs(env, [sourceInput]).inputs).toEqual([]);
    expect(selectPotentialCrossJAccountInputPairs([sourceInput, targetInput])).toHaveLength(1);
    expect(selectMatchedCrossJAccountInputPairs(env, [sourceInput, targetInput])).toMatchObject({
      inputs: [sourceInput, targetInput],
      rejectedLegs: [],
    });

    const mismatchedTarget = closeInput(
      targetUser,
      targetUserSigner,
      targetHub,
      route.targetPull!.pullId,
      makeAccount(targetUser, targetHub, targetJ),
      { ...proof, cumulativeTargetAmount: proof.cumulativeTargetAmount + 1n },
    );
    expect(selectPotentialCrossJAccountInputPairs([sourceInput, mismatchedTarget])).toEqual([]);
    expect(selectMatchedCrossJAccountInputPairs(env, [sourceInput, mismatchedTarget]).inputs).toEqual([]);
  });

  test('source hub materializes cross-j commitments once and validators replay them under different seeds', async () => {
    const proposerEnv = createEmptyEnv('cross-j-private-seed-a');
    const validatorEnv = createEmptyEnv('cross-j-private-seed-b');
    proposerEnv.state.timestamp = 10_000;
    validatorEnv.state.timestamp = 10_000;
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const targetJ = makeJurisdiction('Target', 2, '21', '22');
    const sourceUser = entity('61');
    const sourceHub = entity('62');
    const targetHub = entity('63');
    const targetUser = entity('64');
    const sourceUserSigner = addr('68');
    const sourceHubSigner = addr('65');
    const targetHubSigner = addr('66');
    const baseRoute = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-j-seed-independent-replay',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      sourceSignerId: sourceUserSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetSignerId: addr('67'),
      source: {
        jurisdiction: jref(sourceJ),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(targetJ),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 90n,
      },
      status: 'intent',
      createdAt: 10_000,
      updatedAt: 10_000,
      expiresAt: 120_000,
    });
    const proposerState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
    const proposerTargetHubState = makeState(targetHub, targetHubSigner, targetJ, targetUser);
    proposerState.timestamp = 10_000;
    proposerTargetHubState.timestamp = 10_000;
    const validatorState = createEntityFrameCandidateState(proposerState);
    const validatorTargetHubState = createEntityFrameCandidateState(proposerTargetHubState);
    installJurisdictions(proposerEnv, sourceJ, targetJ);
    installJurisdictions(validatorEnv, sourceJ, targetJ);
    addReplica(proposerEnv, proposerState, sourceHubSigner);
    addReplica(proposerEnv, proposerTargetHubState, targetHubSigner);
    addReplica(validatorEnv, validatorState, sourceHubSigner);
    addReplica(validatorEnv, validatorTargetHubState, targetHubSigner);
    const rawTx = { type: 'prepareCrossJurisdictionSwap', data: { route: baseRoute } } as const;
    const proposerRaw = await applyEntityTx(proposerEnv, proposerState, rawTx);
    const validatorRaw = await applyEntityTx(validatorEnv, validatorState, rawTx);
    const proposerReplica = {
      ...(proposerEnv.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`) as EntityReplica),
      state: proposerRaw.newState,
    };
    const materialized = appendDefaultProposerCrossJMaterializations(proposerEnv, proposerReplica, []);
    expect(materialized).toHaveLength(1);
    expect(materialized[0]?.type).toBe('materializeCrossJurisdictionSwap');
    const preparedRoute = (
      materialized[0] as Extract<
        EntityTx,
        {
          type: 'materializeCrossJurisdictionSwap';
        }
      >
    ).data.route;
    const validatorSeedRoute = buildPreparedCrossJurisdictionRoute(baseRoute, {
      runtimeSeed: validatorEnv.runtimeSeed,
      now: validatorEnv.state.timestamp,
    });
    expect(validatorSeedRoute.sourcePull?.fullHash).not.toBe(preparedRoute.sourcePull?.fullHash);

    const proposer = await applyEntityTx(proposerEnv, proposerRaw.newState, materialized[0]!);
    const validator = await applyEntityTx(validatorEnv, validatorRaw.newState, materialized[0]!);
    const sourceRegistration = proposer.outputs.find(output => output.entityId === sourceHub)?.entityTxs?.[0];
    if (sourceRegistration?.type !== 'registerCrossJurisdictionSwap') {
      throw new Error('TEST_CROSS_J_SOURCE_REGISTRATION_REQUIRED');
    }
    const proposerRegistered = await applyEntityTx(proposerEnv, proposer.newState, sourceRegistration);
    const validatorRegistered = await applyEntityTx(validatorEnv, validator.newState, sourceRegistration);

    expect(proposerRegistered.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull).toEqual(
      preparedRoute.sourcePull,
    );
    expect(validatorRegistered.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull).toEqual(
      preparedRoute.sourcePull,
    );
    expect(validator.outputs).toEqual(proposer.outputs);
    expect(validatorRegistered.accountTxs).toEqual(proposerRegistered.accountTxs);

    const buildClearingState = (state: EntityState): EntityState => {
      const next = createEntityFrameCandidateState(state);
      const committed = next.crossJurisdictionSwaps?.get(baseRoute.orderId);
      if (!committed?.sourcePull) throw new Error('TEST_CROSS_J_SOURCE_PULL_REQUIRED');
      const clearingRoute = {
        ...committed,
        status: 'partially_filled' as const,
        fillSeq: 1,
        cumulativeFillRatio: 32_768,
        fillNumerator: 1n,
        fillDenominator: 2n,
        filledSourceAmount: 50n,
        filledTargetAmount: 45n,
      };
      next.crossJurisdictionSwaps?.set(baseRoute.orderId, clearingRoute);
      const account = getEntityAccountForWrite(next.accounts, sourceUser);
      if (!account) throw new Error('TEST_CROSS_J_SOURCE_ACCOUNT_REQUIRED');
      account.state.pulls = PersistentAccountStateMap.empty('pulls').updated(
          clearingRoute.sourcePull.pullId,
          {
            pullId: clearingRoute.sourcePull.pullId,
            tokenId: clearingRoute.sourcePull.tokenId,
            amount: clearingRoute.sourcePull.signedAmount,
            claimedRatio: 0,
            claimedAmount: 0n,
            fullHash: clearingRoute.sourcePull.fullHash,
            partialRoot: clearingRoute.sourcePull.partialRoot,
            crossJurisdiction: buildCrossJurisdictionPullBinding(clearingRoute, 'source'),
            createdHeight: 0,
            createdTimestamp: 10_000,
          },
      );
      return next;
    };
    const rawClear = {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: baseRoute.orderId, cancelRemainder: true },
    } as const;
    const proposerClear = await applyEntityTx(proposerEnv, buildClearingState(proposerRegistered.newState), rawClear);
    const validatorClear = await applyEntityTx(
      validatorEnv,
      buildClearingState(validatorRegistered.newState),
      rawClear,
    );
    expect(proposerClear.accountTxs).toEqual([]);
    expect(validatorClear.accountTxs).toEqual([]);
    expect(proposerClear.outputs).toEqual([{ entityId: sourceHub, signerId: sourceHubSigner, entityTxs: [] }]);
    expect(validatorClear.outputs).toEqual(proposerClear.outputs);
    const clearingReplica = {
      ...proposerReplica,
      state: proposerClear.newState,
    };
    const clearMaterialization = appendDefaultProposerCrossJMaterializations(proposerEnv, clearingReplica, []);
    expect(clearMaterialization).toHaveLength(1);
    expect(clearMaterialization[0]?.type).toBe('materializeCrossJurisdictionClear');
    const proposerMaterializedClear = await applyEntityTx(
      proposerEnv,
      proposerClear.newState,
      clearMaterialization[0]!,
    );
    const validatorMaterializedClear = await applyEntityTx(
      validatorEnv,
      validatorClear.newState,
      clearMaterialization[0]!,
    );
    expect(validatorMaterializedClear.accountTxs).toEqual(proposerMaterializedClear.accountTxs);
    expect(validatorMaterializedClear.outputs).toEqual(proposerMaterializedClear.outputs);
    expect(validatorMaterializedClear.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)).toEqual(
      proposerMaterializedClear.newState.crossJurisdictionSwaps?.get(baseRoute.orderId),
    );
    const verifiedClose = proposerMaterializedClear.accountTxs?.find(op => op.tx.type === 'cross_pull_close')?.tx;
    if (verifiedClose?.type !== 'cross_pull_close') throw new Error('TEST_CROSS_J_CLOSE_REQUIRED');
    expect(
      verifyHashLadderBinary(
        {
          fullHash: preparedRoute.sourcePull!.fullHash,
          partialRoot: preparedRoute.sourcePull!.partialRoot,
        },
        verifiedClose.data.binary,
      ).fillRatio,
    ).toBe(32_768);

    const delayedProposerState = createEntityFrameCandidateState(proposerRaw.newState);
    const delayedValidatorState = createEntityFrameCandidateState(validatorRaw.newState);
    delayedProposerState.timestamp = 12_000;
    delayedValidatorState.timestamp = 12_000;
    const [delayedProposer, delayedValidator] = await Promise.all([
      applyEntityTx(proposerEnv, delayedProposerState, materialized[0]!),
      applyEntityTx(validatorEnv, delayedValidatorState, materialized[0]!),
    ]);
    const delayedProposerRegistered = await applyEntityTx(proposerEnv, delayedProposer.newState, sourceRegistration);
    const delayedValidatorRegistered = await applyEntityTx(validatorEnv, delayedValidator.newState, sourceRegistration);
    expect(delayedProposerRegistered.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull).toEqual(
      preparedRoute.sourcePull,
    );
    expect(delayedValidator.outputs).toEqual(delayedProposer.outputs);
    expect(delayedValidatorRegistered.accountTxs).toEqual(delayedProposerRegistered.accountTxs);

    const tamperedRoute = {
      ...preparedRoute,
      targetPull: {
        ...preparedRoute.targetPull!,
        fullHash: secret('ff'),
      },
    };
    const tamperState = createEntityFrameCandidateState(proposerRaw.newState);
    await expect(
      applyEntityTx(proposerEnv, tamperState, {
        type: 'materializeCrossJurisdictionSwap',
        data: { proposerSignerId: sourceHubSigner, route: tamperedRoute },
      }),
    ).rejects.toThrow('CROSS_J_PREPARED_FULL_HASH_MISMATCH');
    expect(tamperState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull).toBeUndefined();

    const exactRetry = await applyEntityTx(proposerEnv, proposerRaw.newState, rawTx);
    expect(exactRetry.outputs).toHaveLength(0);
    expect(exactRetry.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)).toEqual(baseRoute);
    const conflictingIntent = withCanonicalCrossJurisdictionRouteHash({
      ...cloneCrossJurisdictionRoute(baseRoute),
      routeHash: undefined,
      targetSignerId: addr('99'),
    });
    await expect(
      applyEntityTx(proposerEnv, proposerRaw.newState, {
        type: 'prepareCrossJurisdictionSwap',
        data: { route: conflictingIntent },
      }),
    ).rejects.toThrow('CROSS_J_RAW_PREPARE_CONFLICT');
    expect(proposerRaw.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)).toEqual(baseRoute);

    // Regression: a hub must absorb a duplicate raw intent naming a route it
    // has already materialized, and must RE-ANNOUNCE rather than swallow it.
    // The submitter cannot observe the materialization until the account-level
    // offer surfaces, so it resends in good faith. Throwing failed the whole
    // Runtime input and killed the hub process
    // (RUNTIME_ENTITY_INPUT_APPLY_FAILED -> RUNTIME_LOOP_ERROR), taking the mesh
    // with it; but silently dropping the replay was no better, because then the
    // submitter stayed blind and resent every retry window forever. Idempotent
    // here means reproducing the observable outcome of the original
    // materialization, so the retry converges the submitter's view.
    const materializedState = createEntityFrameCandidateState(delayedProposerRegistered.newState);
    expect(materializedState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull).toBeDefined();
    const replayAfterMaterialization = await applyEntityTx(proposerEnv, materializedState, rawTx);
    // Emits nothing on purpose. Re-announcing the route here would land a
    // registerCrossJurisdictionSwap in the proposer's next wake, and
    // appendDefaultProposerCrossJMaterializations treats any such wake as a
    // commit phase and skips materialization - with a submitter retrying every
    // few seconds the route then never leaves `intent`.
    expect(replayAfterMaterialization.outputs).toHaveLength(0);
    expect(
      replayAfterMaterialization.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull,
    ).toEqual(preparedRoute.sourcePull);
    // A different route reusing one orderId is still a real conflict.
    await expect(
      applyEntityTx(proposerEnv, createEntityFrameCandidateState(delayedProposerRegistered.newState), {
        type: 'prepareCrossJurisdictionSwap',
        data: { route: conflictingIntent },
      }),
    ).rejects.toThrow('CROSS_J_RAW_PREPARE_AFTER_MATERIALIZATION');

    // An authoritative Account dispute may cancel the raw intent after input
    // admission already appended its exact proposer materialization. Both that
    // command and a delayed certified raw retry are strict no-ops; mismatched
    // payloads below remain loud.
    const cancelledIntentState = createEntityFrameCandidateState(proposerRaw.newState);
    const cancelledIntent = cancelledIntentState.crossJurisdictionSwaps!.get(baseRoute.orderId)!;
    cancelledIntentState.crossJurisdictionSwaps!.set(baseRoute.orderId, {
      ...cancelledIntent,
      status: 'cancelled',
      updatedAt: 12_345,
    });
    const materializeAfterCancellation = await applyEntityTx(
      proposerEnv,
      cancelledIntentState,
      materialized[0]!,
    );
    expect(materializeAfterCancellation.outputs).toEqual([]);
    expect(materializeAfterCancellation.newState.crossJurisdictionSwaps
      ?.get(baseRoute.orderId)?.status).toBe('cancelled');
    const rawRetryAfterCancellation = await applyEntityTx(
      proposerEnv,
      materializeAfterCancellation.newState,
      rawTx,
    );
    expect(rawRetryAfterCancellation.outputs).toEqual([]);
    expect(rawRetryAfterCancellation.newState.crossJurisdictionSwaps
      ?.get(baseRoute.orderId)?.status).toBe('cancelled');

    const mismatchedMaterialization = cloneCrossJurisdictionRoute(preparedRoute);
    mismatchedMaterialization.targetSignerId = addr('99');
    await expect(
      applyEntityTx(proposerEnv, proposerRaw.newState, {
        type: 'materializeCrossJurisdictionSwap',
        data: { proposerSignerId: sourceHubSigner, route: mismatchedMaterialization },
      }),
    ).rejects.toThrow('CROSS_J_MATERIALIZE_INTENT_MISMATCH');
  });

  test('hub siblings apply trusted runtime output without Hanko or sequence', async () => {
    const seed = 'cross-j-runtime-output-roundtrip';
    const env = createEmptyEnv(seed);
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const targetJ = makeJurisdiction('Target', 8453, '21', '22');
    installJurisdictions(env, sourceJ, targetJ);
    const sourceHubSigner = registerTestSigner(env, seed, '1');
    const targetHubSigner = registerTestSigner(env, seed, '2');
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const sourceUser = entity('69');
    const targetUser = entity('6a');
    const targetUserSigner = addr('b2');
    const sourceUserSigner = addr('b4');
    env.gossip = {
      getProfiles: () => [
        {
          entityId: sourceUser,
          metadata: { board: { validators: [{ signerId: sourceUserSigner }] } },
        },
        {
          entityId: targetUser,
          metadata: { board: { validators: [{ signerId: targetUserSigner }] } },
        },
      ],
    } as RuntimeReplica['gossip'];
    const sourceHubState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
    const targetHubState = makeState(targetHub, targetHubSigner, targetJ, targetUser);
    sourceHubState.height = 0;
    targetHubState.height = 0;
    sourceHubState.prevFrameHash = 'genesis';
    targetHubState.prevFrameHash = 'genesis';
    const intent = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-j-runtime-output-roundtrip',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      sourceSignerId: addr('b1'),
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetSignerId: targetUserSigner,
      bookHubSignerId: sourceHubSigner,
      source: {
        jurisdiction: jref(sourceJ),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(targetJ),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 900n,
      },
      status: 'intent',
      createdAt: env.state.timestamp,
      updatedAt: env.state.timestamp,
      expiresAt: 70_000,
    });
    sourceHubState.crossJurisdictionSwaps?.set(intent.orderId, intent);
    addReplica(env, sourceHubState, sourceHubSigner);
    addReplica(env, targetHubState, targetHubSigner);
    installTestGenesisLineage(env);
    const prepared = buildPreparedCrossJurisdictionRoute(intent, {
      runtimeSeed: seed,
      now: env.state.timestamp,
    });
    const sourceReplica = env.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!;

    const sourceCommit = await applyEntityInput(env, sourceReplica, {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityTxs: [
        {
          type: 'materializeCrossJurisdictionSwap',
          data: { proposerSignerId: sourceHubSigner, route: prepared },
        },
      ],
    });
    expect(sourceCommit.outcome.kind).toBe('committed');
    expect(sourceCommit.outputs).toHaveLength(2);
    const localOutput = sourceCommit.outputs.find(output => output.entityId === targetHub)!;
    expect(localOutput.entityId).toBe(targetHub);
    expect(localOutput.certifiedOutputIdentity).toBeUndefined();
    expect(localOutput.entityTxs?.map(tx => tx.type)).toEqual(['runtimeOutput']);
    const runtimeOutput = localOutput.entityTxs?.[0];
    if (runtimeOutput?.type !== 'runtimeOutput') throw new Error('TEST_RUNTIME_OUTPUT_REQUIRED');
    expect(Object.keys(runtimeOutput.data).sort()).toEqual([
      'entityTxs',
      'protocol',
      'sourceEntityId',
      'targetEntityId',
    ]);
    expect(runtimeOutput.data.entityTxs.map(tx => tx.type)).toEqual(['registerCrossJurisdictionSwap']);

    const targetReplica = env.state.eReplicas.get(`${targetHub}:${targetHubSigner}`)!;
    const targetCommit = await applyEntityInput(env, targetReplica, localOutput);
    expect(targetCommit.outcome.kind).toBe('committed');
    expect(targetCommit.newState.crossJurisdictionSwaps?.get(intent.orderId)?.routeHash).toBe(intent.routeHash);
    expect(targetCommit.newState.accounts.get(targetUser)?.mempool.map(tx => tx.type)).toEqual(['cross_pull_lock']);
    expect(targetCommit.newState.accounts.get(targetUser)?.pendingFrame).toBeUndefined();
    expect(
      targetCommit.outputs.flatMap(output => output.entityTxs ?? []).some(tx => tx.type === 'consensusOutput'),
    ).toBe(false);
    expect(
      selectCrossJOpeningAccountProposalTxs(
        env,
        targetCommit.newState,
        targetCommit.newState.accounts.get(targetUser)!,
      ),
    ).toBeNull();

    const sourceLocalOutput = sourceCommit.outputs.find(output => output.entityId === sourceHub)!;
    env.state.eReplicas.set(`${sourceHub}:${sourceHubSigner}`, sourceCommit.workingReplica);
    publishTestRuntimeCheckpoint(env);
    const rebasedSourceReplica = env.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!;
    const sourceRegistration = await applyEntityInput(env, rebasedSourceReplica, sourceLocalOutput);
    env.state.eReplicas.set(`${sourceHub}:${sourceHubSigner}`, sourceRegistration.workingReplica);
    env.state.eReplicas.set(`${targetHub}:${targetHubSigner}`, targetCommit.workingReplica);
    expect(
      selectCrossJOpeningAccountProposalTxs(
        env,
        targetCommit.newState,
        targetCommit.newState.accounts.get(targetUser)!,
      ),
    ).not.toBeNull();

    const writableSourceState = createEntityFrameCandidateState(sourceRegistration.newState);
    const writableTargetState = createEntityFrameCandidateState(targetCommit.newState);
    const sourceAccount = getEntityAccountForWrite(writableSourceState.accounts, sourceUser);
    const targetAccount = getEntityAccountForWrite(writableTargetState.accounts, targetUser);
    if (!sourceAccount || !targetAccount) throw new Error('TEST_CROSS_J_WRITABLE_ACCOUNTS_MISSING');
    const laterTargetPull = structuredClone(targetAccount.mempool[0]);
    if (laterTargetPull?.type !== 'cross_pull_lock' || !laterTargetPull.data.crossJurisdictionRoute) {
      throw new Error('TEST_CROSS_J_TARGET_PULL_REQUIRED');
    }
    laterTargetPull.data.crossJurisdiction.orderId = `${intent.orderId}-later`;
    laterTargetPull.data.crossJurisdictionRoute.orderId = `${intent.orderId}-later`;
    const laterSourceTxs = structuredClone(sourceAccount.mempool).map(tx => {
      if (tx.type === 'cross_pull_lock') {
        tx.data.crossJurisdiction.orderId = `${intent.orderId}-later`;
        tx.data.crossJurisdictionRoute.orderId = `${intent.orderId}-later`;
      }
      if (tx.type === 'swap_offer' && tx.data.crossJurisdiction) {
        tx.data.offerId = `${tx.data.offerId}-later`;
        tx.data.crossJurisdiction.orderId = `${intent.orderId}-later`;
      }
      return tx;
    });
    sourceAccount.mempool.push(...laterSourceTxs);
    targetAccount.mempool.push(laterTargetPull);

    // A cross-j opening Account frame carries an on-chain recovery proof.
    // Even when transport could carry many orders, both sibling Accounts must
    // independently pick the same proof-bounded cohort. One order is therefore
    // opened at a time and later orders stay queued.
    const sourceSelected = selectCrossJOpeningAccountProposalTxs(
      env,
      writableSourceState,
      sourceAccount,
    );
    expect(sourceSelected).toHaveLength(2);
    expect(sourceSelected?.every(tx =>
      tx.type === 'cross_pull_lock'
        ? tx.data.crossJurisdiction.orderId === intent.orderId
        : tx.type === 'swap_offer' && tx.data.crossJurisdiction?.orderId === intent.orderId,
    )).toBe(true);
    sourceAccount.pendingFrame = {
      ...sourceAccount.currentFrame,
      height: sourceAccount.currentHeight + 1,
      accountTxs: structuredClone(sourceSelected ?? []),
    };
    const selected = selectCrossJOpeningAccountProposalTxs(env, writableTargetState, targetAccount);
    expect(selected?.map(tx => tx.type)).toEqual(['cross_pull_lock']);
    expect(selected?.[0]?.type === 'cross_pull_lock' && selected[0].data.crossJurisdiction?.orderId).toBe(intent.orderId);
    expect(targetAccount.mempool).toHaveLength(2);
  });

  test('hub sibling cascade commits both Entity frames in one Runtime input pass', async () => {
    const seed = 'cross-j-runtime-same-frame-cascade';
    const env = createEmptyEnv(seed);
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const targetJ = makeJurisdiction('Target', 8453, '21', '22');
    installJurisdictions(env, sourceJ, targetJ);
    const sourceHubSigner = registerTestSigner(env, seed, '1');
    const targetHubSigner = registerTestSigner(env, seed, '2');
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const sourceUser = entity('6b');
    const targetUser = entity('6c');
    const targetUserSigner = addr('b3');
    const sourceUserSigner = addr('b4');
    env.gossip = {
      getProfiles: () => [
        {
          entityId: sourceUser,
          metadata: { board: { validators: [{ signerId: sourceUserSigner }] } },
        },
        {
          entityId: targetUser,
          metadata: { board: { validators: [{ signerId: targetUserSigner }] } },
        },
      ],
    } as RuntimeReplica['gossip'];
    const sourceState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
    const targetState = makeState(targetHub, targetHubSigner, targetJ, targetUser);
    // This fixture starts from a locally trusted genesis, not from an
    // unpersisted synthetic H1. The first certified link must therefore be H1
    // with parent `genesis`; otherwise the lineage gate correctly rejects it.
    sourceState.height = 0;
    targetState.height = 0;
    sourceState.prevFrameHash = 'genesis';
    targetState.prevFrameHash = 'genesis';
    const intent = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-j-runtime-same-frame-cascade',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      sourceSignerId: sourceUserSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetSignerId: targetUserSigner,
      bookHubSignerId: sourceHubSigner,
      source: {
        jurisdiction: jref(sourceJ),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(targetJ),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 900n,
      },
      status: 'intent',
      createdAt: env.state.timestamp,
      updatedAt: env.state.timestamp,
      expiresAt: 70_000,
    });
    sourceState.crossJurisdictionSwaps?.set(intent.orderId, intent);
    addReplica(env, sourceState, sourceHubSigner);
    addReplica(env, targetState, targetHubSigner);
    registerVerifiedOwnerRoute(env, sourceUser, sourceUserSigner, env.runtimeId!);
    registerVerifiedOwnerRoute(env, targetUser, targetUserSigner, env.runtimeId!);
    const prepared = buildPreparedCrossJurisdictionRoute(intent, {
      runtimeSeed: seed,
      now: env.state.timestamp,
    });
    const sourceHeight = sourceState.height;
    const targetHeight = targetState.height;

    const sourceInput: EntityInput = {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityTxs: [
        {
          type: 'materializeCrossJurisdictionSwap',
          data: { proposerSignerId: sourceHubSigner, route: prepared },
        },
      ],
    };
    const reverseIntent = withCanonicalCrossJurisdictionRouteHash({
      ...cloneCrossJurisdictionRoute(intent),
      routeHash: '',
      orderId: 'cross-j-runtime-same-frame-cascade-reverse',
      makerEntityId: targetUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      sourceSignerId: targetUserSigner,
      sourceHubSignerId: targetHubSigner,
      targetHubSignerId: sourceHubSigner,
      targetSignerId: sourceUserSigner,
      bookHubSignerId: targetHubSigner,
      source: {
        jurisdiction: jref(targetJ),
        entityId: targetUser,
        counterpartyEntityId: targetHub,
        tokenId: 1,
        amount: 900n,
      },
      target: {
        jurisdiction: jref(sourceJ),
        entityId: sourceHub,
        counterpartyEntityId: sourceUser,
        tokenId: 1,
        amount: 1_000n,
      },
    });
    const secondForwardIntent = withCanonicalCrossJurisdictionRouteHash({
      ...cloneCrossJurisdictionRoute(intent),
      routeHash: '',
      orderId: 'cross-j-runtime-same-frame-cascade-forward-2',
    });
    const reversePrepared = buildPreparedCrossJurisdictionRoute(reverseIntent, {
      runtimeSeed: seed,
      now: env.state.timestamp,
    });
    const reverseInput: EntityInput = {
      entityId: targetHub,
      signerId: targetHubSigner,
      entityTxs: [
        {
          type: 'materializeCrossJurisdictionSwap',
          data: { proposerSignerId: targetHubSigner, route: reversePrepared },
        },
      ],
    };

    const saturatedEnv = createEmptyEnv(`${seed}-saturated-local-event`);
    saturatedEnv.state.timestamp = env.state.timestamp;
    saturatedEnv.quietRuntimeLogs = true;
    installJurisdictions(saturatedEnv, sourceJ, targetJ);
    registerTestSigner(saturatedEnv, seed, '1');
    registerTestSigner(saturatedEnv, seed, '2');
    saturatedEnv.gossip = env.gossip;
    registerVerifiedOwnerRoute(saturatedEnv, sourceUser, sourceUserSigner, saturatedEnv.runtimeId!);
    registerVerifiedOwnerRoute(saturatedEnv, targetUser, targetUserSigner, saturatedEnv.runtimeId!);
    saturatedEnv.state.eReplicas = new Map(
      [...env.state.eReplicas].map(([key, replica]) => [key, forkEntityReplicaForInput(replica)]),
    );
    provisionTestEntityEncryptionKey(saturatedEnv, sourceHub);
    provisionTestEntityEncryptionKey(saturatedEnv, targetHub);
    const saturatedTarget = saturatedEnv.state.eReplicas.get(`${targetHub}:${targetHubSigner}`)!;
    saturatedTarget.mempool = Array.from({ length: LIMITS.MEMPOOL_SIZE }, () => ({
      type: 'chatMessage' as const,
      data: { message: 'fills external target mempool', timestamp: saturatedEnv.state.timestamp },
    }));

    const saturated = await applyMergedEntityInputs(saturatedEnv, [sourceInput], [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
      beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(saturatedEnv, entityId),
    });
    expect(saturated.appliedEntityInputs.map(input => input.entityId)).toEqual([sourceHub]);
    const committedSaturatedTarget = saturatedEnv.state.eReplicas.get(`${targetHub}:${targetHubSigner}`)!.state;
    // Runtime-private account-work causally adds H+1 after registration. The
    // saturated Entity mempool cannot suppress this already committed work.
    expect(committedSaturatedTarget.height).toBe(targetHeight + 2);
    expect(committedSaturatedTarget.crossJurisdictionSwaps?.get(intent.orderId)?.routeHash).toBe(intent.routeHash);
    expect(saturatedEnv.state.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.mempool).toHaveLength(LIMITS.MEMPOOL_SIZE);

    sourceState.crossJurisdictionSwaps?.set(secondForwardIntent.orderId, secondForwardIntent);
    targetState.crossJurisdictionSwaps?.set(reverseIntent.orderId, reverseIntent);
    expect(resolveEntityProposerId(env, sourceUser, 'cross-j-cascade-fixture')).toBe(sourceUserSigner);
    expect(resolveEntityProposerId(env, targetUser, 'cross-j-cascade-fixture')).toBe(targetUserSigner);
    const pass = await applyMergedEntityInputs(env, [sourceInput, reverseInput], [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
      beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(env, entityId),
    });

    expect(env.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.state.height).toBe(sourceHeight + 4);
    expect(env.state.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.state.height).toBe(targetHeight + 4);
    expect(
      env.state.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.state.crossJurisdictionSwaps?.get(intent.orderId)
        ?.routeHash,
    ).toBe(intent.routeHash);
    expect(pass.appliedEntityInputs.map(input => input.entityId)).toEqual([sourceHub, targetHub]);
    expect(pass.localCrossJurisdictionEventTrace.map(input => input.entityId)).toEqual([
      sourceHub,
      targetHub,
      sourceHub,
      targetHub,
      targetHub,
      sourceHub,
    ]);
    expect(
      pass.localCrossJurisdictionEventTrace.map(input =>
        input.entityTxs[0]?.type === 'runtimeOutput' ? input.entityTxs[0].data.entityTxs.length : 0,
      ),
      ).toEqual([2, 2, 0, 0, 1, 1]);
    const crossJOrderIds = (txs: readonly AccountTx[]): string[] =>
      txs.flatMap(tx => {
        if (tx.type === 'cross_pull_lock') return tx.data.crossJurisdiction?.orderId ?? [];
        if (tx.type === 'swap_offer') return tx.data.crossJurisdiction?.orderId ?? [];
        return [];
      });
    const firstAccountFrameOrderIds = new Set([intent.orderId]);
    const queuedAccountFrameOrderIds = new Set([
      secondForwardIntent.orderId,
      reverseIntent.orderId,
    ]);
    const sourceRegisteredAccount = env.state.eReplicas
      .get(`${sourceHub}:${sourceHubSigner}`)!
      .state.accounts.get(sourceUser)!;
    const targetRegisteredAccount = env.state.eReplicas
      .get(`${targetHub}:${targetHubSigner}`)!
      .state.accounts.get(targetUser)!;
    expect(sourceRegisteredAccount.pendingFrame?.height).toBe(1);
    expect(targetRegisteredAccount.pendingFrame?.height).toBe(1);
    expect(new Set(crossJOrderIds(sourceRegisteredAccount.pendingFrame?.accountTxs ?? [])))
      .toEqual(firstAccountFrameOrderIds);
    expect(new Set(crossJOrderIds(targetRegisteredAccount.pendingFrame?.accountTxs ?? [])))
      .toEqual(firstAccountFrameOrderIds);
    expect(new Set(crossJOrderIds(sourceRegisteredAccount.mempool))).toEqual(queuedAccountFrameOrderIds);
    expect(new Set(crossJOrderIds(targetRegisteredAccount.mempool))).toEqual(queuedAccountFrameOrderIds);
    expect(pass.entityOutbox.some(output => output.localRuntimeProtocol !== undefined)).toBe(false);
    expect(
      pass.entityOutbox
        .map(output => ({
          entityId: output.entityId,
          txTypes: output.entityTxs?.map(tx => tx.type) ?? [],
        }))
        .sort((left, right) => left.entityId.localeCompare(right.entityId)),
    ).toEqual(
      [
        {
          entityId: sourceUser,
          txTypes: ['accountInput'],
        },
        {
          entityId: targetUser,
          txTypes: ['accountInput'],
        },
      ].sort((left, right) => left.entityId.localeCompare(right.entityId)),
    );
  });

  test('atomic opening applies two Hub proposals, then two User ACKs, with no receipt round trip', async () => {
    const seed = 'cross-j-atomic-opening';
    const userEnv = createEmptyEnv(`${seed}-user`);
    const hubEnv = createEmptyEnv(`${seed}-hub`);
    userEnv.state.timestamp = 10_000;
    hubEnv.state.timestamp = 10_000;
    userEnv.quietRuntimeLogs = true;
    hubEnv.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const targetJ = makeJurisdiction('Target', 8453, '21', '22');
    installJurisdictions(userEnv, sourceJ, targetJ);
    installJurisdictions(hubEnv, sourceJ, targetJ);

    const sourceUserSigner = registerTestSigner(userEnv, seed, 'source-user');
    const targetUserSigner = registerTestSigner(userEnv, seed, 'target-user');
    const sourceHubSigner = registerTestSigner(hubEnv, seed, 'source-hub');
    const targetHubSigner = registerTestSigner(hubEnv, seed, 'target-hub');
    const sourceHubBSigner = registerTestSigner(hubEnv, seed, 'source-hub-b');
    const targetHubBSigner = registerTestSigner(hubEnv, seed, 'target-hub-b');
    const sourceUser = generateLazyEntityId([sourceUserSigner], 1n).toLowerCase();
    const targetUser = generateLazyEntityId([targetUserSigner], 1n).toLowerCase();
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const sourceHubB = generateLazyEntityId([sourceHubBSigner], 1n).toLowerCase();
    const targetHubB = generateLazyEntityId([targetHubBSigner], 1n).toLowerCase();
    const sourceUserState = makeState(sourceUser, sourceUserSigner, sourceJ, sourceHub);
    const targetUserState = makeState(targetUser, targetUserSigner, targetJ, targetHub);
    const sourceHubState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
    const targetHubState = makeState(targetHub, targetHubSigner, targetJ, targetUser);
    const sourceHubBState = makeState(sourceHubB, sourceHubBSigner, sourceJ, sourceUser);
    const targetHubBState = makeState(targetHubB, targetHubBSigner, targetJ, targetUser);
    sourceUserState.accounts = sourceUserState.accounts.updated(
      sourceHubB,
      makeAccount(sourceUser, sourceHubB, sourceJ),
    );
    targetUserState.accounts = targetUserState.accounts.updated(
      targetHubB,
      makeAccount(targetUser, targetHubB, targetJ),
    );
    sourceUserState.profile.name = 'source user';
    targetUserState.profile.name = 'target user';
    sourceHubState.profile.name = 'source hub';
    targetHubState.profile.name = 'target hub';
    sourceHubBState.profile.name = 'source hub B';
    targetHubBState.profile.name = 'target hub B';
    sourceHubState.profile.isHub = true;
    targetHubState.profile.isHub = true;
    sourceHubBState.profile.isHub = true;
    targetHubBState.profile.isHub = true;
    sourceHubState.orderbookExt = {
      books: new Map(),
      orderPairs: new Map(),
      pairDimensions: new Map(),
      referrals: new Map(),
      hubProfile: {
        entityId: sourceHub,
        name: 'source hub',
        spreadDistribution: {
          makerBps: 0,
          takerBps: 10_000,
          hubBps: 0,
          makerReferrerBps: 0,
          takerReferrerBps: 0,
        },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [],
      },
    };
    sourceHubBState.orderbookExt = {
      ...sourceHubState.orderbookExt,
      books: new Map(),
      orderPairs: new Map(),
      pairDimensions: new Map(),
      referrals: new Map(),
      hubProfile: { ...sourceHubState.orderbookExt.hubProfile, entityId: sourceHubB, name: 'source hub B' },
    };
    for (const state of [
      sourceUserState,
      targetUserState,
      sourceHubState,
      targetHubState,
      sourceHubBState,
      targetHubBState,
    ]) {
      state.height = 0;
      state.prevFrameHash = 'genesis';
    }
    addReplica(userEnv, sourceUserState, sourceUserSigner);
    addReplica(userEnv, targetUserState, targetUserSigner);
    addReplica(hubEnv, sourceHubState, sourceHubSigner);
    addReplica(hubEnv, targetHubState, targetHubSigner);
    addReplica(hubEnv, sourceHubBState, sourceHubBSigner);
    addReplica(hubEnv, targetHubBState, targetHubBSigner);
    installTestGenesisLineage(hubEnv);
    const sourceHubProfile = certifyNamedSignerProfile(
      hubEnv,
      buildLocalEntityProfile(hubEnv, sourceHubState),
      sourceHubSigner,
    );
    const targetHubProfile = certifyNamedSignerProfile(
      hubEnv,
      buildLocalEntityProfile(hubEnv, targetHubState),
      targetHubSigner,
    );
    const sourceHubBProfile = certifyNamedSignerProfile(
      hubEnv,
      buildLocalEntityProfile(hubEnv, sourceHubBState),
      sourceHubBSigner,
    );
    const targetHubBProfile = certifyNamedSignerProfile(
      hubEnv,
      buildLocalEntityProfile(hubEnv, targetHubBState),
      targetHubBSigner,
    );
    const sourceUserProfile = certifyNamedSignerProfile(
      userEnv,
      buildLocalEntityProfile(userEnv, sourceUserState),
      sourceUserSigner,
    );
    const targetUserProfile = certifyNamedSignerProfile(
      userEnv,
      buildLocalEntityProfile(userEnv, targetUserState),
      targetUserSigner,
    );
    for (const profile of [sourceHubProfile, targetHubProfile, sourceHubBProfile, targetHubBProfile]) {
      await registerCryptographicallyVerifiedProfileRoute(userEnv, profile);
    }
    for (const profile of [sourceUserProfile, targetUserProfile]) {
      await registerCryptographicallyVerifiedProfileRoute(hubEnv, profile);
    }
    userEnv.gossip = {
      getProfiles: () => [sourceHubProfile, targetHubProfile, sourceHubBProfile, targetHubBProfile],
    } as typeof userEnv.gossip;
    hubEnv.gossip = {
      getProfiles: () => [sourceUserProfile, targetUserProfile],
    } as typeof hubEnv.gossip;

    const intent = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-j-atomic-opening',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      sourceSignerId: sourceUserSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetSignerId: targetUserSigner,
      bookHubSignerId: sourceHubSigner,
      source: {
        jurisdiction: jref(sourceJ),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(targetJ),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 900n,
      },
      status: 'intent',
      createdAt: hubEnv.state.timestamp,
      updatedAt: hubEnv.state.timestamp,
      expiresAt: 70_000,
    });
    sourceHubState.crossJurisdictionSwaps?.set(intent.orderId, intent);
    const prepared = buildPreparedCrossJurisdictionRoute(intent, {
      runtimeSeed: seed,
      now: hubEnv.state.timestamp,
    });
    const hubProposalPass = await applyMergedEntityInputs(
      hubEnv,
      [
        {
          entityId: sourceHub,
          signerId: sourceHubSigner,
          entityTxs: [
            {
              type: 'materializeCrossJurisdictionSwap',
              data: { proposerSignerId: sourceHubSigner, route: prepared },
            },
          ],
        },
      ],
      [],
      {
        isReplay: false,
        routingDeps: makeLocalCrossJRoutingDeps(),
        beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(hubEnv, entityId),
      },
    );
    const hubWakePass = hubProposalPass;
    expect(hubWakePass.entityOutbox.map(output => output.entityId).sort()).toEqual([sourceUser, targetUser].sort());
    publishTestRuntimeCheckpoint(hubEnv);

    const hubOnlySourceAccount = hubEnv.state.eReplicas
      .get(`${sourceHub}:${sourceHubSigner}`)!
      .state.accounts.get(sourceUser)!;
    const hubOnlyTargetAccount = hubEnv.state.eReplicas
      .get(`${targetHub}:${targetHubSigner}`)!
      .state.accounts.get(targetUser)!;
    expect(hubOnlySourceAccount.pendingFrame?.accountTxs.map(tx => tx.type)).toEqual(['cross_pull_lock', 'swap_offer']);
    expect(hubOnlyTargetAccount.pendingFrame?.accountTxs.map(tx => tx.type)).toEqual(['cross_pull_lock']);
    expect(hubOnlySourceAccount.currentFrame.accountTxs).toEqual([]);
    expect(hubOnlyTargetAccount.currentFrame.accountTxs).toEqual([]);
    expect(hubOnlySourceAccount.state.pulls?.has(prepared.sourcePull!.pullId) ?? false).toBe(false);
    expect(hubOnlySourceAccount.state.swapOffers.has(prepared.orderId)).toBe(false);
    expect(buildAccountProofBody(hubOnlySourceAccount, '').runtimeProofBody.transformers).toEqual([]);

    const hubFrame = { height: 42, timestamp: hubEnv.state.timestamp };
    const proposals = hubWakePass.entityOutbox.map(output => ({
      ...output,
      from: hubEnv.runtimeId,
      runtimeId: userEnv.runtimeId,
      sourceRuntimeFrame: hubFrame,
    }));
    expect(selectMatchedCrossJAccountInputPairs(userEnv, proposals).pairs).toEqual([]);
    const liveSourceUserState = userEnv.state.eReplicas.get(
      `${sourceUser}:${sourceUserSigner}`,
    )!.state;
    const liveTargetUserState = userEnv.state.eReplicas.get(
      `${targetUser}:${targetUserSigner}`,
    )!.state;
    liveSourceUserState.crossJurisdictionAuthorizations = new Map([
      [intent.orderId, cloneCrossJurisdictionRoute(intent)],
    ]);
    expect(selectMatchedCrossJAccountInputPairs(userEnv, proposals).pairs).toEqual([]);
    liveTargetUserState.crossJurisdictionAuthorizations = new Map([
      [intent.orderId, cloneCrossJurisdictionRoute(intent)],
    ]);
    expect(selectMatchedCrossJAccountInputPairs(userEnv, proposals).pairs).toHaveLength(1);
    const intentB = withCanonicalCrossJurisdictionRouteHash({
      ...intent,
      routeHash: undefined,
      orderId: 'cross-j-atomic-opening-b',
      hubEntityId: sourceHubB,
      bookOwnerEntityId: sourceHubB,
      sourceHubSignerId: sourceHubBSigner,
      targetHubSignerId: targetHubBSigner,
      bookHubSignerId: sourceHubBSigner,
      source: { ...intent.source, counterpartyEntityId: sourceHubB },
      target: { ...intent.target, entityId: targetHubB },
    });
    sourceHubBState.crossJurisdictionSwaps?.set(intentB.orderId, intentB);
    const preparedB = buildPreparedCrossJurisdictionRoute(intentB, {
      runtimeSeed: seed,
      now: hubEnv.state.timestamp,
    });
    const hubWakePassB = await applyMergedEntityInputs(
      hubEnv,
      [{
        entityId: sourceHubB,
        signerId: sourceHubBSigner,
        entityTxs: [{
          type: 'materializeCrossJurisdictionSwap',
          data: { proposerSignerId: sourceHubBSigner, route: preparedB },
        }],
      }],
      [],
      {
        isReplay: false,
        routingDeps: makeLocalCrossJRoutingDeps(),
        beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(hubEnv, entityId),
      },
    );
    const proposalsB = hubWakePassB.entityOutbox.map(output => ({
      ...output,
      from: hubEnv.runtimeId,
      runtimeId: userEnv.runtimeId,
      sourceRuntimeFrame: { height: 43, timestamp: hubEnv.state.timestamp },
    }));
    liveSourceUserState.crossJurisdictionAuthorizations.set(
      intentB.orderId,
      cloneCrossJurisdictionRoute(intentB),
    );
    liveTargetUserState.crossJurisdictionAuthorizations.set(
      intentB.orderId,
      cloneCrossJurisdictionRoute(intentB),
    );
    // The User genesis fixture is complete only after both authorized routes
    // exist. Anchoring earlier would certify a stale state root, then make the
    // first production-style Runtime checkpoint correctly reject the fixture.
    installTestGenesisLineage(userEnv);
    expect(proposalsB.map(output => output.entityId).sort()).toEqual([sourceUser, targetUser].sort());
    const dedupedProposals = buildPendingNetworkOutputs([
      { ...proposals[0]!, sourceRuntimeFrame: { height: 41, timestamp: hubEnv.state.timestamp - 1 } },
      { ...proposals[1]!, sourceRuntimeFrame: { height: 41, timestamp: hubEnv.state.timestamp - 1 } },
      ...proposals,
    ]);
    expect(dedupedProposals).toHaveLength(2);
    expect(selectPotentialCrossJAccountInputPairs(dedupedProposals)).toHaveLength(1);
    const sameEntityReplay = [
      proposals[0]!,
      {
        ...proposals[1]!,
        entityId: proposals[0]!.entityId,
        signerId: proposals[0]!.signerId,
      },
    ];
    expect(selectPotentialCrossJAccountInputPairs(sameEntityReplay)).toEqual([]);
    expect(selectMatchedCrossJAccountInputPairs(userEnv, sameEntityReplay)).toMatchObject({
      inputs: [],
      pairs: [],
    });
    const repeatedCohorts = [
      { ...proposals[0]!, sourceRuntimeFrame: { height: 41, timestamp: hubEnv.state.timestamp - 1 } },
      { ...proposals[1]!, sourceRuntimeFrame: { height: 41, timestamp: hubEnv.state.timestamp - 1 } },
      ...proposals,
    ];
    expect(selectPotentialCrossJAccountInputPairs(repeatedCohorts)).toHaveLength(2);
    const prematurelyMergedCohorts = mergeEntityInputs(repeatedCohorts);
    expect(prematurelyMergedCohorts).toHaveLength(2);
    expect(prematurelyMergedCohorts.every(input =>
      getEffectiveEntityInputTxs(input).filter(tx => tx.type === 'accountInput').length === 2,
    )).toBe(true);
    const safelyMergedCohorts = mergeEntityInputs(
      markPotentialAtomicCrossJInputPairs(repeatedCohorts),
    );
    expect(safelyMergedCohorts).toHaveLength(4);
    expect(safelyMergedCohorts.every(input =>
      getEffectiveEntityInputTxs(input).filter(tx => tx.type === 'accountInput').length === 1,
    )).toBe(true);
    expect(selectPotentialCrossJAccountInputPairs(safelyMergedCohorts)).toHaveLength(2);
    const unframedLocalCohort = proposals.map(input => {
      const { sourceRuntimeFrame: _sourceRuntimeFrame, ...localInput } = input;
      return localInput;
    });
    const markedLocalCohort = markPotentialAtomicCrossJInputPairs(unframedLocalCohort);
    expect(markedLocalCohort.every(input => input.atomicCrossJurisdictionPair === undefined)).toBe(true);
    expect(() => mergeEntityInputs(markedLocalCohort)).not.toThrow();
    // Regression: dispatch pairs with allowDifferentSourceRuntimeFrames because
    // sibling Entity consensus may certify the two legs of one cohort in
    // adjacent Runtime frames. That option also drops the only predicate
    // separating two concurrent cohorts carrying identical route sets, so every
    // leg saw two partners and the uniqueness rule discarded all of them. The
    // unclaimed legs then became lone cross-j proposals, which dispatch defers
    // as incomplete atomic cohorts and never retries — MM bootstrap-cross hung
    // at 0 of 6 routes. Both cohorts are unambiguous inside their own frame, so
    // pairing must resolve there first and still return both.
    // The count alone never caught this: the buggy result was also two pairs,
    // but they OVERLAPPED — (1,2) and (2,3) — and the greedy claim in
    // groupAtomicCrossJAdmissionOutputs then dropped the second and orphaned
    // inputs 0 and 3. Assert a real matching: disjoint, and covering every leg.
    const crossFramePairs = selectPotentialCrossJAccountInputPairs(repeatedCohorts, {
      allowDifferentSourceRuntimeFrames: true,
    });
    expect(crossFramePairs).toHaveLength(2);
    const pairedIndexes = crossFramePairs.flatMap(pair => [
      pair.sourceInputIndex,
      pair.targetInputIndex,
    ]);
    expect(new Set(pairedIndexes).size).toBe(pairedIndexes.length);
    expect([...pairedIndexes].sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
    const atomicRepeatedCohorts = repeatedCohorts.map(input => {
      const frame = input.sourceRuntimeFrame!;
      const cohort = repeatedCohorts.filter(
        candidate =>
          candidate.sourceRuntimeFrame?.height === frame.height &&
          candidate.sourceRuntimeFrame.timestamp === frame.timestamp,
      );
      const pairKey = selectPotentialCrossJAccountInputPairs(cohort)[0]!.pairKey;
      return { ...input, atomicCrossJurisdictionPair: { phase: 'proposal' as const, pairKey } };
    });
    const currentAtomicCohort = atomicRepeatedCohorts.filter(
      input => input.sourceRuntimeFrame?.height === hubFrame.height,
    );
    const mergedSameFrameReplay = mergeEntityInputs([
      ...currentAtomicCohort,
      ...currentAtomicCohort,
    ]);
    expect(mergedSameFrameReplay).toHaveLength(2);
    expect(mergedSameFrameReplay.every(input =>
      getEffectiveEntityInputTxs(input).filter(tx => tx.type === 'accountInput').length === 1,
    )).toBe(true);
    expect(selectPotentialCrossJAccountInputPairs(mergedSameFrameReplay)).toHaveLength(1);
    const changedSameFrameReplay = currentAtomicCohort.map(cloneIsolatedEntityInput);
    const changedAccountInputTx = getEffectiveEntityInputTxs(changedSameFrameReplay[0]!)
      .find(tx => tx.type === 'accountInput');
    const changedProposal = changedAccountInputTx?.type === 'accountInput'
      ? accountInputProposal(changedAccountInputTx.data)
      : undefined;
    if (!changedProposal) throw new Error('TEST_CROSS_J_CHANGED_REPLAY_PROPOSAL_MISSING');
    changedProposal.frameHanko = '0x00';
    const mergedChangedReplay = mergeEntityInputs([
      ...currentAtomicCohort,
      changedSameFrameReplay[0]!,
    ]);
    expect(getEffectiveEntityInputTxs(
      mergedChangedReplay.find(input => input.entityId === changedSameFrameReplay[0]!.entityId)!,
    ).filter(tx => tx.type === 'accountInput')).toHaveLength(2);
    const rejectedChangedReplay = await admitAtomicCrossJAccountInputs(
      userEnv,
      mergedChangedReplay,
      false,
    );
    expect(rejectedChangedReplay.pairs).toEqual([]);
    expect(rejectedChangedReplay.inputs).toEqual([]);
    const mergedRepeatedCohorts = mergeEntityInputs(atomicRepeatedCohorts);
    expect(mergedRepeatedCohorts).toHaveLength(4);
    expect(selectPotentialCrossJAccountInputPairs(mergedRepeatedCohorts)).toHaveLength(2);
    const coalescedRepeatedCohorts = await admitAtomicCrossJAccountInputs(
      userEnv,
      mergedRepeatedCohorts,
      false,
    );
    expect(coalescedRepeatedCohorts.inputs).toHaveLength(2);
    expect(coalescedRepeatedCohorts.pairs).toHaveLength(1);
    expect(coalescedRepeatedCohorts.inputs.every(
      input => input.sourceRuntimeFrame?.height === hubFrame.height,
    )).toBe(true);
    const structuralPairB = selectPotentialCrossJAccountInputPairs(proposalsB)[0];
    if (!structuralPairB) throw new Error('TEST_CROSS_J_SECOND_ATOMIC_PAIR_MISSING');
    const atomicB = proposalsB.map(input => ({
      ...input,
      atomicCrossJurisdictionPair: {
        phase: 'proposal' as const,
        pairKey: structuralPairB.pairKey,
      },
    }));
    const mergedConcurrentRetries = mergeEntityInputs([...atomicRepeatedCohorts, ...atomicB]);
    expect(mergedConcurrentRetries).toHaveLength(6);

    const concurrentUserEnv = createEmptyEnv(`${seed}-concurrent-user`);
    concurrentUserEnv.runtimeId = userEnv.runtimeId;
    concurrentUserEnv.state.timestamp = userEnv.state.timestamp;
    concurrentUserEnv.quietRuntimeLogs = true;
    installJurisdictions(concurrentUserEnv, sourceJ, targetJ);
    expect(registerTestSigner(concurrentUserEnv, seed, 'source-user')).toBe(sourceUserSigner);
    expect(registerTestSigner(concurrentUserEnv, seed, 'target-user')).toBe(targetUserSigner);
    addReplica(concurrentUserEnv, createEntityFrameCandidateState(liveSourceUserState), sourceUserSigner);
    addReplica(concurrentUserEnv, createEntityFrameCandidateState(liveTargetUserState), targetUserSigner);
    installTestGenesisLineage(concurrentUserEnv);
    concurrentUserEnv.gossip = userEnv.gossip;

    const admittedConcurrentRetries = await admitAtomicCrossJAccountInputs(
      concurrentUserEnv,
      mergedConcurrentRetries,
      false,
    );
    expect(admittedConcurrentRetries.inputs).toHaveLength(4);
    expect(admittedConcurrentRetries.pairs).toHaveLength(2);
    expect(admittedConcurrentRetries.inputs.map(input => input.sourceRuntimeFrame?.height).sort())
      .toEqual([42, 42, 43, 43]);
    const concurrentApplyCounts = new Map<string, number>();
    const concurrentEntityOutbox: RoutedEntityInput[] = [];
    for (const sourceRuntimeHeight of [42, 43]) {
      const cohort = admittedConcurrentRetries.inputs.filter(
        input => input.sourceRuntimeFrame?.height === sourceRuntimeHeight,
      );
      expect(cohort).toHaveLength(2);
      const concurrentApply = await applyMergedEntityInputs(concurrentUserEnv, cohort, [], {
        isReplay: false,
        routingDeps: makeLocalCrossJRoutingDeps(),
        beforeEntityApply: entityId => {
          refreshRuntimeCheckpointLineageForEntity(concurrentUserEnv, entityId);
          concurrentApplyCounts.set(entityId, (concurrentApplyCounts.get(entityId) ?? 0) + 1);
        },
      });
      expect(concurrentApply.rejectedAtomicPairs).toEqual([]);
      concurrentEntityOutbox.push(...concurrentApply.entityOutbox);
    }
    expect(concurrentApplyCounts).toEqual(new Map([
      [sourceUser, 2],
      [targetUser, 2],
    ]));
    expect(concurrentEntityOutbox).toHaveLength(4);
    const concurrentSourceState = concurrentUserEnv.state.eReplicas
      .get(`${sourceUser}:${sourceUserSigner}`)!.state;
    const concurrentTargetState = concurrentUserEnv.state.eReplicas
      .get(`${targetUser}:${targetUserSigner}`)!.state;
    expect(concurrentSourceState.crossJurisdictionAuthorizations?.size).toBe(0);
    expect(concurrentTargetState.crossJurisdictionAuthorizations?.size).toBe(0);
    expect([sourceHub, sourceHubB].map(id => concurrentSourceState.accounts.get(id)!.currentFrame.height))
      .toEqual([1, 1]);
    expect([targetHub, targetHubB].map(id => concurrentTargetState.accounts.get(id)!.currentFrame.height))
      .toEqual([1, 1]);
    const reversedProposals = [...proposals].reverse();
    const structuralPair = selectPotentialCrossJAccountInputPairs(reversedProposals)[0]!;
    expect(
      validateInboundP2PEntityInputsEnvelope(
        userEnv,
        hubEnv.runtimeId!,
        signRuntimeEntityInputsEnvelope(createEmptyEnv(`${seed}-hub`), userEnv.runtimeId!, {
          sourceRuntimeId: hubEnv.runtimeId!,
          sourceRuntimeHeight: hubFrame.height,
          sourceRuntimeTimestamp: hubFrame.timestamp,
          atomicCrossJurisdictionPair: { phase: 'proposal', pairKey: structuralPair.pairKey },
          entityInputs: reversedProposals.map(({ from: _from, sourceRuntimeFrame: _frame, ...input }) => input),
        }),
        makeLocalCrossJRoutingDeps(),
      ),
    ).toHaveLength(2);
    expect(selectMatchedCrossJAccountInputPairs(userEnv, [proposals[0]!]).inputs).toEqual([]);
    const ordinaryUserInput = { entityId: sourceUser, signerId: sourceUserSigner, entityTxs: [] };
    expect(selectMatchedCrossJAccountInputPairs(userEnv, [proposals[0]!, ordinaryUserInput]).inputs).toEqual([
      ordinaryUserInput,
    ]);
    const selectionAfterRejectedPrefix = selectMatchedCrossJAccountInputPairs(userEnv, [
      { ...proposals[0]!, sourceRuntimeFrame: { height: 41, timestamp: hubEnv.state.timestamp - 1 } },
      ordinaryUserInput,
      ...proposals,
    ]);
    expect(selectionAfterRejectedPrefix.inputs).toEqual([ordinaryUserInput, ...proposals]);
    expect(selectionAfterRejectedPrefix.pairs).toMatchObject([
      { sourceInputIndex: 1, targetInputIndex: 2 },
    ]);
    const proposalSelection = selectMatchedCrossJAccountInputPairs(userEnv, proposals);
    expect(proposalSelection.pairs.map(pair => pair.phase)).toEqual(['proposal']);
    expect(proposalSelection.rejectedLegs).toEqual([]);

    const proposalFrame = (input: RoutedEntityInput) => {
      const accountInput = getEffectiveEntityInputTxs(input).flatMap(tx =>
        tx.type === 'accountInput' ? [tx.data] : [],
      )[0];
      const proposal = accountInput ? accountInputProposal(accountInput) : undefined;
      if (!proposal) throw new Error(`TEST_CROSS_J_PROPOSAL_MISSING:${input.entityId}`);
      return proposal;
    };
    const targetPull = (inputs: RoutedEntityInput[]) => {
      const targetInput = inputs.find(input => input.entityId === targetUser);
      const pull =
        targetInput &&
        proposalFrame(targetInput).frame.accountTxs.find(
          tx => tx.type === 'cross_pull_lock' && tx.data.crossJurisdiction?.leg === 'target',
        );
      if (!pull || pull.type !== 'cross_pull_lock') throw new Error('TEST_CROSS_J_TARGET_PULL_MISSING');
      return pull;
    };
    const sourcePull = (inputs: RoutedEntityInput[]) => {
      const sourceInput = inputs.find(input => input.entityId === sourceUser);
      const pull =
        sourceInput &&
        proposalFrame(sourceInput).frame.accountTxs.find(
          tx => tx.type === 'cross_pull_lock' && tx.data.crossJurisdiction?.leg === 'source',
        );
      if (!pull || pull.type !== 'cross_pull_lock') throw new Error('TEST_CROSS_J_SOURCE_PULL_MISSING');
      return pull;
    };
    const corruptions: Array<{
      name: string;
      mutate(inputs: RoutedEntityInput[]): void;
    }> = [
      {
        name: 'cohort frame',
        mutate: inputs => {
          inputs[1]!.sourceRuntimeFrame!.height += 1;
        },
      },
      {
        name: 'route hash',
        mutate: inputs => {
          targetPull(inputs).data.crossJurisdiction!.routeHash = `0x${'f1'.repeat(32)}`;
        },
      },
      {
        name: 'target entity',
        mutate: inputs => {
          targetPull(inputs).data.crossJurisdictionRoute!.target.counterpartyEntityId = entity('ee');
        },
      },
      {
        name: 'source Account payer',
        mutate: inputs => {
          const sourceInput = inputs.find(input => input.entityId === sourceUser);
          const accountInput = sourceInput && getEffectiveEntityInputTxs(sourceInput)
            .find(tx => tx.type === 'accountInput');
          if (!accountInput || accountInput.type !== 'accountInput') {
            throw new Error('TEST_CROSS_J_SOURCE_ACCOUNT_INPUT_MISSING');
          }
          accountInput.data.fromEntityId = entity('ed');
        },
      },
      {
        name: 'asset',
        mutate: inputs => {
          targetPull(inputs).data.tokenId += 1;
        },
      },
      {
        name: 'amount',
        mutate: inputs => {
          targetPull(inputs).data.amount += 1n;
        },
      },
      {
        name: 'full hash',
        mutate: inputs => {
          targetPull(inputs).data.fullHash = `0x${'f2'.repeat(32)}`;
        },
      },
      {
        name: 'partial root',
        mutate: inputs => {
          targetPull(inputs).data.partialRoot = `0x${'f3'.repeat(32)}`;
        },
      },
      {
        name: 'pull id',
        mutate: inputs => {
          targetPull(inputs).data.pullId = 'corrupt-target-pull';
        },
      },
      {
        name: 'account Hanko',
        mutate: inputs => {
          proposalFrame(inputs[1]!).frameHanko = '0x00';
        },
      },
    ];
    const snapshotRuntimeCas = () => ({
      consumption: [...getConsumptionNodeStore(userEnv).keys()].sort(),
      pendingConsumption: [...(userEnv.infrastructure?.pendingConsumptionNodes?.keys() ?? [])].sort(),
      pendingConsumptionDeletes: [...(userEnv.infrastructure?.pendingConsumptionNodeDeletes ?? [])].sort(),
      claims: [...getAccountJClaimNodeStore(userEnv).keys()].sort(),
      pendingClaims: [...(userEnv.infrastructure?.pendingAccountJClaimNodes?.keys() ?? [])].sort(),
      pendingClaimDeletes: [...(userEnv.infrastructure?.pendingAccountJClaimNodeDeletes ?? [])].sort(),
    });
    let reducerRejectedProposalPairs = 0;
    for (const corruption of corruptions) {
      const corrupted = proposals.map(cloneIsolatedEntityInput);
      corruption.mutate(corrupted);
      publishTestRuntimeCheckpoint(userEnv);
      const casBefore = snapshotRuntimeCas();
      const replicasBefore = safeStringify(
        [...userEnv.state.eReplicas.entries()].map(([key, replica]) => [
          key,
          buildCanonicalEntityReplicaSnapshot(replica),
        ]),
      );
      const incidentsBefore = [...(userEnv.infrastructure?.securityIncidents?.values() ?? [])].reduce(
        (sum, incident) => sum + incident.occurrences,
        0,
      );
      const rejected = await admitAtomicCrossJAccountInputs(
        userEnv,
        [...corrupted, ordinaryUserInput],
        false,
      );
      if (rejected.pairs.length === 0) {
        expect(rejected.inputs, corruption.name).toEqual([ordinaryUserInput]);
      } else {
        try {
          const applied = await applyMergedEntityInputs(
            userEnv,
            rejected.inputs,
            [],
            { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
          );
          expect(applied.rejectedAtomicPairs, corruption.name).toHaveLength(1);
          expect(applied.appliedEntityInputs, corruption.name).toEqual([ordinaryUserInput]);
        } catch (error) {
          // Structurally paired but cryptographically corrupt AccountInput must
          // fail loud at the native Account verifier and roll back both legs.
          expect(String(error), corruption.name).toContain('ACCOUNT_PEER_');
        }
        reducerRejectedProposalPairs += 1;
      }
      expect(safeStringify(
        [...userEnv.state.eReplicas.entries()].map(([key, replica]) => [
          key,
          buildCanonicalEntityReplicaSnapshot(replica),
        ]),
      ), corruption.name).toBe(replicasBefore);
      expect(snapshotRuntimeCas(), corruption.name).toEqual(casBefore);
      const incidentsAfter = [...(userEnv.infrastructure?.securityIncidents?.values() ?? [])].reduce(
        (sum, incident) => sum + incident.occurrences,
        0,
      );
      if (rejected.pairs.length === 0) {
        expect(incidentsAfter, corruption.name).toBeGreaterThan(incidentsBefore);
      }
    }
    expect(reducerRejectedProposalPairs).toBeGreaterThan(0);

    const mixedCorruptPair = proposals.map(cloneIsolatedEntityInput);
    mixedCorruptPair[1]!.sourceRuntimeFrame!.height += 1;
    mixedCorruptPair[0]!.entityTxs = [
      ...(mixedCorruptPair[0]!.entityTxs ?? []),
      {
        type: 'chat',
        data: {
          from: sourceHubSigner,
          message: 'independent entity tx survives rejected cross-j legs',
        },
      },
    ];
    const mixedRejected = await admitAtomicCrossJAccountInputs(
      userEnv,
      mixedCorruptPair,
      false,
    );
    expect(mixedRejected.pairs).toEqual([]);
    expect(mixedRejected.inputs).toHaveLength(1);
    expect(getEffectiveEntityInputTxs(mixedRejected.inputs[0]!).map(tx => tx.type))
      .toEqual(['chat']);
    expect(mixedRejected.inputs[0]!.atomicCrossJurisdictionPair).toBeUndefined();

    const validThenCorruptCohorts = atomicRepeatedCohorts.map(cloneIsolatedEntityInput);
    const corruptNewestTarget = validThenCorruptCohorts.find(
      input => input.entityId === targetUser && input.sourceRuntimeFrame?.height === hubFrame.height,
    );
    if (!corruptNewestTarget) throw new Error('TEST_CROSS_J_NEWEST_TARGET_COHORT_MISSING');
    corruptNewestTarget.sourceRuntimeFrame!.height += 1;
    const retainedOlderCohort = await admitAtomicCrossJAccountInputs(
      userEnv,
      validThenCorruptCohorts,
      false,
    );
    expect(retainedOlderCohort.pairs).toHaveLength(1);
    expect(retainedOlderCohort.inputs).toHaveLength(2);
    expect(retainedOlderCohort.inputs.every(input => input.sourceRuntimeFrame?.height === 41)).toBe(true);

    const preparedUserInputs = await admitAtomicCrossJAccountInputs(
      userEnv,
      proposals,
      false,
    );
    const proposalApplyCounts = new Map<string, number>();
    const userAckPass = await applyMergedEntityInputs(userEnv, mergeEntityInputs(preparedUserInputs.inputs), [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
      beforeEntityApply: entityId => {
        refreshRuntimeCheckpointLineageForEntity(userEnv, entityId);
        proposalApplyCounts.set(entityId, (proposalApplyCounts.get(entityId) ?? 0) + 1);
      },
    });
    expect(proposalApplyCounts).toEqual(new Map([
      [sourceUser, 1],
      [targetUser, 1],
    ]));
    expect(userAckPass.entityOutbox.map(output => output.entityId).sort()).toEqual([sourceHub, targetHub].sort());
    expect(
      userAckPass.entityOutbox
        .flatMap(output => output.entityTxs ?? [])
        .every(
          tx => tx.type === 'accountInput' && (tx.data.kind === 'ack' || tx.data.kind === 'frame_ack'),
        ),
    ).toBe(true);
    expect(userAckPass.localCrossJurisdictionEventTrace).toEqual([]);
    publishTestRuntimeCheckpoint(userEnv);
    expect(userEnv.state.eReplicas.get(`${sourceUser}:${sourceUserSigner}`)?.state
      .crossJurisdictionAuthorizations?.has(intent.orderId)).toBe(false);
    expect(userEnv.state.eReplicas.get(`${targetUser}:${targetUserSigner}`)?.state
      .crossJurisdictionAuthorizations?.has(intent.orderId)).toBe(false);

    const accountFramesBeforeExactRetry = [...userEnv.state.eReplicas.entries()].map(
      ([entityKey, replica]) => [
        entityKey,
        [...replica.state.accounts.entries()].map(([counterpartyId, account]) => [
          counterpartyId,
          account.currentFrame.height,
          account.currentFrame.stateHash,
        ]),
      ] as const,
    );
    const exactRetry = await admitAtomicCrossJAccountInputs(
      userEnv,
      mergedRepeatedCohorts,
      false,
    );
    expect(exactRetry.inputs).toHaveLength(2);
    const exactRetryPass = await applyMergedEntityInputs(userEnv, exactRetry.inputs, [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
      beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(userEnv, entityId),
    });
    expect(exactRetryPass.rejectedAtomicPairs).toEqual([]);
    expect([...userEnv.state.eReplicas.entries()].map(
      ([entityKey, replica]) => [
        entityKey,
        [...replica.state.accounts.entries()].map(([counterpartyId, account]) => [
          counterpartyId,
          account.currentFrame.height,
          account.currentFrame.stateHash,
        ]),
      ] as const,
    )).toEqual(accountFramesBeforeExactRetry);

    const userFrame = { height: 43, timestamp: userEnv.state.timestamp };
    const acknowledgements = userAckPass.entityOutbox.map(output => ({
      ...output,
      from: userEnv.runtimeId,
      runtimeId: hubEnv.runtimeId,
      sourceRuntimeFrame: userFrame,
      atomicCrossJurisdictionPair: {
        phase: 'ack' as const,
        pairKey: proposalSelection.pairs[0]!.pairKey,
      },
    }));
    const acknowledgement = (input: RoutedEntityInput) => {
      const accountInput = getEffectiveEntityInputTxs(input).flatMap(tx =>
        tx.type === 'accountInput' ? [tx.data] : [],
      )[0];
      const ack = accountInput ? accountInputAck(accountInput) : undefined;
      if (!accountInput || !ack) throw new Error(`TEST_CROSS_J_ACK_MISSING:${input.entityId}`);
      return { accountInput, ack };
    };
    const ackCorruptions: Array<{
      name: string;
      mutate(inputs: RoutedEntityInput[]): void;
    }> = [
      {
        name: 'ACK cohort frame',
        mutate: inputs => {
          inputs[1]!.sourceRuntimeFrame!.height += 1;
        },
      },
      {
        name: 'ACK height',
        mutate: inputs => {
          acknowledgement(inputs[1]!).ack.height += 1;
        },
      },
      {
        name: 'ACK frame hash',
        mutate: inputs => {
          acknowledgement(inputs[1]!).ack.frameHash = `0x${'f4'.repeat(32)}`;
        },
      },
      {
        name: 'ACK Hanko',
        mutate: inputs => {
          acknowledgement(inputs[1]!).ack.frameHanko = '0x00';
        },
      },
      {
        name: 'ACK sender entity',
        mutate: inputs => {
          acknowledgement(inputs[1]!).accountInput.fromEntityId = entity('ef');
        },
      },
      {
        name: 'ACK domain',
        mutate: inputs => {
          acknowledgement(inputs[1]!).accountInput.domain.chainId += 1;
        },
      },
    ];
    const ordinaryHubInput = { entityId: sourceHub, signerId: sourceHubSigner, entityTxs: [] };
    let reducerRejectedAckPairs = 0;
    for (const corruption of ackCorruptions) {
      const corrupted = acknowledgements.map(cloneIsolatedEntityInput);
      corruption.mutate(corrupted);
      publishTestRuntimeCheckpoint(hubEnv);
      const replicasBefore = safeStringify(
        [...hubEnv.state.eReplicas.entries()].map(([key, replica]) => [
          key,
          buildCanonicalEntityReplicaSnapshot(replica),
        ]),
      );
      const incidentsBefore = [...(hubEnv.infrastructure?.securityIncidents?.values() ?? [])].reduce(
        (sum, incident) => sum + incident.occurrences,
        0,
      );
      const rejected = await admitAtomicCrossJAccountInputs(
        hubEnv,
        [...corrupted, ordinaryHubInput],
        false,
      );
      if (rejected.pairs.length === 0) {
        expect(rejected.inputs, corruption.name).toEqual([ordinaryHubInput]);
      } else {
        for (const replica of hubEnv.state.eReplicas.values()) {
          if (replica.certifiedFrameHead) {
            throw new Error(`TEST_RUNTIME_CHECKPOINT_HEAD_RETAINED:${corruption.name}:${replica.entityId}`);
          }
        }
        try {
          const applied = await applyMergedEntityInputs(
            hubEnv,
            rejected.inputs,
            [],
            {
              isReplay: false,
              routingDeps: makeLocalCrossJRoutingDeps(),
            },
          );
          expect(applied.rejectedAtomicPairs, corruption.name).toHaveLength(1);
          expect(applied.appliedEntityInputs, corruption.name).toEqual([ordinaryHubInput]);
        } catch (error) {
          expect(String(error), corruption.name).toContain('ACCOUNT_PEER_');
        }
        reducerRejectedAckPairs += 1;
      }
      expect(safeStringify(
        [...hubEnv.state.eReplicas.entries()].map(([key, replica]) => [
          key,
          buildCanonicalEntityReplicaSnapshot(replica),
        ]),
      ), corruption.name).toBe(replicasBefore);
      const incidentsAfter = [...(hubEnv.infrastructure?.securityIncidents?.values() ?? [])].reduce(
        (sum, incident) => sum + incident.occurrences,
        0,
      );
      if (rejected.pairs.length === 0) {
        expect(incidentsAfter, corruption.name).toBeGreaterThan(incidentsBefore);
      }
    }
    expect(reducerRejectedAckPairs).toBeGreaterThan(0);
    const queuedIntent = withCanonicalCrossJurisdictionRouteHash({
      ...cloneCrossJurisdictionRoute(intent),
      orderId: 'cross-j-atomic-opening-next',
      routeHash: '',
      status: 'intent',
      sourcePull: undefined,
      targetPull: undefined,
    });
    const sourceHubReplica = hubEnv.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!;
    const schedulingReplica: EntityReplica = {
      ...sourceHubReplica,
      state: createEntityFrameCandidateState(sourceHubReplica.state),
      mempool: [...sourceHubReplica.mempool],
    };
    schedulingReplica.state.crossJurisdictionSwaps?.set(queuedIntent.orderId, queuedIntent);
    const queuedMaterialization = appendDefaultProposerCrossJMaterializations(hubEnv, schedulingReplica, []);
    expect(queuedMaterialization.map(tx => tx.type)).toEqual(['materializeCrossJurisdictionSwap']);
    const queuedCommands = prepareLocallyAuthoredEntityTxs(
      hubEnv,
      schedulingReplica.state,
      sourceHubSigner,
      queuedMaterialization,
    );
    schedulingReplica.mempool.push(...queuedCommands);
    const sourceAckInput = acknowledgements.find(input => input.entityId === sourceHub)!;
    const ackPhaseTxs = appendDefaultProposerCrossJMaterializations(
      hubEnv,
      schedulingReplica,
      sourceAckInput.entityTxs ?? [],
    );
    expect(ackPhaseTxs).toEqual(sourceAckInput.entityTxs);
    expect(ackPhaseTxs.some(tx => tx.type === 'materializeCrossJurisdictionSwap')).toBe(false);
    const phaseSelection = selectCrossJCommitPhaseTxs([
      ...schedulingReplica.mempool,
      ...(sourceAckInput.entityTxs ?? []),
    ]);
    expect(phaseSelection.deferredCrossJSetup).toBe(true);
    expect(phaseSelection.txs).toEqual(sourceAckInput.entityTxs);
    sourceHubReplica.mempool.push(...queuedCommands);
    expect(selectMatchedCrossJAccountInputPairs(hubEnv, [acknowledgements[0]!]).inputs).toEqual([]);
    const ackSelection = selectMatchedCrossJAccountInputPairs(hubEnv, acknowledgements);
    expect(ackSelection.pairs.map(pair => pair.phase)).toEqual(['ack']);
    expect(ackSelection.rejectedLegs).toEqual([]);

    hubEnv.state.timestamp += ACCOUNT_PENDING_RESEND_AFTER_MS + 1;
    const dueWake = createDueScheduledWakeInputs(hubEnv, hubEnv.state.timestamp).find(input => input.entityId === sourceHub);
    if (!dueWake) throw new Error('TEST_CROSS_J_SOURCE_HUB_WAKE_MISSING');
    expect(
      dueWake.entityTxs?.flatMap(tx => (tx.type === 'scheduledWake' ? tx.data.jobs.map(job => job.id) : [])),
    ).toContain('maintainPendingAccounts');
    const preparedHubInputsWithWake = await admitAtomicCrossJAccountInputs(
      hubEnv,
      mergeEntityInputs([...acknowledgements, dueWake]),
      false,
    );
    expect(preparedHubInputsWithWake.pairs.map(pair => pair.phase)).toEqual(['ack']);
    expect(
      preparedHubInputsWithWake.inputs.slice(0, 2).every(input => input.atomicCrossJurisdictionPair?.phase === 'ack'),
    ).toBe(true);
    expect(preparedHubInputsWithWake.inputs[2]?.entityTxs?.some(tx => tx.type === 'scheduledWake')).toBe(true);
    expect(
      preparedHubInputsWithWake.inputs.some(input => input.entityTxs?.some(tx => tx.type === 'scheduledWake')),
    ).toBe(true);

    const preparedHubInputs = await admitAtomicCrossJAccountInputs(
      hubEnv,
      acknowledgements,
      false,
    );
    const hubAckPass = await applyMergedEntityInputs(hubEnv, mergeEntityInputs(preparedHubInputs.inputs), [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
      beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(hubEnv, entityId),
    });
    expect(hubAckPass.rejectedAtomicPairs).toEqual([]);
    expect(
      hubEnv.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.state.accounts.get(sourceUser)?.currentFrame.height,
    ).toBe(1);
    expect(
      hubEnv.state.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.state.accounts.get(targetUser)?.currentFrame.height,
    ).toBe(1);
    expect(
      hubEnv.state.eReplicas
        .get(`${sourceHub}:${sourceHubSigner}`)
        ?.state.accounts.get(sourceUser)
        ?.currentFrame.accountTxs.map(tx => tx.type),
    ).toEqual(['cross_pull_lock', 'swap_offer']);
    expect(
      hubEnv.state.eReplicas
        .get(`${targetHub}:${targetHubSigner}`)
        ?.state.accounts.get(targetUser)
        ?.currentFrame.accountTxs.map(tx => tx.type),
    ).toEqual(['cross_pull_lock']);
    expect(hubEnv.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.state.orderbookExt?.books.size).toBe(1);
    expect(hubAckPass.entityOutbox).toEqual([]);
    expect(
      hubEnv.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.mempool.some(entityTxContainsCrossJMaterialization),
    ).toBe(true);

    const retainedProposalCohort = rescheduleDeferredOutputs(hubEnv, [], proposals, [], makeLocalCrossJRoutingDeps());
    expect(retainedProposalCohort).toHaveLength(2);
    // Best-effort delivery: the failed cohort retries as one envelope after backoff.
    expect(hubEnv.infrastructure?.deferredNetworkMeta?.size).toBe(2);

    // One partial fill follows the same exact 2-leg proposal/ACK protocol as
    // opening and close. A lone or divergent target progress leg changes 0/2
    // user siblings; only the exact pair advances both route mirrors.
    const openedSourceHub = hubEnv.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!;
    openedSourceHub.mempool = openedSourceHub.mempool.filter(tx =>
      !entityTxContainsCrossJMaterialization(tx));
    const fillPass = await applyMergedEntityInputs(
      hubEnv,
      [{
        entityId: sourceHub,
        signerId: sourceHubSigner,
        entityTxs: [{
          type: 'crossJurisdictionFillNotice',
          data: {
            orderId: intent.orderId,
            routeHash: prepared.routeHash,
            previousFillSeq: 0,
            fillSeq: 1,
            incrementalSourceAmount: 500n,
            incrementalTargetAmount: 450n,
            cumulativeSourceAmount: 500n,
            cumulativeTargetAmount: 450n,
            cumulativeFillRatio: 32_768,
            fillNumerator: 1n,
            fillDenominator: 2n,
            pairId: prepared.venueId || '',
          },
        }],
      }],
      [],
      {
        isReplay: false,
        routingDeps: makeLocalCrossJRoutingDeps(),
        beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(hubEnv, entityId),
      },
    );
    expect(fillPass.entityOutbox.map(output => output.entityId).sort())
      .toEqual([sourceHub, targetHub, sourceUser, targetUser].sort());
    const fillFrame = { height: 44, timestamp: hubEnv.state.timestamp };
    const fillProposals = fillPass.entityOutbox
      .filter(output => output.entityId === sourceUser || output.entityId === targetUser)
      .map(output => ({
        ...output,
        from: hubEnv.runtimeId,
        runtimeId: userEnv.runtimeId,
        sourceRuntimeFrame: fillFrame,
      }));
    const adjacentFillProposals = fillProposals.map(cloneIsolatedEntityInput);
    adjacentFillProposals[1]!.sourceRuntimeFrame!.height += 1;
    expect(groupAtomicCrossJAdmissionOutputs([adjacentFillProposals[0]!])).toMatchObject([
      { atomic: true, complete: false },
    ]);
    expect(groupAtomicCrossJAdmissionOutputs(adjacentFillProposals)).toMatchObject([
      { atomic: true, complete: true },
    ]);
    expect(selectPotentialCrossJAccountInputPairs(fillProposals)).toHaveLength(1);
    expect(selectMatchedCrossJAccountInputPairs(userEnv, [fillProposals[0]!]).inputs).toEqual([]);
    const corruptFill = fillProposals.map(cloneIsolatedEntityInput);
    const targetFillProposal = corruptFill.find(input => input.entityId === targetUser);
    const targetProgress = targetFillProposal && proposalFrame(targetFillProposal).frame.accountTxs.find(
      tx => tx.type === 'cross_pull_progress',
    );
    if (!targetProgress || targetProgress.type !== 'cross_pull_progress') {
      throw new Error('TEST_CROSS_J_TARGET_PROGRESS_MISSING');
    }
    targetProgress.data.fill.cumulativeTargetAmount! += 1n;
    expect(selectMatchedCrossJAccountInputPairs(userEnv, corruptFill).inputs).toEqual([]);

    const admittedFill = await admitAtomicCrossJAccountInputs(userEnv, fillProposals, false);
    expect(admittedFill.pairs).toHaveLength(1);
    const userFillPass = await applyMergedEntityInputs(userEnv, admittedFill.inputs, [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
      beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(userEnv, entityId),
    });
    expect(userFillPass.entityOutbox.map(output => output.entityId).sort())
      .toEqual([sourceHub, targetHub].sort());
    expect(userEnv.state.eReplicas.get(`${sourceUser}:${sourceUserSigner}`)
      ?.state.crossJurisdictionSwaps?.get(intent.orderId)?.status).toBe('partially_filled');
    expect(userEnv.state.eReplicas.get(`${targetUser}:${targetUserSigner}`)
      ?.state.crossJurisdictionSwaps?.get(intent.orderId)?.status).toBe('partially_filled');

    const fillAckFrame = { height: 45, timestamp: userEnv.state.timestamp };
    const fillAcks = userFillPass.entityOutbox.map(output => ({
      ...output,
      from: userEnv.runtimeId,
      runtimeId: hubEnv.runtimeId,
      sourceRuntimeFrame: fillAckFrame,
    }));
    const admittedFillAcks = await admitAtomicCrossJAccountInputs(hubEnv, fillAcks, false);
    expect(admittedFillAcks.pairs).toHaveLength(1);
    await applyMergedEntityInputs(hubEnv, admittedFillAcks.inputs, [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
      beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(hubEnv, entityId),
    });
    expect(hubEnv.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)
      ?.state.crossJurisdictionSwaps?.get(intent.orderId)?.status).toBe('partially_filled');
    expect(hubEnv.state.eReplicas.get(`${targetHub}:${targetHubSigner}`)
      ?.state.crossJurisdictionSwaps?.get(intent.orderId)?.status).toBe('partially_filled');

    hubEnv.state.timestamp = prepared.expiresAt! + 1;
    userEnv.state.timestamp = hubEnv.state.timestamp;
    const cancelPass = await applyMergedEntityInputs(
      hubEnv,
      [{
        entityId: sourceHub,
        signerId: sourceHubSigner,
        entityTxs: [{
          type: 'orderbookSweepCrossJurisdiction',
          data: { reason: 'runtime-l2-expiry' },
        }],
      }],
      [],
      {
        isReplay: false,
        routingDeps: makeLocalCrossJRoutingDeps(),
        beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(hubEnv, entityId),
      },
    );
    const cancelFrame = { height: 46, timestamp: hubEnv.state.timestamp };
    const cancelProposals = cancelPass.entityOutbox
      .filter(output => output.entityId === sourceUser || output.entityId === targetUser)
      .map(output => ({
        ...output,
        from: hubEnv.runtimeId,
        runtimeId: userEnv.runtimeId,
        sourceRuntimeFrame: cancelFrame,
      }));
    const cancelTargetNotices = cancelPass.localCrossJurisdictionEventTrace.filter(input =>
      getEffectiveEntityInputTxs(input).some(tx => tx.type === 'crossJurisdictionFillNotice'));
    expect(cancelTargetNotices).toHaveLength(1);
    expect(cancelTargetNotices[0]).toMatchObject({ entityId: targetHub, signerId: targetHubSigner });
    expect(cancelProposals).toHaveLength(2);
    const cancelAccountTxs = cancelProposals.flatMap(input => proposalFrame(input).frame.accountTxs);
    const sourceCancel = cancelAccountTxs.find(
      (tx): tx is Extract<AccountTx, { type: 'cross_swap_fill_ack' }> => tx.type === 'cross_swap_fill_ack',
    );
    const targetCancel = cancelAccountTxs.find(
      (tx): tx is Extract<AccountTx, { type: 'cross_pull_progress' }> => tx.type === 'cross_pull_progress',
    );
    if (!sourceCancel || !targetCancel) throw new Error('TEST_CROSS_J_CANCEL_PAIR_MISSING');
    expect(targetCancel.data.fill).toEqual(sourceCancel.data);
    expect(selectMatchedCrossJAccountInputPairs(userEnv, [cancelProposals[0]!]).inputs).toEqual([]);
    expect(selectPotentialCrossJAccountInputPairs(cancelProposals)).toHaveLength(1);
    expect(cancelProposals.find(input => input.entityId === targetUser)?.signerId).toBe(targetUserSigner);
    const cancelTypes = cancelProposals
      .flatMap(input => proposalFrame(input).frame.accountTxs.map(tx => tx.type))
      .sort();
    expect(cancelTypes).toEqual(['cross_pull_progress', 'cross_swap_fill_ack']);

    const admittedCancel = await admitAtomicCrossJAccountInputs(userEnv, cancelProposals, false);
    expect(admittedCancel.pairs).toHaveLength(1);
    const userCancelPass = await applyMergedEntityInputs(userEnv, admittedCancel.inputs, [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
      beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(userEnv, entityId),
    });
    expect(userEnv.state.eReplicas.get(`${sourceUser}:${sourceUserSigner}`)
      ?.state.crossJurisdictionSwaps?.get(intent.orderId)?.status).toBe('clear_requested');
    expect(userEnv.state.eReplicas.get(`${targetUser}:${targetUserSigner}`)
      ?.state.crossJurisdictionSwaps?.get(intent.orderId)?.status).toBe('clear_requested');

    const cancelAckFrame = { height: 47, timestamp: userEnv.state.timestamp };
    const cancelAcks = userCancelPass.entityOutbox.map(output => ({
      ...output,
      from: userEnv.runtimeId,
      runtimeId: hubEnv.runtimeId,
      sourceRuntimeFrame: cancelAckFrame,
    }));
    const admittedCancelAcks = await admitAtomicCrossJAccountInputs(hubEnv, cancelAcks, false);
    expect(admittedCancelAcks.pairs).toHaveLength(1);
    const hubCancelAckPass = await applyMergedEntityInputs(hubEnv, admittedCancelAcks.inputs, [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
      beforeEntityApply: entityId => refreshRuntimeCheckpointLineageForEntity(hubEnv, entityId),
    });
    expect(hubCancelAckPass.localCrossJurisdictionEventTrace.filter(input =>
      getEffectiveEntityInputTxs(input).some(tx => tx.type === 'crossJurisdictionFillNotice'))).toEqual([]);
    expect(hubEnv.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)
      ?.state.crossJurisdictionSwaps?.get(intent.orderId)?.status).toBe('clear_requested');
    expect(hubEnv.state.eReplicas.get(`${targetHub}:${targetHubSigner}`)
      ?.state.crossJurisdictionSwaps?.get(intent.orderId)?.status).toBe('clear_requested');

  });

  test('submitCrossJurisdictionSwap queues hub prepare, then prepare builds symmetric pull commitments', async () => {
    const env = createEmptyEnv('cross-submit');
    const hubEnv = createEmptyEnv('cross-submit-hub-runtime');
    env.scenarioMode = true;
    hubEnv.scenarioMode = true;
    env.state.timestamp = 10_000;
    hubEnv.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    hubEnv.quietRuntimeLogs = true;
    env.infrastructure!.lifecyclePhase = 'running';
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    installJurisdictions(env, eth, base);
    installJurisdictions(hubEnv, eth, base);
    env.activeJurisdiction = eth.name;
    env.state.jReplicas.set(eth.name, {
      name: eth.name,
      chainId: eth.chainId,
      rpcs: [eth.address],
      contracts: { depository: eth.depositoryAddress, entityProvider: eth.entityProviderAddress },
      blockTimeMs: eth.blockTimeMs,
    } as any);
    env.state.jReplicas.set(base.name, {
      name: base.name,
      chainId: base.chainId,
      rpcs: [base.address],
      contracts: { depository: base.depositoryAddress, entityProvider: base.entityProviderAddress },
      blockTimeMs: 200,
    } as any);

    const sourceUser = entity('01');
    const sourceHub = entity('02');
    const targetHub = entity('03');
    const targetUser = entity('04');
    const sourceUserSigner = registerTestSigner(env, 'cross-submit', 'source-user');
    const targetUserSigner = registerTestSigner(env, 'cross-submit', 'target-user');
    const sourceHubSigner = registerTestSigner(hubEnv, 'cross-submit', 'source-hub');
    const targetHubSigner = registerTestSigner(hubEnv, 'cross-submit', 'target-hub');
    const sourceUserState = makeState(sourceUser, sourceUserSigner, eth, sourceHub);
    const targetUserState = makeState(targetUser, targetUserSigner, base, targetHub);
    const sourceHubState = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    const targetHubState = makeState(targetHub, targetHubSigner, base, targetUser);
    sourceHubState.profile.isHub = true;
    targetHubState.profile.isHub = true;
    addReplica(env, sourceUserState, sourceUserSigner);
    addReplica(env, targetUserState, targetUserSigner);
    addReplica(hubEnv, sourceHubState, sourceHubSigner);
    addReplica(hubEnv, targetHubState, targetHubSigner);
    const routingDeps = makeLocalCrossJRoutingDeps();
    registerEntityRuntimeHintWithDeps(env, sourceHub, hubEnv.runtimeId!, routingDeps);
    registerEntityRuntimeHintWithDeps(env, targetHub, hubEnv.runtimeId!, routingDeps);
    registerEntityRuntimeHintWithDeps(hubEnv, sourceUser, env.runtimeId!, routingDeps);
    registerEntityRuntimeHintWithDeps(hubEnv, targetUser, env.runtimeId!, routingDeps);
    registerVerifiedOwnerRoute(env, sourceHub, sourceHubSigner, hubEnv.runtimeId!);
    registerVerifiedOwnerRoute(env, targetHub, targetHubSigner, hubEnv.runtimeId!);
    registerVerifiedOwnerRoute(hubEnv, sourceUser, sourceUserSigner, env.runtimeId!);
    registerVerifiedOwnerRoute(hubEnv, targetUser, targetUserSigner, env.runtimeId!);
    const submitParams = {
      orderId: 'cross-test-1',
      sourceUserEntityId: sourceUser,
      sourceHubEntityId: sourceHub,
      targetHubEntityId: targetHub,
      targetUserEntityId: targetUser,
      sourceTokenId: 1,
      sourceAmount: 100n,
      targetTokenId: 1,
      targetAmount: 90n,
      sourceUserSignerId: sourceUserSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetUserSignerId: targetUserSigner,
      bookHubSignerId: sourceHubSigner,
    } as const;
    const result = await submitCrossJurisdictionSwap(env, submitParams);
    await submitCrossJurisdictionSwap(env, submitParams);
    expect(hubEnv.runtimeMempool?.entityInputs).toEqual([]);
    expect(env.runtimeMempool?.entityInputs).toHaveLength(4);
    const attackerEnv = createEmptyEnv('cross-submit-relay-attacker');
    const attackerEnvelope = signRuntimeEntityInputsEnvelope(attackerEnv, hubEnv.runtimeId!, {
      sourceRuntimeId: attackerEnv.runtimeId!,
      sourceRuntimeHeight: env.state.height,
      sourceRuntimeTimestamp: env.state.timestamp,
      entityInputs: [{
        entityId: sourceHub,
        signerId: sourceHubSigner,
        runtimeId: hubEnv.runtimeId!,
        entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route: structuredClone(result.route) } }],
      }],
    });
    expect(() => handleInboundP2PEntityInputs(hubEnv, env.runtimeId!, {
      ...attackerEnvelope,
      // A relay could forge this outer/header identity before envelope auth.
      sourceRuntimeId: env.runtimeId!,
    })).toThrow('INBOUND_ENTITY_INPUTS_SOURCE_SIGNATURE_INVALID');
    expect(hubEnv.runtimeMempool?.entityInputs).toEqual([]);
    registerVerifiedOwnerRoute(env, targetHub, targetHubSigner, addr('fe'));
    await expect(submitCrossJurisdictionIntent(env, result.route))
      .rejects.toThrow('OWNER_RUNTIME_MISMATCH');
    registerVerifiedOwnerRoute(env, targetHub, targetHubSigner, hubEnv.runtimeId!);
    await expect(submitCrossJurisdictionSwap(env, {
      ...submitParams,
      targetHubSignerId: addr('fd'),
    })).rejects.toThrow('CROSS_SWAP_OWNER_SIGNER_NON_CANONICAL');
    const queuedUserAuthorizations = structuredClone(env.runtimeMempool!.entityInputs);
    env.runtimeMempool!.entityInputs = [];
    const targetAuthorization = await applyEntityTx(
      env,
      env.state.eReplicas.get(`${targetUser}:${targetUserSigner}`)!.state,
      queuedUserAuthorizations[0]!.entityTxs![0]!,
    );
    const sourceAuthorization = await applyEntityTx(
      env,
      env.state.eReplicas.get(`${sourceUser}:${sourceUserSigner}`)!.state,
      queuedUserAuthorizations[1]!.entityTxs![0]!,
    );
    const targetRetry = await applyEntityTx(
      env,
      targetAuthorization.newState,
      queuedUserAuthorizations[2]!.entityTxs![0]!,
    );
    const sourceRetry = await applyEntityTx(
      env,
      sourceAuthorization.newState,
      queuedUserAuthorizations[3]!.entityTxs![0]!,
    );
    expect(targetRetry.outputs).toEqual([]);
    // Identical source auth is an honest retry: re-emit hub prepare (lost command / late hub).
    expect(sourceRetry.outputs).toHaveLength(1);
    expect(sourceRetry.outputs[0]?.entityTxs?.[0]?.type).toBe('prepareCrossJurisdictionSwap');
    env.state.eReplicas.get(`${targetUser}:${targetUserSigner}`)!.state = targetRetry.newState;
    env.state.eReplicas.get(`${sourceUser}:${sourceUserSigner}`)!.state = sourceRetry.newState;
    expect(sourceAuthorization.outputs).toHaveLength(1);
    expect(sourceAuthorization.outputs[0]?.entityId).toBe(sourceHub);
    expect(sourceRetry.newState.crossJurisdictionAuthorizations?.has(result.route.orderId)).toBe(true);
    expect(targetRetry.newState.crossJurisdictionAuthorizations?.has(result.route.orderId)).toBe(true);

    await submitCrossJurisdictionSwap(env, {
      ...submitParams,
      targetAmount: 91n,
    });
    const conflictingUserAuthorizations = structuredClone(env.runtimeMempool!.entityInputs);
    env.runtimeMempool!.entityInputs = [];
    await expect(applyEntityTx(
      env,
      targetRetry.newState,
      conflictingUserAuthorizations[0]!.entityTxs![0]!,
    )).rejects.toThrow('CROSS_J_USER_AUTH_CONFLICT');
    const targetReceivingState = env.state.eReplicas
      .get(`${targetUser}:${targetUserSigner}`)!.state;
    const targetReceivingAccount = getEntityAccountForWrite(targetReceivingState.accounts, targetHub);
    if (!targetReceivingAccount) throw new Error('TEST_TARGET_ACCOUNT_MISSING');
    const targetReceivingDelta = targetReceivingAccount.state.deltas.get(1)!;
    const originalTargetDeltas = targetReceivingAccount.state.deltas;
    targetReceivingAccount.state.deltas = originalTargetDeltas.updated(1, {
      ...targetReceivingDelta,
      leftCreditLimit: 0n,
      rightCreditLimit: 0n,
    });
    await expect(submitCrossJurisdictionIntent(env, result.route)).rejects.toThrow('CROSS_J_TARGET_INBOUND_NOT_READY');
    targetReceivingAccount.state.deltas = originalTargetDeltas;

    const queued = sourceAuthorization.outputs;
    expect(result.hashlock).toBeUndefined();
    expect(result.secret).toBeUndefined();
    expect(result.route.routeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.route.source.jurisdiction).toBe(jref(eth));
    expect(result.route.target.jurisdiction).toBe(jref(base));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.entityId).toBe(sourceHub);
    expect(queued[0]?.from).toBeUndefined();
    expect(queued[0]?.sourceRuntimeFrame).toBeUndefined();
    expect(getEffectiveEntityInputTxs(queued[0]!)?.[0]?.type).toBe('prepareCrossJurisdictionSwap');
    expect(env.runtimeMempool?.entityInputs).toEqual([]);

    sourceHubState.timestamp = hubEnv.state.timestamp;
    const sourceHubPrepare = getEffectiveEntityInputTxs(queued[0]!)[0];
    if (sourceHubPrepare?.type !== 'prepareCrossJurisdictionSwap') {
      throw new Error('TEST_CROSS_J_CERTIFIED_PREPARE_MISSING');
    }
    const requested = await applyEntityTx(hubEnv, sourceHubState, sourceHubPrepare);
    expect(requested.outputs).toEqual([{ entityId: sourceHub, signerId: sourceHubSigner, entityTxs: [] }]);
    expect(requested.accountTxs).toBeUndefined();
    const sourceHubReplica = {
      ...(hubEnv.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`) as EntityReplica),
      state: requested.newState,
    };
    const materialized = appendDefaultProposerCrossJMaterializations(hubEnv, sourceHubReplica, []);
    expect(materialized).toHaveLength(1);
    expect(materialized[0]?.type).toBe('materializeCrossJurisdictionSwap');
    const prepared = await applyEntityTx(hubEnv, requested.newState, materialized[0]!);
    expect(prepared.accountTxs).toBeUndefined();
    expect(prepared.outputs).toHaveLength(2);
    const sourceHubOutput = prepared.outputs.find(output => output.entityId === sourceHub);
    const targetHubOutput = prepared.outputs.find(output => output.entityId === targetHub);
    const targetUserOutput = prepared.outputs.find(output => output.entityId === targetUser);
    const sourceUserOutput = prepared.outputs.find(output => output.entityId === sourceUser);
    expect(sourceHubOutput?.entityTxs?.map(tx => tx.type)).toEqual(['registerCrossJurisdictionSwap']);
    expect(targetHubOutput?.entityTxs?.map(tx => tx.type)).toEqual(['registerCrossJurisdictionSwap']);
    expect(targetUserOutput).toBeUndefined();
    expect(sourceUserOutput).toBeUndefined();
    const preparedRoute = (targetHubOutput?.entityTxs?.[0]?.data as any).route;
    expect(preparedRoute.routeHash).toBe(result.route.routeHash);
    expect(deriveCrossJurisdictionRouteHash(preparedRoute)).toBe(preparedRoute.routeHash);
    expect(preparedRoute.sourcePull.fullHash).toBe(preparedRoute.targetPull.fullHash);
    expect(preparedRoute.sourcePull.partialRoot).toBe(preparedRoute.targetPull.partialRoot);
    // No sealed pull reveal deadlines — settlement is dispute-relative on L1.
    expect(preparedRoute.sourcePull.revealedUntilTimestamp).toBeUndefined();
    expect(preparedRoute.targetPull.revealedUntilTimestamp).toBeUndefined();
    const sourceRegistration = await applyEntityTx(hubEnv, prepared.newState, sourceHubOutput!.entityTxs![0]!);
    const targetRegistration = await applyEntityTx(hubEnv, targetHubState, targetHubOutput!.entityTxs![0]!);
    expect(sourceRegistration.accountTxs?.map(op => op.tx.type)).toEqual(['cross_pull_lock', 'swap_offer']);
    expect(targetRegistration.accountTxs?.map(op => op.tx.type)).toEqual(['cross_pull_lock']);
    expect(sourceRegistration.outputs).toEqual([]);
    expect(targetRegistration.outputs).toEqual([]);
    const exactRetry = await applyEntityTx(
      hubEnv,
      sourceRegistration.newState,
      sourceHubOutput!.entityTxs![0]!,
    );
    expect(exactRetry.accountTxs).toBeUndefined();
    expect(exactRetry.outputs).toEqual([]);
    expect((targetRegistration.accountTxs?.[0]?.tx as any).data.crossJurisdiction).toMatchObject({
      orderId: preparedRoute.orderId,
      routeHash: preparedRoute.routeHash,
      leg: 'target',
    });
  });

  test('prepared cross-j route keeps immutable routeHash through alias-named source commit and clear', async () => {
    const env = createEmptyEnv('cross-prepared-routehash-immutable');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceHubJurisdiction = makeJurisdiction('Arrakis (Shared Anvil)', 31337, '11', '12');
    const sourceUserAliasJurisdiction = makeJurisdiction('Testnet', 31337, '11', '12');
    const targetJurisdiction = makeJurisdiction('Tron', 31338, '21', '22');
    for (const jurisdiction of [sourceHubJurisdiction, sourceUserAliasJurisdiction, targetJurisdiction]) {
      env.state.jReplicas.set(jurisdiction.name, {
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        rpcs: [jurisdiction.address],
        contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress },
        blockTimeMs: jurisdiction.blockTimeMs,
      } as any);
    }
    const sourceUser = entity('aa');
    const sourceHub = entity('ab');
    const targetHub = entity('ac');
    const targetUser = entity('ad');
    const sourceHubState = createEntityFrameCandidateState(
      makeState(sourceHub, addr('ae'), sourceHubJurisdiction, sourceUser),
    );
    const sourceUserState = makeState(sourceUser, addr('af'), sourceUserAliasJurisdiction, sourceHub);
    const targetHubState = makeState(targetHub, addr('b0'), targetJurisdiction, targetUser);
    const targetUserState = makeState(targetUser, addr('b1'), targetJurisdiction, targetHub);
    const volatileDelta = createDefaultDelta(2);
    volatileDelta.leftCreditLimit = 10n ** 30n;
    volatileDelta.rightCreditLimit = 10n ** 30n;
    const sourceHubAccount = getEntityAccountForWrite(sourceHubState.accounts, sourceUser);
    if (!sourceHubAccount) throw new Error('TEST_SOURCE_HUB_ACCOUNT_MISSING');
    sourceHubAccount.state.deltas = requirePersistentAccountStateMap(
      sourceHubAccount.state.deltas,
      'deltas',
    ).updated(2, volatileDelta);
    // This case intentionally uses a volatile source token. Seed the signed
    // Hub-local USD authority price that production MM bootstrap publishes
    // before a Hub is allowed to lock a cross-j Account route.
    sourceHubState.orderbookExt = createOrderbookExtState({
      entityId: sourceHub,
      name: 'source hub',
      spreadDistribution: {
        makerBps: 0,
        takerBps: 10_000,
        hubBps: 0,
        makerReferrerBps: 0,
        takerReferrerBps: 0,
      },
      referenceTokenId: 1,
      usdQuoteAuthorityEntityId: sourceHub,
      minTradeSize: 0n,
      supportedPairs: [],
    });
    sourceHubState.orderbookExt.books.set(
      '1/2',
      recordAcceptedUsdAskPrice(
        createBook({ bucketWidthTicks: 10_000n, maxOrders: 16, stpPolicy: 0 }),
        ORDERBOOK_PRICE_SCALE,
      ),
    );
    sourceHubState.timestamp = env.state.timestamp;
    sourceUserState.timestamp = env.state.timestamp;
    addReplica(env, sourceHubState, addr('ae'));
    addReplica(env, sourceUserState, addr('af'));
    addReplica(env, targetHubState, addr('b0'));
    addReplica(env, targetUserState, addr('b1'));
    const staleIntent = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-prepared-routehash-immutable',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      sourceSignerId: addr('af'),
      sourceHubSignerId: addr('ae'),
      targetHubSignerId: addr('b0'),
      targetSignerId: addr('b1'),
      bookHubSignerId: addr('ae'),
      source: {
        jurisdiction: jref(sourceUserAliasJurisdiction),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 2,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(targetJurisdiction),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 900n,
      },
      status: 'intent',
      createdAt: env.state.timestamp,
      updatedAt: env.state.timestamp,
      expiresAt: env.state.timestamp + 60_000,
    });

    const rawPreparedResult = await applyEntityTx(env, sourceHubState, {
      type: 'prepareCrossJurisdictionSwap',
      data: { route: staleIntent },
    });
    const hubPreparedRoute = buildPreparedCrossJurisdictionRoute(staleIntent, {
      runtimeSeed: env.runtimeSeed,
      now: env.state.timestamp,
    });
    const preparedResult = await applyEntityTx(env, rawPreparedResult.newState, {
      type: 'materializeCrossJurisdictionSwap',
      data: { proposerSignerId: addr('ae'), route: hubPreparedRoute },
    });
    const sourceHubOutput = preparedResult.outputs.find(output => output.entityId === sourceHub);
    const targetHubOutput = preparedResult.outputs.find(output => output.entityId === targetHub);
    const preparedRoute = (
      targetHubOutput?.entityTxs?.find(tx => tx.type === 'registerCrossJurisdictionSwap')?.data as any
    )?.route;
    expect(preparedRoute.source.jurisdiction).toBe(jref(sourceUserAliasJurisdiction));
    expect(preparedRoute.routeHash).toBe(staleIntent.routeHash);
    expect(preparedRoute.sourcePull.fullHash).toBe(preparedRoute.targetPull.fullHash);
    const sourceRegistration = await applyEntityTx(env, preparedResult.newState, sourceHubOutput!.entityTxs![0]!);
    const sourcePullTx = sourceRegistration.accountTxs?.find(op => op.tx.type === 'cross_pull_lock')?.tx as
      Extract<AccountTx, { type: 'cross_pull_lock' }> | undefined;
    const swapOfferTx = sourceRegistration.accountTxs?.find(op => op.tx.type === 'swap_offer')?.tx as
      Extract<AccountTx, { type: 'swap_offer' }> | undefined;
    expect(sourcePullTx?.data.crossJurisdictionRoute?.routeHash).toBe(preparedRoute.routeHash);
    expect(swapOfferTx?.data.crossJurisdiction?.routeHash).toBe(preparedRoute.routeHash);
    expect(swapOfferTx?.data.crossJurisdiction?.source.jurisdiction).toBe(jref(sourceUserAliasJurisdiction));
    expect(swapOfferTx?.data.crossJurisdiction?.sourcePull?.fullHash).toBe(preparedRoute.sourcePull.fullHash);
    expect(swapOfferTx?.data.maxFee).toBe(0n);
    expect(swapOfferTx?.data.minNetReceive).toBe(BigInt(preparedRoute.target.amount));

    const clearingHubState = sourceRegistration.newState;
    const clearingRoute = {
      ...preparedRoute,
      status: 'clear_requested' as const,
      fillSeq: 1,
      cumulativeFillRatio: 65_535,
      claimedRatio: 65_535,
      fillNumerator: 1n,
      fillDenominator: 1n,
      filledSourceAmount: BigInt(preparedRoute.source.amount),
      filledTargetAmount: BigInt(preparedRoute.target.amount),
      sourceClaimed: BigInt(preparedRoute.source.amount),
      targetClaimed: BigInt(preparedRoute.target.amount),
      clearingPolicy: 'cancel_and_clear' as const,
    };
    clearingHubState.crossJurisdictionSwaps?.set(clearingRoute.orderId, clearingRoute);
    const sourceAccount = getEntityAccountForWrite(clearingHubState.accounts, sourceUser);
    if (!sourceAccount) throw new Error('TEST_CLEARING_SOURCE_ACCOUNT_MISSING');
    sourceAccount.state.pulls = PersistentAccountStateMap.fromEntries(
      'pulls',
      sourceAccount.state.pulls ?? [],
    ).updated(
      clearingRoute.sourcePull.pullId,
      {
          pullId: clearingRoute.sourcePull.pullId,
          tokenId: clearingRoute.sourcePull.tokenId,
          amount: clearingRoute.sourcePull.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: clearingRoute.sourcePull.fullHash,
          partialRoot: clearingRoute.sourcePull.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(clearingRoute, 'source'),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
      },
    );

    const clearResult = await applyEntityTx(env, clearingHubState, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: clearingRoute.orderId, cancelRemainder: true },
    });
    const [clearMaterialization] = appendDefaultProposerCrossJMaterializations(
      env,
      {
        entityId: sourceHub,
        signerId: addr('ae'),
        entityEncPubKey: '',
        state: clearResult.newState,
        mempool: [],
      } as EntityReplica,
      [],
    );
    expect(clearMaterialization?.type).toBe('materializeCrossJurisdictionClear');
    const materializedClear = await applyEntityTx(env, clearResult.newState, clearMaterialization!);
    const resolveTx = materializedClear.accountTxs?.find(op => op.tx.type === 'cross_pull_close')?.tx as any;
    expect(resolveTx?.data.pullId).toBe(clearingRoute.sourcePull.pullId);
    expect(resolveTx?.data.proof.routeHash).toBe(clearingRoute.routeHash);
    expect(() =>
      verifyHashLadderBinary(
        {
          fullHash: clearingRoute.sourcePull.fullHash,
          partialRoot: clearingRoute.sourcePull.partialRoot,
        },
        resolveTx.data.binary,
      ),
    ).not.toThrow();
  });

  test('cross-j clear treats exact-only committed fill as pending before live offer cancel', async () => {
    const env = createEmptyEnv('cross-clear-exact-only-pending');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('a7');
    const sourceHub = entity('a8');
    const targetHub = entity('a9');
    const targetUser = entity('aa');
    const sourceHubSigner = addr('ab');
    const targetHubSigner = addr('ac');
    const state = createEntityFrameCandidateState(
      makeState(sourceHub, sourceHubSigner, eth, sourceUser),
    );
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-clear-exact-only-pending',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        bookOwnerEntityId: sourceHub,
        sourceSignerId: addr('ad'),
        sourceHubSignerId: sourceHubSigner,
        targetHubSignerId: targetHubSigner,
        targetSignerId: addr('ae'),
        bookHubSignerId: sourceHubSigner,
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
      fillNumerator: 1n,
      fillDenominator: 2n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = getEntityAccountForWrite(state.accounts, sourceUser);
    if (!account) throw new Error('TEST_SOURCE_ACCOUNT_MISSING');
    account.state.swapOffers = requirePersistentAccountStateMap(
      account.state.swapOffers,
      'swapOffers',
    ).updated(route.orderId, {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(Number(route.source.tokenId), Number(route.target.tokenId)),
      giveTokenId: Number(route.source.tokenId),
      giveAmount: BigInt(route.source.amount),
      wantTokenId: Number(route.target.tokenId),
      wantAmount: BigInt(route.target.amount),
      maxFee: 0n,
      minNetReceive: BigInt(route.target.amount),
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId },
    });

    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    expect((result.accountTxs?.[0]?.tx as any).data.cumulativeFillRatio).toBe(32_768);
    expect((result.accountTxs?.[0]?.tx as any).data.cumulativeSourceAmount).toBe(500n);
    expect((result.accountTxs?.[0]?.tx as any).data.cumulativeTargetAmount).toBe(450n);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
    expect(readEntityFrameEventMessages(result.newState).at(-1)).not.toContain('no pending fill');
  });

  test('committed terminal fill ack routes clear from its exact-derived ratio', () => {
    const seed = 'cross-exact-only-terminal-fill-followup-seed';
    const env = createEmptyEnv(seed);
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('b1');
    const sourceHubSigner = registerTestSigner(env, seed, '1');
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = entity('b3');
    const targetUser = entity('b4');
    const sourceHubState = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    addReplica(env, sourceHubState, sourceHubSigner);
    const workingSourceHubState = createEntityFrameCandidateState(sourceHubState);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-exact-only-terminal-fill-followup',
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
      { runtimeSeed: seed, now: env.state.timestamp },
    );
    workingSourceHubState.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
    const ackTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }> = {
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
        executionSourceAmount: 1_000n,
        executionTargetAmount: 900n,
        priceImprovementMode: 'source_savings',
        cancelRemainder: false,
        pairId: route.venueId || '',
      },
    };
    const outputs: EntityInput[] = [];

    expect(applyCommittedCrossJurisdictionAccountTxFollowup(env, workingSourceHubState, sourceUser, ackTx, outputs)).toBe(
      true,
    );

    const updated = workingSourceHubState.crossJurisdictionSwaps?.get(route.orderId);
    expect(updated?.status).toBe('clear_requested');
    expect(updated?.cumulativeFillRatio).toBe(65_535);
    expect(updated?.fillNumerator).toBe(1n);
    expect(updated?.fillDenominator).toBe(1n);
    expect(
      outputs.some(
        output =>
          output.entityId === sourceHub && output.entityTxs?.some(tx => tx.type === 'requestCrossJurisdictionClear'),
      ),
    ).toBe(true);
    expect(outputs.some(output => output.entityTxs?.some(tx => tx.type === 'applyCrossJurisdictionBookProgress'))).toBe(
      false,
    );
  });

  test('cross-j route codec and storage projection keep only public route fields', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('b1');
    const sourceHub = entity('b2');
    const targetHub = entity('b3');
    const targetUser = entity('b4');
    const state = createEntityFrameCandidateState(
      makeState(sourceHub, addr('b5'), eth, sourceUser),
    );
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-public-route-shape',
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
      { runtimeSeed: 'cross-public-route-shape', now: 1_000 },
    );
    state.crossJurisdictionSwaps?.set(route.orderId, {
      ...route,
      __debugOnly: secret('b6'),
    } as any);
    state.crossJurisdictionAuthorizations = new Map([[
      route.orderId,
      { ...route, status: 'intent', sourcePull: undefined, targetPull: undefined, __debugOnly: secret('bb') } as any,
    ]]);
    const account = getEntityAccountForWrite(state.accounts, sourceUser);
    if (!account) throw new Error('TEST_SOURCE_ACCOUNT_MISSING');
    account.state.swapOffers = requirePersistentAccountStateMap(
      account.state.swapOffers,
      'swapOffers',
    ).updated(route.orderId, {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(1, 1),
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
      crossJurisdiction: { ...route, __debugOnly: secret('b7') } as any,
    });
    account.mempool.push({
      type: 'swap_offer',
      data: {
        offerId: `${route.orderId}-mempool`,
        ...getStaticSwapTokenDimensions(1, 1),
        giveTokenId: 1,
        giveAmount: 1_000n,
        wantTokenId: 1,
        wantAmount: 900n,
        maxFee: 0n,
        minNetReceive: 900n,
        crossJurisdiction: { ...route, __debugOnly: secret('b8') } as any,
      },
    });
    const projectedRoute = projectEntityCoreDoc(state).crossJurisdictionSwaps?.get(route.orderId) as any;
    const projectedAuthorization = projectEntityCoreDoc(state).crossJurisdictionAuthorizations?.get(route.orderId) as any;
    expect('__debugOnly' in cloneCrossJurisdictionRoute({ ...route, __debugOnly: secret('ba') } as any)).toBe(false);
    expect(projectedRoute.__debugOnly).toBeUndefined();
    expect(projectedAuthorization.__debugOnly).toBeUndefined();
    expect(projectedRoute.source).toEqual(route.source);
    expect(projectedRoute.target).toEqual(route.target);
  });

});
