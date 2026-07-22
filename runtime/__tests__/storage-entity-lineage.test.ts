import { describe, expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import { deriveLocalEntityCryptoKeys } from '../entity/crypto';
import { buildSignedEntityCommand } from '../entity/command';
import { signedEntityCommandTx } from '../entity/command-codec';
import { applyEntityFrame, selectPreparedFrameFromCertificate } from '../entity/consensus';
import { createEntityFrameHashFromStateRoot } from '../entity/consensus/frame';
import {
  buildEntityLeaderCertificate,
  buildEntityLeaderVoteBody,
  getEntityLeaderState,
  hashEntityLeaderVoteBody,
} from '../entity/consensus/leader';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';
import { generateLazyEntityId } from '../entity/factory';
import { initCrontab } from '../entity/scheduler';
import { applyRuntimeTx } from '../machine/tx-handlers';
import { createEmptyEnv } from '../runtime';
import { computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';
import { decodeBuffer } from '../storage/codec';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
  buildRuntimeCheckpointLineagePlan,
} from '../storage/entity-lineage';
import { buildStorageReplicaMetaCommitment } from '../storage/replicas';
import type { StorageReplicaMeta } from '../storage/types';
import type {
  CertifiedEntityFrameLink,
  CertifiedEntityLineageAnchor,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  JReplica,
  JurisdictionConfig,
} from '../types';

const address = (byte: string): string => `0x${byte.repeat(20)}`;
const lineageJurisdiction: JurisdictionConfig = {
  name: 'LineageCommandTestnet',
  address: 'rpc://lineage-command-testnet',
  chainId: 31_337,
  depositoryAddress: address('21'),
  entityProviderAddress: address('22'),
};

const makeGenesis = (env: Env, signerId: string): EntityState => {
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  return {
    entityId,
    height: 0,
    timestamp: 0,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signerId],
      shares: { [signerId]: 1n },
      jurisdiction: lineageJurisdiction,
    },
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    crontabState: initCrontab(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    entityEncPubKey: `0x${'11'.repeat(32)}`,
    entityEncPrivKey: `0x${'22'.repeat(32)}`,
    profile: { name: 'lineage', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    htlcNotes: new Map(),
    lockBook: new Map(),
    swapTradingPairs: [],
    pendingCrossJurisdictionFillAcks: new Map(),
    crossJurisdictionBookAdmissions: new Map(),
  };
};

const makeRuntime = (seed: string): { env: Env; signerId: string; genesis: EntityState } => {
  const env = createEmptyEnv(seed);
  env.runtimeSeed = seed;
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { storage: { enabled: false } };
  const signerId = deriveSignerAddressSync(seed, 'lineage-validator').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, 'lineage-validator'));
  return { env, signerId, genesis: makeGenesis(env, signerId) };
};

const genesisAnchor = (state: EntityState): CertifiedEntityLineageAnchor => ({
  entityId: state.entityId,
  height: 0,
  frameHash: 'genesis',
  stateRoot: computeCanonicalEntityConsensusStateHash(state),
  authority: buildEntityFrameAuthority(state),
});

const certifyNextFrame = async (
  env: Env,
  signerId: string,
  preState: EntityState,
  txs: EntityTx[],
): Promise<{ state: EntityState; link: CertifiedEntityFrameLink }> => {
  const timestamp = preState.timestamp + 100;
  const height = preState.height + 1;
  const applied = await applyEntityFrame(env, preState, txs, timestamp);
  const postStateWithoutHead: EntityState = {
    ...applied.newState,
    entityId: preState.entityId,
    height,
    timestamp,
    leaderState: getEntityLeaderState(preState),
  };
  const stateRoot = computeCanonicalEntityConsensusStateHash(postStateWithoutHead);
  const postAuthority = buildEntityFrameAuthority(postStateWithoutHead);
  const authorityRoot = computeEntityFrameAuthorityRoot(postAuthority);
  const parentFrameHash = preState.height === 0 ? 'genesis' : String(preState.prevFrameHash || '');
  const hash = createEntityFrameHashFromStateRoot(
    parentFrameHash,
    height,
    timestamp,
    txs,
    preState.entityId,
    stateRoot,
    authorityRoot,
  );
  const hashesToSign = [{ hash, type: 'entityFrame' as const, context: `entity-frame:${height}` }];
  const signature = await signAccountFrame(env, signerId, hash);
  const frame = {
    parentFrameHash,
    height,
    timestamp,
    txs,
    hash,
    stateRoot,
    authorityRoot,
    leader: {
      proposerSignerId: signerId,
      view: getEntityLeaderState(preState).view,
    },
    hashesToSign,
    collectedSigs: new Map([[signerId, [signature]]]),
  };
  return {
    state: { ...postStateWithoutHead, prevFrameHash: hash },
    link: { frame, postAuthority },
  };
};

