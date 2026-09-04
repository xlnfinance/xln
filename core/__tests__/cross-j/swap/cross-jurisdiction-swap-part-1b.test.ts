import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';

import { ethers } from 'ethers';

import { applyEntityTx } from '../../../entity/tx/apply';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';

import { applyAccountTxToMutableReplica as applyAccountTx } from '../../../account/tx/apply';

import { proposeAccountFrame } from '../../../account/consensus/proposal/propose';

import { accountInputAck, accountInputProposal } from '../../../account/consensus/flush';

import { computeAccountStateRoot } from '../../../account/commitment/state-root';

import {
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
  applyCertifiedEntityHeadPlan,
  buildCertifiedEntityHeadPlan,
} from '../../../storage/replica/entity-head';
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
  validateCrossJurisdictionFillProgress,
  withCanonicalCrossJurisdictionRouteHash as withCanonicalCrossJurisdictionRouteHashCanonical,
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
import { materializeCommittedEntityOutputs } from '../../../entity/consensus/output/publication';
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
  applyCertifiedEntityHeadPlan(env, buildCertifiedEntityHeadPlan(env));
};

const installTestGenesisLineage = (env: RuntimeReplica): void => {
  applyCertifiedEntityHeadPlan(env, buildCertifiedEntityHeadPlan(env));
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

    const committedRuntimeOutput = materializeCommittedEntityOutputs(
      sourceAuthorization.outputs,
      sourceUser,
      sourceUserSigner,
      true,
    );
    expect(committedRuntimeOutput).toHaveLength(1);
    const plannedRuntimeOutput = planEntityOutputs(
      env,
      committedRuntimeOutput,
      createRuntimeOutputRoutingDeps(routingDeps),
    );
    expect(plannedRuntimeOutput.localOutputs).toEqual([]);
    expect(plannedRuntimeOutput.remoteOutputs).toHaveLength(1);
    const deliverableRuntimeOutput = plannedRuntimeOutput.remoteOutputs[0]!.output;
    const admittedRuntimeOutput = validateInboundP2PEntityInputsEnvelope(
      hubEnv,
      env.runtimeId!,
      signRuntimeEntityInputsEnvelope(env, hubEnv.runtimeId!, {
        sourceRuntimeId: env.runtimeId!,
        sourceRuntimeHeight: env.state.height,
        sourceRuntimeTimestamp: env.state.timestamp,
        entityInputs: [deliverableRuntimeOutput],
      }),
      routingDeps,
    );
    expect(admittedRuntimeOutput).toHaveLength(1);
    expect(admittedRuntimeOutput[0]?.from).toBe(env.runtimeId);
    expect(admittedRuntimeOutput[0]?.entityTxs?.[0]).toMatchObject({
      type: 'runtimeOutput',
      data: {
        sourceEntityId: sourceUser,
        sourceSignerId: sourceUserSigner,
        targetEntityId: sourceHub,
      },
    });
    const admittedSourceHub = await applyEntityFrameWithMaterializedTestInfraContext(
      hubEnv,
      sourceHubState,
      admittedRuntimeOutput[0]!.entityTxs!,
    );
    expect(admittedSourceHub.newState.crossJurisdictionSwaps?.has(result.route.orderId)).toBe(true);

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
