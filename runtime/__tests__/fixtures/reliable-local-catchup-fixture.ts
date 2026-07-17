import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../account/crypto';
import { applyEntityFrame } from '../../entity/consensus';
import { createEntityFrameHash } from '../../entity/consensus/frame';
import { buildEntityHashesToSign } from '../../entity/consensus/hanko-witness';
import { getEntityLeaderState } from '../../entity/consensus/leader';
import { buildCertifiedEntityOutputHashes } from '../../entity/consensus/output-certification';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../entity/consensus/state-root';
import { deriveLocalEntityCryptoKeys } from '../../entity/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import { initCrontab } from '../../entity/scheduler';
import { buildQuorumHanko } from '../../hanko/signing';
import { buildLocalEntityProfile } from '../../networking/gossip-helper';
import {
  collectLocalProfileEncryptionAnnouncements,
  getCompleteProfileEncryptionManifest,
} from '../../networking/profile-encryption';
import { computeProfileHash } from '../../networking/profile-signing';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
} from '../../storage/entity-lineage';
import type {
  DeliverableEntityInput,
  EntityReplica,
  EntityState,
  Env,
  ProposedEntityFrame,
} from '../../types';

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

export const registerCatchupFixtureSigners = (env: Env, seed: string): {
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
    messages: [],
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
    entityEncPubKey: `0x${'11'.repeat(32)}`,
    entityEncPrivKey: `0x${'22'.repeat(32)}`,
    profile: { name: 'SIGKILL catch-up validator', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    htlcNotes: new Map(),
    lockBook: new Map(),
    swapTradingPairs: [],
    pendingSwapFillRatios: new Map(),
  };
};

const installReplica = (env: Env, state: EntityState, signerId: string): EntityReplica => {
  const replica: EntityReplica = {
    entityId: state.entityId,
    signerId,
    state: structuredClone(state),
    mempool: [],
    isProposer: false,
  };
  env.eReplicas.set(`${state.entityId}:${signerId}`, replica);
  return replica;
};

const installFixtureEncryptionKeys = (env: Env, replica: EntityReplica): void => {
  const keys = deriveLocalEntityCryptoKeys(env, replica.entityId, replica.signerId);
  replica.state.entityEncPubKey = keys.publicKey;
  replica.state.entityEncPrivKey = keys.privateKey;
};

export const prepareCatchupFixtureReplica = async (
  env: Env,
  state: EntityState,
  leaderSignerId: string,
  targetSignerId: string,
): Promise<EntityReplica> => {
  const target = installReplica(env, state, targetSignerId);
  const leader = installReplica(env, state, leaderSignerId);
  installFixtureEncryptionKeys(env, target);
  installFixtureEncryptionKeys(env, leader);
  collectLocalProfileEncryptionAnnouncements(env);
  env.eReplicas.delete(`${state.entityId}:${leaderSignerId}`);
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
  env: Env,
  state: EntityState,
  timestamp: number,
): Promise<{ frame: ProposedEntityFrame; nextState: EntityState }> => {
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
  const frame: ProposedEntityFrame = {
    height,
    parentFrameHash,
    stateRoot: computeCanonicalEntityConsensusStateHash(nextStateBeforeLink),
    authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(nextStateBeforeLink)),
    timestamp,
    txs: [],
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
  frame: ProposedEntityFrame,
): DeliverableEntityInput => ({
  runtimeId,
  entityId,
  signerId,
  proposedFrame: structuredClone(frame),
});