const installReplica = (
  env: Env,
  signerId: string,
  state: EntityState,
  options: {
    anchor?: CertifiedEntityLineageAnchor;
    lineage?: CertifiedEntityFrameLink[];
  } = {},
): EntityReplica => {
  const replica: EntityReplica = {
    entityId: state.entityId,
    signerId,
    state,
    mempool: [],
    isProposer: true,
    ...(options.anchor ? { certifiedFrameAnchor: options.anchor } : {}),
    ...(options.lineage ? { certifiedFrameLineage: options.lineage } : {}),
  };
  env.eReplicas = new Map([[`${state.entityId}:${signerId}`, replica]]);
  return replica;
};

const installCertifiedImportFixture = async (
  seed: string,
): Promise<{ env: Env; signerId: string; state: EntityState }> => {
  const { env, signerId, genesis } = makeRuntime(seed);
  const jurisdiction: JurisdictionConfig = {
    name: 'LineageTestnet',
    address: 'rpc://lineage-testnet',
    chainId: 31337,
    depositoryAddress: address('31'),
    entityProviderAddress: address('32'),
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    rpcs: [jurisdiction.address],
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
  } as JReplica);
  genesis.config.jurisdiction = jurisdiction;
  const keys = deriveLocalEntityCryptoKeys(env, genesis.entityId, signerId);
  genesis.entityEncPubKey = keys.publicKey;
  genesis.entityEncPrivKey = keys.privateKey;
  const certified = await certifyNextFrame(env, signerId, genesis, []);
  installReplica(env, signerId, certified.state, {
    anchor: genesisAnchor(genesis),
    lineage: [certified.link],
  });
  return { env, signerId, state: certified.state };
};

