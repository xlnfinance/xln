import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../../account/crypto';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';
import { createEntityFrameHash } from '../../../entity/consensus/frame';
import { buildEntityHashesToSign } from '../../../entity/consensus/input/hanko-witness';
import { getEntityLeaderState } from '../../../entity/consensus/leader';
import { buildCertifiedEntityOutputHashes } from '../../../entity/consensus/output/certification';
import {
  buildEntityFrameAuthority,
  computeEntityAccountValueHash,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../../entity/consensus/state-root';
import { provisionTestEntityEncryptionKey } from '../../../qa/entity-creation-fixture';
import { generateLazyEntityId } from '../../../entity/factory';
import { initCrontab } from '../../../entity/scheduler';
import { buildQuorumHanko } from '../../../hanko/signing';
import { buildLocalEntityProfile } from '../../../network/p2p/gossip/helper';
import { computeProfileHash } from '../../../entity/profile/profile-signing';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
} from '../../../storage/replica/entity-lineage';
import type { DeliverableEntityInput, RuntimeReplica } from '../../../runtime/types';
import type { EntityReplica, EntityState, EntityFrame } from '../../../entity/types';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';

export const deriveCatchupFixtureSigners = (seed: string): {
  leaderSignerId: string;
  targetSignerId: string;
} => {
  const leaderSeed = `${seed}:entity-leader`;
  const targetSeed = `${seed}:entity-target`;
  const leaderSignerId = deriveSignerAddressSync(leaderSeed, '1').toLowerCase();
  const targetSignerId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
  return { leaderSignerId, targetSignerId };
};

export const registerCatchupFixtureSigners = (env: RuntimeReplica, seed: string): {
  leaderSignerId: string;
  targetSignerId: string;
} => {
  const signers = deriveCatchupFixtureSigners(seed);
  registerSignerKey(env, signers.leaderSignerId, deriveSignerKeySync(`${seed}:entity-leader`, '1'));
  registerSignerKey(env, signers.targetSignerId, deriveSignerKeySync(`${seed}:entity-target`, '1'));
  return signers;
};

export const createCatchupFixtureState = (
  leaderSignerId: string,
  targetSignerId: string,
): EntityState => {
  const validators = [leaderSignerId, targetSignerId];
  const entityId = generateLazyEntityId(validators, 2n).toLowerCase();
  return {
    entityId,
    height: 0,
    timestamp: 0,
    nonces: new Map(),
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 2n,
      validators,
      shares: { [leaderSignerId]: 1n, [targetSignerId]: 1n },
    },
    reserves: new Map(),
    accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
    deferredAccountProposals: new Map(),
    crontabState: initCrontab(),
    lastFinalizedJHeight: 0,
    profile: { name: 'SIGKILL catch-up validator', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
    swapTradingPairs: [],
  };
};

const installReplica = (env: RuntimeReplica, state: EntityState, signerId: string): EntityReplica => {
  const replica: EntityReplica = {
    entityId: state.entityId,
    signerId,
    entityEncPubKey: '',
    state,
    mempool: [],
    isProposer: false,
  };
  env.state.eReplicas.set(`${state.entityId}:${signerId}`, replica);
  return replica;
};

export const prepareCatchupFixtureReplica = async (
  env: RuntimeReplica,
  state: EntityState,
  leaderSignerId: string,
  targetSignerId: string,
): Promise<EntityReplica> => {
  const keys = provisionTestEntityEncryptionKey(env, state.entityId);
  const preparedState = { ...state, entityEncryptionPublicKey: keys.publicKey };
  state.entityEncryptionPublicKey = keys.publicKey;
  // Local validators at the same certified endpoint share one immutable state
  // root. Their envelopes diverge; the unbounded Entity graph does not clone.
  const target = installReplica(env, preparedState, targetSignerId);
  installReplica(env, preparedState, leaderSignerId);
  env.state.eReplicas.delete(`${state.entityId}:${leaderSignerId}`);
  const profileHash = computeProfileHash(buildLocalEntityProfile(env, target.state, 1));
  const signatures = state.config.validators.map(signerId => ({
    signerId,
    signature: signAccountFrame(env, signerId, profileHash),
  }));
  target.hankoWitness = new Map([[profileHash, {
    hanko: await buildQuorumHanko(env, state.entityId, profileHash, signatures, state.config),
    type: 'profile',
    entityHeight: 0,
    createdAt: 1,
  }]]);
  applyCertifiedEntityLineagePlan(env, buildCertifiedEntityLineagePlan(env));
  return target;
};

export const buildCatchupFixtureCertificate = async (
  env: RuntimeReplica,
  state: EntityState,
  timestamp: number,
): Promise<{ frame: EntityFrame; nextState: EntityState }> => {
  const height = state.height + 1;
  const execution = await applyEntityFrameWithMaterializedTestInfraContext(env, state, [], timestamp);
  const nextStateBeforeLink: EntityState = {
    ...execution.newState,
    entityId: state.entityId,
    height,
    timestamp,
    leaderState: getEntityLeaderState(state),
  };
  const parentFrameHash = state.height === 0 ? 'genesis' : state.prevFrameHash;
  if (!parentFrameHash) throw new Error(`CATCHUP_FIXTURE_PARENT_MISSING:${state.height}`);
  const entityContext = {
    ...execution.entityContext,
    height,
    parentFrameHash,
  };
  const frameHash = await createEntityFrameHash(
    parentFrameHash,
    height,
    timestamp,
    [],
    nextStateBeforeLink,
    entityContext,
    undefined,
    execution.events,
  );
  const hashesToSign = buildEntityHashesToSign(
    state.entityId,
    height,
    frameHash,
    [
      ...(execution.collectedHashes ?? []),
      ...buildCertifiedEntityOutputHashes(nextStateBeforeLink, env, height, frameHash, execution.outputs),
    ],
  );
  const collectedSigs = new Map(state.config.validators.map(signerId => [
    signerId,
    hashesToSign.map(hashInfo => signAccountFrame(env, signerId, hashInfo.hash)),
  ]));
  const hankos = await Promise.all(hashesToSign.map((hashInfo, index) => buildQuorumHanko(
    env,
    state.entityId,
    hashInfo.hash,
    state.config.validators.map(signerId => ({
      signerId,
      signature: collectedSigs.get(signerId)![index]!,
    })),
    state.config,
  )));
  const frame: EntityFrame = {
    height,
    parentFrameHash,
    stateRoot: computeCanonicalEntityConsensusStateHash(nextStateBeforeLink),
    authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(nextStateBeforeLink)),
    timestamp,
    txs: [],
    entityContext,
    events: structuredClone(execution.events),
    hash: frameHash,
    leader: { proposerSignerId: state.config.validators[0]!, view: 0 },
    hashesToSign,
    collectedSigs,
    hankos,
  };
  return { frame, nextState: { ...nextStateBeforeLink, prevFrameHash: frameHash } };
};

export const catchupFixtureDeliverable = (
  runtimeId: string,
  entityId: string,
  signerId: string,
  frame: EntityFrame,
): DeliverableEntityInput => ({
  runtimeId,
  entityId,
  signerId,
  proposedFrame: structuredClone(frame),
});
