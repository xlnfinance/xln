import { createHash } from 'node:crypto';

import { computeAccountStateRoot } from '../../../core/account/commitment/state-root';
import { requireAccountDeltaTransformerAddress } from '../../../core/account/consensus/helpers';
import {
  computeCanonicalEntityConsensusStateHash,
  computeEntityAccountValueHash,
  computeEntityConsensusSectionDigestsCold,
} from '../../../core/entity/consensus/state-root';
import { safeStringify } from '../../../core/protocol/serialization';
import { cloneCrossJurisdictionRoute, buildPreparedCrossJurisdictionRoute, withCanonicalCrossJurisdictionRouteHash } from '../../../core/extensions/cross-j';
import { getEffectiveEntityInputTxs } from '../../../core/entity/consensus/output/envelope';
import { generateLazyEntityId } from '../../../core/entity/factory';
import { clearRuntimeFrameEvents, readRuntimeFrameEvents } from '../../../core/runtime/observability/env-events';
import {
  beginRuntimeParityEvidence,
  finishRuntimeParityEvidence,
} from '../../../core/runtime/observability/parity-evidence';
import {
  admitAtomicCrossJAccountInputs,
  applyRuntimeInput,
  createEmptyEnv,
} from '../../../core/runtime';
import { selectPotentialCrossJAccountInputPairs } from '../../../core/runtime/delivery/topology/entity-routing';
import { computeCanonicalStateHashFromEnv } from '../../../core/storage/canonical-hash';
import { TsAccountWorkerAuthority } from '../../../core/rscore/ts-worker/provider';
import { prepareRuntimeOutputRows } from '../../../core/storage/wal/outbox-payload';
import { applyCertifiedEntityHeadPlan, buildCertifiedEntityHeadPlan } from '../../../core/storage/replica/entity-head';
import type { EntityInput } from '../../../core/entity/types';
import type { RoutedEntityInput, RuntimeReplica } from '../../../core/runtime/types';
import type { CrossJurisdictionSwapRoute } from '../../../core/types/cross-jurisdiction';
import {
  addReplica,
  installJurisdictions,
  jref,
  makeJurisdiction,
  makeState,
  getTestAccountForWrite,
  registerTestSigner,
} from '../../../core/__tests__/helpers/cross-j';
import { buildHltEntityEffectEvidence } from '../../../core/scripts/operations/hlt/replay/entity-effect-evidence';
import { buildHltEntityFrameEventEvidenceFromEvents } from '../../../core/scripts/operations/hlt/replay/entity-frame-event-evidence';

const SEED = 'cross-j-opening-lifecycle-v1';
const TIMESTAMP = 10_000;

const registerRoute = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
  runtimeId: string,
): void => {
  env.infrastructure!.verifiedProfileRoutes ??= new Map();
  env.infrastructure!.verifiedProfileRoutes.set(entityId, {
    runtimeId,
    runtimeSignerId: signerId,
    runtimeEncPubKey: '',
    lastUpdated: env.state.timestamp,
  });
};

const installGenesis = (env: RuntimeReplica): void => {
  applyCertifiedEntityHeadPlan(env, buildCertifiedEntityHeadPlan(env));
};

type FixtureRuntime = Readonly<{
  env: RuntimeReplica;
  accountAuthority: TsAccountWorkerAuthority;
  sourceEntityId: string;
  sourceSignerId: string;
  targetEntityId: string;
  targetSignerId: string;
}>;

const projectInitialRuntime = (env: RuntimeReplica) => ({
  canonicalRuntimeStateHash: computeCanonicalStateHashFromEnv(env),
  entities: [...env.state.eReplicas.values()].map(replica => ({
    entityId: replica.entityId,
    signerId: replica.signerId,
    timestamp: replica.state.timestamp,
    entityEncryptionPublicKey: replica.state.entityEncryptionPublicKey,
    isHub: replica.state.profile.isHub,
    jurisdiction: replica.state.config.jurisdiction,
    crossJurisdictionSwaps: [...(replica.state.crossJurisdictionSwaps ?? [])],
    crossJurisdictionAuthorizations: [...(replica.state.crossJurisdictionAuthorizations ?? [])],
    accountsRoot: replica.state.accounts.rootHash(),
    entityRoot: computeCanonicalEntityConsensusStateHash(replica.state),
    sectionDigests: computeEntityConsensusSectionDigestsCold(replica.state),
    accounts: [...replica.state.accounts].map(([counterpartyEntityId, account]) => ({
      counterpartyEntityId,
      chainId: account.state.domain.chainId,
      depositoryAddress: account.state.domain.depositoryAddress,
      deltaTransformerAddress: requireAccountDeltaTransformerAddress(env.state, account.state),
      watchSeed: account.state.watchSeed,
      root: computeAccountStateRoot(account.state),
      entityLeaf: computeEntityAccountValueHash(account),
    })),
  })),
});