describe('certified Entity storage lineage', () => {
  test('publishes a self-certifying H0 anchor for a lazy Entity', () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-genesis');
    installReplica(env, signerId, genesis);

    const plan = buildCertifiedEntityLineagePlan(env);
    expect(plan.lookup.get(genesis.entityId)?.state.height).toBe(0);
    expect(plan.anchorByReplicaKey.get(`${genesis.entityId}:${signerId}`))
      .toEqual(genesisAnchor(genesis));
  });

  test('restores an H0 anchor with the exact configured 1-of-2 board threshold', () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-configured-threshold');
    const observerId = deriveSignerAddressSync(env.runtimeSeed!, 'lineage-observer').toLowerCase();
    genesis.config = {
      ...genesis.config,
      threshold: 1n,
      validators: [signerId, observerId],
      shares: { [signerId]: 1n, [observerId]: 1n },
    };
    genesis.entityId = generateLazyEntityId([signerId, observerId], 1n).toLowerCase();
    installReplica(env, signerId, genesis);

    const plan = buildCertifiedEntityLineagePlan(env);
    expect(plan.lookup.get(genesis.entityId)?.state.config.threshold).toBe(1n);
    expect(plan.anchorByReplicaKey.get(`${genesis.entityId}:${signerId}`)?.authority.config)
      .toEqual(genesis.config);
  });

  test('accepts a continuous root-bound H0 -> H1 quorum certificate', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-valid-h1');
    const certified = await certifyNextFrame(env, signerId, genesis, [
      signedEntityCommandTx(buildSignedEntityCommand(env, genesis, signerId, [{
        type: 'chat',
        data: { from: signerId, message: 'certified-height-one' },
      }])),
    ]);
    installReplica(env, signerId, certified.state, {
      anchor: genesisAnchor(genesis),
      lineage: [certified.link],
    });

    const plan = buildCertifiedEntityLineagePlan(env);
    expect(plan.lookup.get(genesis.entityId)?.state.messages.some(message => (
      message.endsWith(': certified-height-one')
    ))).toBeTrue();
    expect(plan.lineageByReplicaKey.get(`${genesis.entityId}:${signerId}`)?.map(link => link.frame.height))
      .toEqual([1]);
  });

  test('shares exact Entity endpoint evidence across validator-local checkpoint replicas', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-shared-endpoint');
    const observerId = deriveSignerAddressSync(env.runtimeSeed!, 'lineage-observer').toLowerCase();
    registerSignerKey(env, observerId, deriveSignerKeySync(env.runtimeSeed!, 'lineage-observer'));
    genesis.config = {
      ...genesis.config,
      threshold: 1n,
      validators: [signerId, observerId],
      shares: { [signerId]: 1n, [observerId]: 1n },
    };
    genesis.entityId = generateLazyEntityId([signerId, observerId], 1n).toLowerCase();
    const certified = await certifyNextFrame(env, signerId, genesis, []);
    const observerState = structuredClone(certified.state);
    env.height = 100;
    env.eReplicas = new Map([
      [`${genesis.entityId}:${signerId}`, {
        entityId: genesis.entityId,
        signerId,
        state: certified.state,
        mempool: [],
        isProposer: true,
        certifiedFrameAnchor: genesisAnchor(genesis),
        certifiedFrameLineage: [certified.link],
      }],
      [`${genesis.entityId}:${observerId}`, {
        entityId: genesis.entityId,
        signerId: observerId,
        state: observerState,
        mempool: [],
        isProposer: false,
      }],
    ]);

    const plan = buildRuntimeCheckpointLineagePlan(env);
    const proposerAnchor = plan.anchorByReplicaKey.get(`${genesis.entityId}:${signerId}`);
    const observerAnchor = plan.anchorByReplicaKey.get(`${genesis.entityId}:${observerId}`);
    expect(observerAnchor?.frameHash).toBe(certified.link.frame.hash);
    expect(observerAnchor?.stateRoot).toBe(certified.link.frame.stateRoot);
    expect(observerAnchor?.runtimeCheckpoint).toEqual(proposerAnchor?.runtimeCheckpoint);

    observerState.messages.push('tampered after certification');
    expect(() => buildRuntimeCheckpointLineagePlan(env))
      .toThrow('STORAGE_RUNTIME_CHECKPOINT_STATE_MISMATCH');
  });

  test('rebases certified lineage into the atomic runtime WAL checkpoint', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-bounded-checkpoint');
    env.height = 20;
    let state = genesis;
    const lineage: CertifiedEntityFrameLink[] = [];
    for (let height = 1; height <= 20; height += 1) {
      const certified = await certifyNextFrame(env, signerId, state, []);
      state = certified.state;
      lineage.push(certified.link);
    }
    const replica = installReplica(env, signerId, state, {
      anchor: genesisAnchor(genesis),
      lineage,
    });
    const stateRootBefore = computeCanonicalEntityConsensusStateHash(state);
    const runtimeRootBefore = computeCanonicalStateHashFromEnv(env);

    const commitment = buildStorageReplicaMetaCommitment(env);
    const meta = decodeBuffer<StorageReplicaMeta>(commitment.entries[0]!.value);

    expect(meta.certifiedFrameLineage ?? []).toHaveLength(20);
    expect(meta.certifiedFrameLineage?.[0]?.frame.height).toBe(1);
    expect(meta.certifiedFrameLineage?.at(-1)?.frame.height).toBe(20);
    expect(meta.certifiedFrameAnchor?.height).toBe(20);
    expect(meta.certifiedFrameAnchor?.frameHash).toBe(state.prevFrameHash);
    expect(meta.certifiedFrameAnchor?.stateRoot).toBe(stateRootBefore);
    expect(computeCanonicalEntityConsensusStateHash(meta.state)).toBe(stateRootBefore);

    replica.certifiedFrameAnchor = structuredClone(meta.certifiedFrameAnchor!);
    replica.certifiedFrameLineage = structuredClone(meta.certifiedFrameLineage ?? []);
    const restoredPlan = buildCertifiedEntityLineagePlan(env);
    expect(restoredPlan.lookup.get(state.entityId)?.state.height).toBe(20);
    expect(buildStorageReplicaMetaCommitment(env).digest).toBe(commitment.digest);
    expect(computeCanonicalStateHashFromEnv(env)).toBe(runtimeRootBefore);

    replica.certifiedFrameAnchor!.runtimeCheckpoint!.replicaSetRoot = `0x${'ff'.repeat(32)}`;
    expect(() => buildCertifiedEntityLineagePlan(env))
      .toThrow('STORAGE_ENTITY_LINEAGE_RUNTIME_CHECKPOINT_ROOT_MISMATCH');
  });

  test('repeat import preserves certified consensus state exactly', async () => {
    const { env, signerId, state } = await installCertifiedImportFixture(
      'storage-lineage-repeat-import',
    );
    const stateRootBefore = computeCanonicalEntityConsensusStateHash(state);

    await applyRuntimeTx(env, {
      type: 'importReplica',
      entityId: state.entityId,
      signerId,
      data: {
        config: structuredClone(state.config),
        isProposer: false,
      },
    });

    expect(state.swapTradingPairs).toEqual([]);
    expect(() => buildCertifiedEntityLineagePlan(env)).not.toThrow();
    expect(computeCanonicalEntityConsensusStateHash(state)).toBe(stateRootBefore);
  });

  test('repeat import depends only on the latest certified endpoint kept in memory', async () => {
    const { env, signerId, state: initialState } = await installCertifiedImportFixture(
      'storage-lineage-repeat-import-latest-only',
    );
    let state = initialState;
    let latest = env.eReplicas.values().next().value?.certifiedFrameLineage?.at(-1);
    for (let height = 2; height <= 20; height += 1) {
      const certified = await certifyNextFrame(env, signerId, state, []);
      state = certified.state;
      latest = certified.link;
    }
    const replica = env.eReplicas.get(`${state.entityId}:${signerId}`)!;
    replica.state = state;
    replica.certifiedFrameLineage = [latest!];
    delete replica.certifiedFrameAnchor;
    const stateRootBefore = computeCanonicalEntityConsensusStateHash(state);

    await applyRuntimeTx(env, {
      type: 'importReplica',
      entityId: state.entityId,
      signerId,
      data: {
        config: structuredClone(state.config),
        isProposer: false,
      },
    });

    expect(env.eReplicas.get(`${state.entityId}:${signerId}`)?.certifiedFrameLineage)
      .toHaveLength(1);
    expect(computeCanonicalEntityConsensusStateHash(state)).toBe(stateRootBefore);
  });

  test('keeps every certified Entity link when publishing a rolling checkpoint anchor', async () => {
    const { env, signerId, state: heightOne } = await installCertifiedImportFixture(
      'storage-lineage-multi-entity-frame-runtime-frame',
    );
    applyCertifiedEntityLineagePlan(env, buildRuntimeCheckpointLineagePlan(env));
    const replica = env.eReplicas.get(`${heightOne.entityId}:${signerId}`)!;
    expect(replica.certifiedFrameAnchor?.height).toBe(1);
    expect(replica.certifiedFrameLineage ?? []).toHaveLength(1);

    const heightTwo = await certifyNextFrame(env, signerId, heightOne, []);
    const heightThree = await certifyNextFrame(env, signerId, heightTwo.state, []);
    replica.state = heightThree.state;
    replica.certifiedFrameLineage = [
      ...(replica.certifiedFrameLineage ?? []),
      heightTwo.link,
      heightThree.link,
    ];

    expect(() => buildCertifiedEntityLineagePlan(env)).not.toThrow();
    applyCertifiedEntityLineagePlan(env, buildRuntimeCheckpointLineagePlan(env));
    expect(replica.certifiedFrameAnchor?.height).toBe(3);
    expect(replica.certifiedFrameLineage ?? []).toHaveLength(3);
    expect(replica.certifiedFrameLineage?.map(link => link.frame.height)).toEqual([1, 2, 3]);
  });

  test('repeat import preserves an already-published H0 anchor exactly', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-repeat-import-h0');
    const jurisdiction: JurisdictionConfig = {
      name: 'LineageH0Testnet',
      address: 'rpc://lineage-h0-testnet',
      chainId: 31337,
      depositoryAddress: address('41'),
      entityProviderAddress: address('42'),
    };
    env.activeJurisdiction = jurisdiction.name;
    env.jReplicas.set(jurisdiction.name, {
      name: jurisdiction.name,
      rpcs: [jurisdiction.address],
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
      entityProviderAddress: jurisdiction.entityProviderAddress,
    } as JReplica);
    genesis.config.jurisdiction = jurisdiction;
    const keys = deriveLocalEntityCryptoKeys(env, genesis.entityId, signerId);
    genesis.entityEncPubKey = keys.publicKey;
    genesis.entityEncPrivKey = keys.privateKey;
    const replica = installReplica(env, signerId, genesis, {
      anchor: genesisAnchor(genesis),
    });
    const stateRootBefore = computeCanonicalEntityConsensusStateHash(genesis);

    await applyRuntimeTx(env, {
      type: 'importReplica',
      entityId: genesis.entityId,
      signerId,
      data: {
        config: structuredClone(genesis.config),
        isProposer: false,
      },
    });

    expect(replica.state.swapTradingPairs).toEqual([]);
    expect(computeCanonicalEntityConsensusStateHash(replica.state)).toBe(stateRootBefore);
    expect(() => buildCertifiedEntityLineagePlan(env)).not.toThrow();

    await expect(applyRuntimeTx(env, {
      type: 'importReplica',
      entityId: genesis.entityId,
      signerId,
      data: {
        config: { ...structuredClone(genesis.config), mode: 'gossip-based' },
        isProposer: false,
      },
    })).rejects.toThrow('IMPORT_REPLICA_CONFIG_CHECKPOINT_MISMATCH');
    expect(computeCanonicalEntityConsensusStateHash(replica.state)).toBe(stateRootBefore);
  });

  test('repeat import rejects authority changes before mutating certified state', async () => {
    const { env, signerId, state } = await installCertifiedImportFixture(
      'storage-lineage-repeat-import-authority-conflict',
    );
    const stateRootBefore = computeCanonicalEntityConsensusStateHash(state);

    await expect(applyRuntimeTx(env, {
      type: 'importReplica',
      entityId: state.entityId,
      signerId,
      data: {
        config: { ...structuredClone(state.config), mode: 'gossip-based' },
        isProposer: false,
      },
    })).rejects.toThrow('IMPORT_REPLICA_CONFIG_CHECKPOINT_MISMATCH');
    expect(computeCanonicalEntityConsensusStateHash(state)).toBe(stateRootBefore);
    expect(() => buildCertifiedEntityLineagePlan(env)).not.toThrow();
  });

  test('rejects the old unsigned self-consistent H7 storage shortcut', () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-unsigned-h7');
    const crafted = structuredClone(genesis);
    crafted.height = 7;
    crafted.prevFrameHash = `0x${'77'.repeat(32)}`;
    installReplica(env, signerId, crafted);

    expect(() => buildCertifiedEntityLineagePlan(env))
      .toThrow('STORAGE_ENTITY_LINEAGE_ANCHOR_MISSING');
  });

  test('rejects an H1 endpoint whose certificate chain is missing', () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-gap');
    const crafted = structuredClone(genesis);
    crafted.height = 1;
    crafted.prevFrameHash = `0x${'33'.repeat(32)}`;
    installReplica(env, signerId, crafted, { anchor: genesisAnchor(genesis) });

    expect(() => buildCertifiedEntityLineagePlan(env))
      .toThrow('STORAGE_ENTITY_LINEAGE_GAP');
  });

  test('rejects a tampered quorum signature', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-bad-signature');
    const certified = await certifyNextFrame(env, signerId, genesis, []);
    certified.link.frame.collectedSigs = new Map([[signerId, [`0x${'00'.repeat(65)}`]]]);
    installReplica(env, signerId, certified.state, {
      anchor: genesisAnchor(genesis),
      lineage: [certified.link],
    });

    expect(() => buildCertifiedEntityLineagePlan(env))
      .toThrow('STORAGE_ENTITY_LINEAGE_SIGNATURE_INVALID');
  });

  test('rejects same-hash certificate variants with conflicting immutable metadata', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-metadata-equivocation');
    const certified = await certifyNextFrame(env, signerId, genesis, []);
    const conflictingVariant = structuredClone(certified.link);
    conflictingVariant.frame.hashesToSign![0]!.context = 'attacker-controlled-context';
    installReplica(env, signerId, certified.state, {
      anchor: genesisAnchor(genesis),
      lineage: [certified.link, conflictingVariant],
    });

    expect(() => buildCertifiedEntityLineagePlan(env))
      .toThrow('STORAGE_ENTITY_LINEAGE_CERT_VARIANT_CONFLICT');
  });

  test('prepared-frame selection rejects an unsigned leader-view mutation', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-lineage-prepared-leader');
    const certified = await certifyNextFrame(env, signerId, genesis, []);
    const preparedFrame = structuredClone(certified.link.frame);
    preparedFrame.leader.view = 999;
    const vote = {
      ...buildEntityLeaderVoteBody(genesis),
      voterId: signerId,
      preparedFrame,
      signature: '',
    };
    vote.signature = await signAccountFrame(env, signerId, hashEntityLeaderVoteBody(vote));
    const certificate = buildEntityLeaderCertificate(vote, new Map([[signerId, vote]]));

    expect(() => selectPreparedFrameFromCertificate(env, genesis, certificate))
      .toThrow('ENTITY_PREPARED_LEADER_INVALID');
  });
});
