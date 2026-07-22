import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import {
  buildEntityLeaderVoteBody,
  hashEntityLeaderVoteBody,
} from '../entity/consensus/leader';
import { generateLazyEntityId } from '../entity/factory';
import { initCrontab } from '../entity/scheduler';
import { dbRootPath } from '../machine/platform';
import {
  buildRuntimeRecoveryBundle,
  validateRuntimeRecoveryBundle,
} from '../recovery/bundle';
import {
  applyRuntimeInput,
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  loadEnvFromDB,
  process as processRuntime,
  readPersistedFrameJournal,
  restoreEnvFromRecoveryBundles,
} from '../runtime';
import type {
  EntityLeaderTimeoutVote,
  EntityReplica,
  EntityState,
  Env,
  JReplica,
  JurisdictionConfig,
} from '../types';

const cleanupRuntimeStorage = (runtimeId: string): void => {
  const namespacePath = join(dbRootPath, runtimeId);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-frames', '-events', '-infra']) {
    rmSync(`${namespacePath}${suffix}`, { recursive: true, force: true });
  }
};

const installVoteTarget = (env: Env): {
  replica: EntityReplica;
  vote: EntityLeaderTimeoutVote;
} => {
  const signerId = deriveSignerAddressSync(env.runtimeSeed!, '1').toLowerCase();
  const voterId = deriveSignerAddressSync(env.runtimeSeed!, '2').toLowerCase();
  const entityId = generateLazyEntityId([signerId, voterId], 2n, env).toLowerCase();
  const state: EntityState = {
    entityId,
    height: 0,
    timestamp: 0,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 2n,
      validators: [signerId, voterId],
      shares: { [signerId]: 1n, [voterId]: 1n },
    },
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    crontabState: initCrontab(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    entityEncPubKey: `0x${'11'.repeat(32)}`,
    entityEncPrivKey: `0x${'22'.repeat(32)}`,
    profile: { name: 'leader vote durability', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    htlcNotes: new Map(),
    lockBook: new Map(),
    swapTradingPairs: [],
  };
  const replica: EntityReplica = {
    entityId,
    signerId,
    state,
    mempool: [],
    isProposer: false,
  };
  env.eReplicas.set(`${entityId}:${signerId}`, replica);
  const voteBody = buildEntityLeaderVoteBody(state);
  const vote: EntityLeaderTimeoutVote = {
    ...voteBody,
    voterId,
    signature: signAccountFrame(env, voterId, hashEntityLeaderVoteBody(voteBody)),
  };
  return { replica, vote };
};

const voteRuntimeInput = (
  replica: EntityReplica,
  vote: EntityLeaderTimeoutVote,
) => ({
  runtimeTxs: [],
  entityInputs: [{
    entityId: replica.entityId,
    signerId: replica.signerId,
    leaderTimeoutVote: vote,
  }],
});

const installJurisdiction = (env: Env): JurisdictionConfig => {
  const jurisdiction: JurisdictionConfig = {
    name: 'LeaderVoteDurability',
    address: 'browservm://leader-vote-durability',
    chainId: 31337,
    depositoryAddress: `0x${'11'.repeat(20)}`,
    entityProviderAddress: `0x${'12'.repeat(20)}`,
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    rpcs: [],
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: `0x${'13'.repeat(20)}`,
      deltaTransformer: `0x${'14'.repeat(20)}`,
    },
  } as JReplica);
  return jurisdiction;
};

