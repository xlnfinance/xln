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
});