const buildFixtureRuntimes = (): Readonly<{
  hub: FixtureRuntime;
  user: FixtureRuntime;
  route: CrossJurisdictionSwapRoute;
  prepared: CrossJurisdictionSwapRoute;
  initial: Readonly<{
    hub: ReturnType<typeof projectInitialRuntime>;
    user: ReturnType<typeof projectInitialRuntime>;
  }>;
}> => {
  const hubEnv = createEmptyEnv(`${SEED}-hub`);
  const userEnv = createEmptyEnv(`${SEED}-user`);
  for (const env of [hubEnv, userEnv]) {
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.state.timestamp = TIMESTAMP;
  }
  const hubAccountAuthority = new TsAccountWorkerAuthority(hubEnv, 1);
  const userAccountAuthority = new TsAccountWorkerAuthority(userEnv, 1);
  hubEnv.accountAuthorityExecutionMode = 'cutover';
  hubEnv.accountAuthorityEntityStageProvider = hubAccountAuthority.provider;
  userEnv.accountAuthorityExecutionMode = 'cutover';
  userEnv.accountAuthorityEntityStageProvider = userAccountAuthority.provider;
  const sourceJ = makeJurisdiction('Source', 1, '11', '12');
  const targetJ = makeJurisdiction('Target', 8453, '21', '22');
  installJurisdictions(hubEnv, sourceJ, targetJ);
  installJurisdictions(userEnv, sourceJ, targetJ);
  for (const env of [hubEnv, userEnv]) {
    for (const replica of env.state.jReplicas.values()) {
      replica.blockNumber = 0n;
      replica.stateRoot = null;
      replica.mempool = [];
      replica.blockDelayMs = 0;
      replica.lastBlockTimestamp = 0;
      replica.position = { x: 0, y: 0, z: 0 };
    }
  }
  const sourceHubSigner = registerTestSigner(hubEnv, SEED, 'source-hub');
  const targetHubSigner = registerTestSigner(hubEnv, SEED, 'target-hub');
  const sourceUserSigner = registerTestSigner(userEnv, SEED, 'source-user');
  const targetUserSigner = registerTestSigner(userEnv, SEED, 'target-user');
  const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
  const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
  const sourceUser = generateLazyEntityId([sourceUserSigner], 1n).toLowerCase();
  const targetUser = generateLazyEntityId([targetUserSigner], 1n).toLowerCase();
  const sourceHubState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
  const targetHubState = makeState(targetHub, targetHubSigner, targetJ, targetUser);
  const sourceUserState = makeState(sourceUser, sourceUserSigner, sourceJ, sourceHub);
  const targetUserState = makeState(targetUser, targetUserSigner, targetJ, targetHub);
  for (const state of [sourceHubState, targetHubState, sourceUserState, targetUserState]) {
    state.height = 0;
    state.prevFrameHash = 'genesis';
  }
  getTestAccountForWrite(sourceHubState, sourceUser).proofHeader.nextProofNonce = 1;
  getTestAccountForWrite(targetHubState, targetUser).proofHeader.nextProofNonce = 1;
  getTestAccountForWrite(sourceUserState, sourceHub).proofHeader.nextProofNonce = 1;
  getTestAccountForWrite(targetUserState, targetHub).proofHeader.nextProofNonce = 1;
  sourceHubState.profile.isHub = true;
  targetHubState.profile.isHub = true;
  const route = withCanonicalCrossJurisdictionRouteHash({
    orderId: 'cross-j-opening-lifecycle-v1',
    makerEntityId: sourceUser,
    hubEntityId: sourceHub,
    bookOwnerEntityId: sourceHub,
    sourceSignerId: sourceUserSigner,
    sourceHubSignerId: sourceHubSigner,
    targetHubSignerId: targetHubSigner,
    targetSignerId: targetUserSigner,
    bookHubSignerId: sourceHubSigner,
    sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    source: { jurisdiction: jref(sourceJ), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
    target: { jurisdiction: jref(targetJ), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
    status: 'intent',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    expiresAt: 70_000,
  });
  sourceHubState.crossJurisdictionSwaps?.set(route.orderId, route);
  sourceUserState.crossJurisdictionAuthorizations = new Map([[route.orderId, cloneCrossJurisdictionRoute(route)]]);
  targetUserState.crossJurisdictionAuthorizations = new Map([[route.orderId, cloneCrossJurisdictionRoute(route)]]);
  addReplica(hubEnv, sourceHubState, sourceHubSigner);
  addReplica(hubEnv, targetHubState, targetHubSigner);
  addReplica(userEnv, sourceUserState, sourceUserSigner);
  addReplica(userEnv, targetUserState, targetUserSigner);
  registerRoute(hubEnv, sourceUser, sourceUserSigner, userEnv.runtimeId!);
  registerRoute(hubEnv, targetUser, targetUserSigner, userEnv.runtimeId!);
  registerRoute(userEnv, sourceHub, sourceHubSigner, hubEnv.runtimeId!);
  registerRoute(userEnv, targetHub, targetHubSigner, hubEnv.runtimeId!);
  installGenesis(hubEnv);
  installGenesis(userEnv);
  return {
    hub: { env: hubEnv, accountAuthority: hubAccountAuthority, sourceEntityId: sourceHub, sourceSignerId: sourceHubSigner, targetEntityId: targetHub, targetSignerId: targetHubSigner },
    user: { env: userEnv, accountAuthority: userAccountAuthority, sourceEntityId: sourceUser, sourceSignerId: sourceUserSigner, targetEntityId: targetUser, targetSignerId: targetUserSigner },
    route,
    prepared: buildPreparedCrossJurisdictionRoute(route, { runtimeSeed: SEED, now: TIMESTAMP }),
    initial: {
      hub: projectInitialRuntime(hubEnv),
      user: projectInitialRuntime(userEnv),
    },
  };
};

const orderedDigest = (value: unknown): string => `0x${createHash('sha256')
  .update(safeStringify(value))
  .digest('hex')}`;

const projectAccountInput = (output: RoutedEntityInput): unknown => {
  const tx = getEffectiveEntityInputTxs(output).find(candidate => candidate.type === 'accountInput');
  if (!tx || tx.type !== 'accountInput') return null;
  return tx.data;
};

const projectFrame = (
  env: RuntimeReplica,
  appliedEntityInputs: readonly RoutedEntityInput[],
  outputs: readonly RoutedEntityInput[],
  capture: ReturnType<typeof finishRuntimeParityEvidence>,
) => {
  const logs = readRuntimeFrameEvents(env);
  const height = env.state.height;
  const projection = {
    runtimeHeight: height,
    canonicalEntityInputs: appliedEntityInputs,
    appliedEntityInputs: appliedEntityInputs.map(input => ({
      entityId: input.entityId,
      signerId: input.signerId,
      txTypes: getEffectiveEntityInputTxs(input).map(tx => tx.type),
    })),
    entityFrames: capture.entityFrames.map(({
      entityId,
      signerId,
      accountsRoot,
      sectionDigests,
      accountFieldDigests,
      accountDigests,
      entityCommandNonces,
      link,
    }) => ({
      entityId,
      signerId,
      accountsRoot,
      sectionDigests,
      accountFieldDigests,
      accountDigests,
      entityCommandNonces,
      txs: link.frame.txs,
      height: link.frame.height,
      hash: link.frame.hash,
      parentFrameHash: link.frame.parentFrameHash,
      stateRoot: link.frame.stateRoot,
      authorityRoot: link.frame.authorityRoot,
      txTypes: link.frame.txs.map(tx => tx.type),
      effectiveTxTypes: link.frame.txs.flatMap(tx =>
        tx.type === 'entityCommand' ? tx.data.txs.map(nested => nested.type) : [tx.type]),
      nestedTxTypes: link.frame.txs.flatMap(tx =>
        tx.type === 'runtimeOutput' ? tx.data.entityTxs.map(nested => nested.type) : []),
      events: link.frame.events,
    })),
    entityRoots: [...env.state.eReplicas.values()].map(replica => ({
      entityId: replica.entityId,
      signerId: replica.signerId,
      height: replica.state.height,
      root: computeCanonicalEntityConsensusStateHash(replica.state),
    })).sort((a, b) => `${a.entityId}:${a.signerId}`.localeCompare(`${b.entityId}:${b.signerId}`)),
    accounts: [...env.state.eReplicas.values()].flatMap(replica =>
      [...replica.state.accounts].map(([counterpartyEntityId, account]) => ({
        entityId: replica.entityId,
        counterpartyEntityId,
        root: computeAccountStateRoot(account.state),
        currentHeight: account.currentHeight,
        currentFrameHash: account.currentFrame.stateHash,
        pendingHeight: account.pendingFrame?.height ?? null,
        pendingFrameHash: account.pendingFrame?.stateHash ?? null,
        mempoolTxTypes: account.mempool.map(tx => tx.type),
      }))).sort((a, b) => `${a.entityId}:${a.counterpartyEntityId}`
      .localeCompare(`${b.entityId}:${b.counterpartyEntityId}`)),
    events: buildHltEntityFrameEventEvidenceFromEvents(height, capture.entityFrameEvents),
    effects: buildHltEntityEffectEvidence(height, logs),
    outbox: {
      ...prepareRuntimeOutputRows(height, outputs).commitment,
      walOutputs: outputs,
      outputs: outputs.map(output => ({
        entityId: output.entityId,
        signerId: output.signerId,
        atomicCrossJurisdictionPair: output.atomicCrossJurisdictionPair ?? null,
        accountInput: projectAccountInput(output),
      })),
    },
    canonicalRuntimeStateHash: computeCanonicalStateHashFromEnv(env),
  };
  clearRuntimeFrameEvents(env);
  return { ...projection, projectionDigest: orderedDigest(projection) };
};

const executeFrame = async (
  env: RuntimeReplica,
  entityInputs: RoutedEntityInput[],
  target?: RuntimeReplica,
) => {
  beginRuntimeParityEvidence(env);
  const result = await applyRuntimeInput(env, { runtimeTxs: [], entityInputs });
  const capture = finishRuntimeParityEvidence(env);
  const committedOutputs = target
    ? bindOutputsForWal(result.entityOutbox, env, target)
    : result.entityOutbox;
  return {
    result,
    projection: projectFrame(env, result.appliedRuntimeInput.entityInputs, committedOutputs, capture),
  };
};

const bindOutputsForWal = (
  outputs: readonly RoutedEntityInput[],
  source: RuntimeReplica,
  target: RuntimeReplica,
): RoutedEntityInput[] => {
  if (!target.runtimeId) throw new Error('CROSS_J_LIFECYCLE_TARGET_RUNTIME_ID_MISSING');
  return outputs.map(output => ({
    ...structuredClone(output),
    runtimeId: target.runtimeId!,
    sourceRuntimeFrame: { height: source.state.height, timestamp: source.state.timestamp },
  }));
};

const withSourceFrame = (
  outputs: readonly RoutedEntityInput[],
  source: RuntimeReplica,
  target: RuntimeReplica,
): RoutedEntityInput[] => {
  if (!source.runtimeId || !target.runtimeId) {
    throw new Error('CROSS_J_LIFECYCLE_RUNTIME_ID_MISSING');
  }
  return outputs.map(output => ({
    ...structuredClone(output),
    from: source.runtimeId!,
    runtimeId: target.runtimeId!,
    sourceRuntimeFrame: { height: source.state.height, timestamp: source.state.timestamp },
  }));
};

export const executeCrossJOpeningLifecycleVector = async () => {
  const { hub, user, route, prepared, initial } = buildFixtureRuntimes();
  const materializeInput: EntityInput = {
    entityId: hub.sourceEntityId,
    signerId: hub.sourceSignerId,
    entityTxs: [{ type: 'materializeCrossJurisdictionSwap', data: { proposerSignerId: hub.sourceSignerId, route: prepared } }],
  };
  const opening = await executeFrame(hub.env, [materializeInput], user.env);
  const proposals = withSourceFrame(opening.result.entityOutbox, hub.env, user.env);
  const preparedProposals = await admitAtomicCrossJAccountInputs(user.env, proposals, false);
  const proposalPair = selectPotentialCrossJAccountInputPairs(preparedProposals.inputs)[0];
  if (!proposalPair) throw new Error('CROSS_J_LIFECYCLE_PROPOSAL_PAIR_MISSING');
  const userAcks = await executeFrame(user.env, preparedProposals.inputs, hub.env);
  const acknowledgements = withSourceFrame(userAcks.result.entityOutbox, user.env, hub.env).map(input => ({
    ...input,
    atomicCrossJurisdictionPair: { phase: 'ack' as const, pairKey: proposalPair.pairKey },
  }));
  const preparedAcks = await admitAtomicCrossJAccountInputs(hub.env, acknowledgements, false);
  const hubCurrent = await executeFrame(hub.env, preparedAcks.inputs);
  const fixture = {
    version: 1,
    canonicalSource: 'TypeScript Runtime→Entity→Account cross-J opening cascade',
    setup: {
      seed: SEED,
      timestamp: TIMESTAMP,
      route,
      initial,
      hubRuntimeId: hub.env.runtimeId,
      userRuntimeId: user.env.runtimeId,
    },
    frames: [opening.projection, userAcks.projection, hubCurrent.projection],
  };
  await hub.accountAuthority.close();
  await user.accountAuthority.close();
  return fixture;
};