describe('leader timeout vote durability', () => {
  const runtimeIds: string[] = [];

  afterEach(() => {
    while (runtimeIds.length > 0) cleanupRuntimeStorage(runtimeIds.pop()!);
  });

  test('counts a standalone sub-quorum vote as a committed R-frame input', async () => {
    const env = createEmptyEnv('leader-timeout-vote-r-frame');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const { replica, vote } = installVoteTarget(env);

    await applyRuntimeInput(env, voteRuntimeInput(replica, vote));

    expect(env.eReplicas.get(`${replica.entityId}:${replica.signerId}`)?.leaderVotes?.size).toBe(1);
    expect(env.height).toBe(1);
  });

  test('restores a standalone sub-quorum vote from authoritative LevelDB history', async () => {
    const seed = `leader-timeout-vote-restore-${process.pid}`;
    const env = createEmptyEnv(seed);
    env.runtimeId = env.runtimeId!.toLowerCase();
    env.dbNamespace = env.runtimeId;
    env.quietRuntimeLogs = true;
    runtimeIds.push(env.runtimeId);
    cleanupRuntimeStorage(env.runtimeId);
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const voterId = deriveSignerAddressSync(seed, '2').toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(seed, '1'));
    registerSignerKey(env, voterId, deriveSignerKeySync(seed, '2'));
    const jurisdiction = installJurisdiction(env);
    const entityId = generateLazyEntityId([signerId, voterId], 2n, env).toLowerCase();

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          config: {
            mode: 'proposer-based',
            threshold: 2n,
            validators: [signerId, voterId],
            shares: { [signerId]: 1n, [voterId]: 1n },
            jurisdiction,
          },
          isProposer: false,
          profileName: 'leader vote durability',
        },
      }],
      entityInputs: [],
    });
    await processRuntime(env, []);
    expect(env.height).toBe(1);
    const replica = env.eReplicas.get(`${entityId}:${signerId}`);
    if (!replica) throw new Error('LEADER_TIMEOUT_VOTE_REPLICA_MISSING');
    const recoverySigners = [{
      index: 0,
      derivationIndex: 0,
      address: signerId,
      name: 'leader vote signer',
      entityId,
      jurisdiction: jurisdiction.name,
    }];
    const snapshotBundle = buildRuntimeRecoveryBundle(env, {
      signers: recoverySigners,
      createdAt: 1_000,
    });
    const voteBody = buildEntityLeaderVoteBody(replica.state);
    const vote: EntityLeaderTimeoutVote = {
      ...voteBody,
      voterId,
      signature: signAccountFrame(env, voterId, hashEntityLeaderVoteBody(voteBody)),
    };

    enqueueRuntimeInput(env, voteRuntimeInput(replica, vote));
    await processRuntime(env, []);
    expect(env.height).toBe(2);
    const frame = await readPersistedFrameJournal(env, env.height);
    if (!frame) throw new Error('LEADER_TIMEOUT_VOTE_JOURNAL_MISSING');
    const tailBundle = buildRuntimeRecoveryBundle(env, {
      signers: recoverySigners,
      kind: 'journal_tail',
      baseCheckpoint: {
        height: snapshotBundle.runtimeHeight,
        hash: snapshotBundle.checkpointHash!,
      },
      frames: [frame],
      createdAt: 2_000,
    });
    const forgedTail = structuredClone(tailBundle);
    const forgedFrame = forgedTail.frames?.[0];
    if (!forgedFrame) throw new Error('LEADER_TIMEOUT_VOTE_FORGED_FRAME_MISSING');
    forgedFrame.runtimeInput.entityInputs = [];
    const wrongReplicaDigestFrame = structuredClone(frame);
    wrongReplicaDigestFrame.replicaMetaDigest = `0x${'77'.repeat(32)}`;
    const signedWrongReplicaDigestTail = buildRuntimeRecoveryBundle(env, {
      signers: recoverySigners,
      kind: 'journal_tail',
      baseCheckpoint: {
        height: snapshotBundle.runtimeHeight,
        hash: snapshotBundle.checkpointHash!,
      },
      frames: [wrongReplicaDigestFrame],
      createdAt: 2_001,
    });
    await closeRuntimeDb(env);
    await closeInfraDb(env);

    let forgedRestoreError: unknown = null;
    let forgedRestoredEnv: Env | null = null;
    try {
      forgedRestoredEnv = await restoreEnvFromRecoveryBundles(
        [snapshotBundle, forgedTail],
        { runtimeSeed: seed, runtimeId: env.runtimeId },
      );
    } catch (error) {
      forgedRestoreError = error;
    } finally {
      if (forgedRestoredEnv) {
        await closeRuntimeDb(forgedRestoredEnv);
        await closeInfraDb(forgedRestoredEnv);
      }
    }
    expect(
      forgedRestoreError instanceof Error ? forgedRestoreError.message : String(forgedRestoreError),
    ).toContain('RECOVERY_BUNDLE_SIGNATURE_INVALID');

    const baseAnchorTamper = structuredClone(tailBundle);
    baseAnchorTamper.baseCheckpointHash = `0x${'99'.repeat(32)}`;
    await expect(restoreEnvFromRecoveryBundles(
      [snapshotBundle, baseAnchorTamper],
      { runtimeSeed: seed, runtimeId: env.runtimeId },
    )).rejects.toThrow('RECOVERY_BUNDLE_SIGNATURE_INVALID');

    const runtimeStateHashTamper = structuredClone(tailBundle);
    runtimeStateHashTamper.frames![0]!.runtimeStateHash = `0x${'66'.repeat(32)}`;
    await expect(restoreEnvFromRecoveryBundles(
      [snapshotBundle, runtimeStateHashTamper],
      { runtimeSeed: seed, runtimeId: env.runtimeId },
    )).rejects.toThrow('RECOVERY_BUNDLE_SIGNATURE_INVALID');

    const splicedFrameTail = structuredClone(tailBundle);
    splicedFrameTail.frames![0]!.timestamp += 1;
    await expect(restoreEnvFromRecoveryBundles(
      [snapshotBundle, splicedFrameTail],
      { runtimeSeed: seed, runtimeId: env.runtimeId },
    )).rejects.toThrow('RECOVERY_BUNDLE_SIGNATURE_INVALID');

    const wrongRuntimeId = deriveSignerAddressSync(`${seed}:wrong-runtime`, '1').toLowerCase();

    const reorderedFrameTail = structuredClone(tailBundle);
    reorderedFrameTail.frames![0]!.height += 1;
    await expect(restoreEnvFromRecoveryBundles(
      [snapshotBundle, reorderedFrameTail],
      { runtimeSeed: seed, runtimeId: env.runtimeId },
    )).rejects.toThrow('RECOVERY_BUNDLE_JOURNAL_FRAME_GAP');

    await expect(restoreEnvFromRecoveryBundles(
      [snapshotBundle, signedWrongReplicaDigestTail],
      { runtimeSeed: seed, runtimeId: env.runtimeId },
    )).rejects.toThrow('RECOVERY_JOURNAL_REPLICA_META_DIGEST_MISMATCH');

    await expect(restoreEnvFromRecoveryBundles(
      [snapshotBundle, tailBundle],
      { runtimeSeed: `${seed}:wrong`, runtimeId: env.runtimeId },
    )).rejects.toThrow('RECOVERY_BUNDLE_TRUSTED_RUNTIME_ID_MISMATCH');

    await expect(restoreEnvFromRecoveryBundles(
      [snapshotBundle, tailBundle],
      { runtimeSeed: seed, runtimeId: wrongRuntimeId },
    )).rejects.toThrow('RECOVERY_BUNDLE_TRUSTED_RUNTIME_ID_MISMATCH');

    const payloadRuntimeIdTamper = structuredClone(tailBundle);
    payloadRuntimeIdTamper.runtimeId = wrongRuntimeId;
    await expect(restoreEnvFromRecoveryBundles(
      [snapshotBundle, payloadRuntimeIdTamper],
      { runtimeSeed: seed, runtimeId: env.runtimeId },
    )).rejects.toThrow('RECOVERY_BUNDLE_SIGNATURE_INVALID');

    const unsignedTail = structuredClone(tailBundle);
    delete (unsignedTail as Partial<typeof unsignedTail>).signature;
    expect(() => validateRuntimeRecoveryBundle(unsignedTail)).toThrow('RECOVERY_BUNDLE_SIGNATURE_INVALID');

    const restored = await loadEnvFromDB(env.runtimeId, seed);
    if (!restored) throw new Error('LEADER_TIMEOUT_VOTE_RESTORE_MISSING');
    try {
      const restoredReplica = restored.eReplicas.get(`${replica.entityId}:${replica.signerId}`);
      expect(restored.height).toBe(2);
      expect(restoredReplica?.leaderVotes?.get(vote.voterId)).toEqual(vote);
    } finally {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }

    const recoveredFromJournal = await restoreEnvFromRecoveryBundles(
      [snapshotBundle, tailBundle],
      { runtimeSeed: seed, runtimeId: env.runtimeId },
    );
    try {
      const recoveredReplica = recoveredFromJournal.eReplicas.get(`${replica.entityId}:${replica.signerId}`);
      expect(recoveredFromJournal.height).toBe(2);
      expect(recoveredReplica?.leaderVotes?.get(vote.voterId)).toEqual(vote);
    } finally {
      await closeRuntimeDb(recoveredFromJournal);
      await closeInfraDb(recoveredFromJournal);
    }
  });
});
