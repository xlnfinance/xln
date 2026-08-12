import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../account/crypto';
import { applyEntityFrame } from '../../entity/consensus';
import { createEntityFrameHash } from '../../entity/consensus/frame';
import { buildEntityHashesToSign } from '../../entity/consensus/input/hanko-witness';
import { getEntityLeaderState } from '../../entity/consensus/leader';
import { buildCertifiedEntityOutputHashes } from '../../entity/consensus/output/certification';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../entity/consensus/state-root';
import { deriveLocalEntityCryptoKeys } from '../../entity/auth/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import { initCrontab } from '../../entity/scheduler';
import { buildQuorumHanko } from '../../hanko/signing';
import { buildLocalEntityProfile } from '../../network/p2p/gossip/helper';
import {
  collectLocalProfileEncryptionAnnouncements,
  getCompleteProfileEncryptionManifest,
} from '../../entity/profile/profile-encryption';
import { computeProfileHash } from '../../entity/profile/profile-signing';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
} from '../../storage/replica/entity-lineage';
import type { DeliverableEntityInput, RuntimeReplica } from '../../runtime/types';
import type { EntityReplica, EntityState, EntityFrame } from '../../entity/types';

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
  return {
    entityId: generateLazyEntityId(validators, 2n).toLowerCase(),
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
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    crontabState: initCrontab(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
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
    state: structuredClone(state),
    mempool: [],
    isProposer: false,
  };
  env.state.eReplicas.set(`${state.entityId}:${signerId}`, replica);
  return replica;
};

const installFixtureEncryptionKeys = (env: RuntimeReplica, replica: EntityReplica): void => {
  const keys = deriveLocalEntityCryptoKeys(env, replica.entityId, replica.signerId);
  replica.entityEncPubKey = keys.publicKey;
};

export const prepareCatchupFixtureReplica = async (
  env: RuntimeReplica,
  state: EntityState,
  leaderSignerId: string,
  targetSignerId: string,
): Promise<EntityReplica> => {
  const target = installReplica(env, state, targetSignerId);
  const leader = installReplica(env, state, leaderSignerId);
  installFixtureEncryptionKeys(env, target);
  installFixtureEncryptionKeys(env, leader);
  collectLocalProfileEncryptionAnnouncements(env);
  env.state.eReplicas.delete(`${state.entityId}:${leaderSignerId}`);
  const manifest = getCompleteProfileEncryptionManifest(env, target.state);
  if (!manifest) throw new Error('CATCHUP_FIXTURE_PROFILE_MANIFEST_MISSING');
  state.profileEncryptionManifest = structuredClone(manifest);
  target.state.profileEncryptionManifest = structuredClone(manifest);
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
  const execution = await applyEntityFrame(env, state, [], timestamp);
  const nextStateBeforeLink: EntityState = {
    ...execution.newState,
    entityId: state.entityId,
    height,
    timestamp,
    leaderState: getEntityLeaderState(state),
  };
  const parentFrameHash = state.height === 0 ? 'genesis' : state.prevFrameHash;
  if (!parentFrameHash) throw new Error(`CATCHUP_FIXTURE_PARENT_MISSING:${state.height}`);
  const frameHash = await createEntityFrameHash(
    parentFrameHash,
    height,
    timestamp,
    [],
    nextStateBeforeLink,
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
