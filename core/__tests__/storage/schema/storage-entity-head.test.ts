import { describe, expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../../account/crypto';
import { createEntityFrameHashFromStateRoot } from '../../../entity/consensus/frame';
import { appendCertifiedEntityFrameLink } from '../../../entity/consensus/frame/lineage';
import { getEntityLeaderState } from '../../../entity/consensus/leader';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityAccountValueHash,
  computeEntityFrameAuthorityRoot,
} from '../../../entity/consensus/state-root';
import { generateLazyEntityId } from '../../../entity/factory';
import { initCrontab } from '../../../entity/scheduler';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import type {
  CertifiedEntityFrameLink,
  EntityReplica,
  EntityState,
  JurisdictionConfig,
} from '../../../entity/types';
import { buildQuorumHanko } from '../../../hanko/signing';
import { provisionTestEntityEncryptionKey } from '../../../qa/entity-creation-fixture';
import { createEmptyEnv } from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import { decodeBuffer } from '../../../storage/codec/codec';
import {
  applyCertifiedEntityHeadPlan,
  buildCertifiedEntityHeadPlan,
  buildRuntimeCheckpointHeadPlan,
} from '../../../storage/replica/entity-head';
import {
  areStorageCheckpointReplicasConverged,
  areStorageCheckpointReplicasQuiescent,
  buildLiveReplicaMetaPlan,
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitment,
} from '../../../storage/replica/replicas';
import type { StorageReplicaMeta } from '../../../storage/types';
import type { EntityTx } from '../../../types/entity-tx';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';

const address = (byte: string): string => `0x${byte.repeat(20)}`;
const jurisdiction: JurisdictionConfig = {
  name: 'EntityHeadTestnet',
  address: 'rpc://entity-head-testnet',
  chainId: 31_337,
  depositoryAddress: address('21'),
  entityProviderAddress: address('22'),
};

const makeGenesis = (signerId: string): EntityState => {
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  return {
    entityId,
    height: 0,
    timestamp: 0,
    nonces: new Map(),
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signerId],
      shares: { [signerId]: 1n },
      jurisdiction,
    },
    reserves: new Map(),
    accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
    deferredAccountProposals: new Map(),
    crontabState: initCrontab(),
    lastFinalizedJHeight: 0,
    profile: { name: 'head', isHub: false, avatar: '', bio: '', website: '' },
    paybook: { entries: new Map(), feesEarned: 0n },
    swapTradingPairs: [],
    pendingCrossJurisdictionFillAcks: new Map(),
    crossJurisdictionBookAdmissions: new Map(),
  };
};

const makeRuntime = (seed: string): { env: RuntimeReplica; signerId: string; genesis: EntityState } => {
  const env = createEmptyEnv(seed);
  env.runtimeSeed = seed;
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { storage: { enabled: false } };
  const signerId = deriveSignerAddressSync(seed, 'entity-head-validator').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, 'entity-head-validator'));
  return { env, signerId, genesis: makeGenesis(signerId) };
};

const certifyNextFrame = async (
  env: RuntimeReplica,
  signerId: string,
  preState: EntityState,
  txs: EntityTx[] = [],
): Promise<{ state: EntityState; link: CertifiedEntityFrameLink }> => {
  preState.entityEncryptionPublicKey = provisionTestEntityEncryptionKey(env, preState.entityId).publicKey;
  const timestamp = preState.timestamp + 100;
  const height = preState.height + 1;
  const applied = await applyEntityFrameWithMaterializedTestInfraContext(env, preState, txs, timestamp);
  const postState: EntityState = {
    ...applied.newState,
    entityId: preState.entityId,
    height,
    timestamp,
    leaderState: getEntityLeaderState(preState),
  };
  const stateRoot = computeCanonicalEntityConsensusStateHash(postState);
  const postAuthority = buildEntityFrameAuthority(postState);
  const authorityRoot = computeEntityFrameAuthorityRoot(postAuthority);
  const parentFrameHash = preState.height === 0 ? 'genesis' : String(preState.prevFrameHash || '');
  const hash = createEntityFrameHashFromStateRoot(
    parentFrameHash,
    height,
    timestamp,
    txs,
    applied.events,
    preState.entityId,
    stateRoot,
    authorityRoot,
    applied.entityContext,
  );
  const hashesToSign = [{ hash, type: 'entityFrame' as const, context: `entity-frame:${height}` }];
  const signature = await signAccountFrame(env, signerId, hash);
  const hanko = await buildQuorumHanko(
    env,
    preState.entityId,
    hash,
    [{ signerId, signature }],
    postState.config,
    postState,
  );
  return {
    state: { ...postState, prevFrameHash: hash },
    link: {
      frame: {
        parentFrameHash,
        height,
        timestamp,
        txs,
        events: applied.events,
        entityContext: applied.entityContext,
        hash,
        stateRoot,
        authorityRoot,
        leader: { proposerSignerId: signerId, view: getEntityLeaderState(preState).view },
        hashesToSign,
        collectedSigs: new Map([[signerId, [signature]]]),
        hankos: [hanko],
      },
      postAuthority,
    },
  };
};

const installReplica = (
  env: RuntimeReplica,
  signerId: string,
  state: EntityState,
  head?: CertifiedEntityFrameLink,
): EntityReplica => {
  state.entityEncryptionPublicKey = provisionTestEntityEncryptionKey(env, state.entityId).publicKey;
  const replica: EntityReplica = {
    entityId: state.entityId,
    signerId,
    state,
    mempool: [],
    isProposer: true,
    ...(head ? { certifiedFrameHead: head } : {}),
  };
  env.state.eReplicas = new Map([[`${state.entityId}:${signerId}`, replica]]);
  return replica;
};

describe('certified Entity current head', () => {
  test('checkpoint persists one full head and restore advances its exact H+1 parent', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-full-head-roundtrip');
    const h1 = await certifyNextFrame(env, signerId, genesis);
    installReplica(env, signerId, h1.state, h1.link);

    const checkpoint = buildStorageReplicaMetaCommitment(env, buildRuntimeCheckpointHeadPlan(env));
    const meta = decodeBuffer(checkpoint.entries[0]!.value) as StorageReplicaMeta;
    expect(meta.certifiedFrameHead).toEqual(h1.link);

    const restored = installReplica(env, signerId, h1.state, meta.certifiedFrameHead);
    const h2 = await certifyNextFrame(env, signerId, h1.state);
    const effects: Parameters<typeof appendCertifiedEntityFrameLink>[2] = [];
    restored.state = h2.state;
    appendCertifiedEntityFrameLink(restored, h2.link, effects);

    expect(restored.certifiedFrameHead?.frame.height).toBe(2);
    expect(restored.certifiedFrameHead?.frame.parentFrameHash).toBe(h1.link.frame.hash);
    expect(effects).toHaveLength(1);
    expect(() => buildCertifiedEntityHeadPlan(env)).not.toThrow();
  });

  test('Runtime replica-meta digest binds the compact current certificate, not repeated frame bodies', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-full-head-digest');
    const h1 = await certifyNextFrame(env, signerId, genesis);
    const replica = installReplica(env, signerId, h1.state, h1.link);
    const before = buildStorageLiveReplicaMetaCommitment(env).digest;

    const signatures = new Map(h1.link.frame.collectedSigs);
    const original = signatures.get(signerId)![0]!;
    signatures.set(signerId, [`${original.slice(0, -1)}${original.endsWith('0') ? '1' : '0'}`]);
    replica.certifiedFrameHead = {
      ...h1.link,
      frame: { ...h1.link.frame, collectedSigs: signatures },
    };

    expect(buildStorageLiveReplicaMetaCommitment(env).digest).not.toBe(before);

    const afterSignature = buildStorageLiveReplicaMetaCommitment(env).digest;
    replica.certifiedFrameHead = {
      ...replica.certifiedFrameHead,
      frame: {
        ...replica.certifiedFrameHead.frame,
        txs: [{ type: 'chatMessage', data: { message: 'already bound by frameHash' } }],
      },
    };
    expect(buildStorageLiveReplicaMetaCommitment(env).digest).toBe(afterSignature);
  });

  test('durable replica metadata excludes every speculative Entity overlay', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-no-speculative-meta');
    const h1 = await certifyNextFrame(env, signerId, genesis);
    const replica = installReplica(env, signerId, h1.state, h1.link);
    replica.mempool = [{ type: 'chat', data: { from: signerId, message: 'RAM only' } }];
    const envelope = replica as unknown as Record<string, unknown>;
    envelope['proposal'] = { hash: 'proposal-must-not-persist' };
    envelope['lockedFrame'] = { hash: 'locked-must-not-persist' };
    envelope['candidate'] = { frameHash: 'candidate-must-not-persist', height: 2 };

    const checkpoint = decodeBuffer(
      buildStorageReplicaMetaCommitment(env, buildRuntimeCheckpointHeadPlan(env)).entries[0]!.value,
    ) as Record<string, unknown>;
    for (const field of ['mempool', 'proposal', 'lockedFrame', 'candidate']) {
      expect(Object.hasOwn(checkpoint, field)).toBe(false);
    }

    const live = decodeBuffer(
      buildStorageLiveReplicaMetaCommitment(env).entries[0]!.value,
    ) as Record<string, unknown>;
    for (const field of [
      'mempoolCount', 'proposalHash', 'lockedFrameHash', 'candidateFrameHash', 'candidateHeight',
    ]) expect(Object.hasOwn(live, field)).toBe(false);
  });

  test('rejects retired anchor-only metadata instead of recovering a carried root', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-anchor-only-rejected');
    const h1 = await certifyNextFrame(env, signerId, genesis);
    const replica = installReplica(env, signerId, h1.state);
    (replica as EntityReplica & { certifiedFrameAnchor?: unknown }).certifiedFrameAnchor = {
      height: 1,
      frameHash: h1.link.frame.hash,
      stateRoot: h1.link.frame.stateRoot,
    };
    expect(() => buildCertifiedEntityHeadPlan(env)).toThrow('STORAGE_ENTITY_CERTIFIED_HEAD_REQUIRED');
  });

  test('checkpoint convergence and quiescence remain exact replica barriers', () => {
    const { env, signerId, genesis } = makeRuntime('storage-head-barrier');
    const replica = installReplica(env, signerId, genesis);
    expect(areStorageCheckpointReplicasConverged(env)).toBe(true);
    expect(areStorageCheckpointReplicasQuiescent(env)).toBe(true);
    replica.mempool = [{ type: 'chat', data: { from: signerId, message: 'pending' } }];
    expect(areStorageCheckpointReplicasQuiescent(env)).toBe(false);
    replica.mempool = [];
    applyCertifiedEntityHeadPlan(env, buildCertifiedEntityHeadPlan(env));
    expect(replica.certifiedFrameHead).toBeUndefined();
  });

  test('ordinary WAL selects the highest replica but rejects a same-height state fork', async () => {
    const { env, signerId, genesis } = makeRuntime('storage-live-replica-selection');
    const h1 = await certifyNextFrame(env, signerId, genesis);
    const current = installReplica(env, signerId, h1.state, h1.link);
    const laggingSigner = address('42');
    const lagging: EntityReplica = {
      ...current,
      signerId: laggingSigner,
      state: { ...genesis },
    };
    env.state.eReplicas.set(`${genesis.entityId}:${laggingSigner}`, lagging);

    expect(buildLiveReplicaMetaPlan(env).lookup.get(genesis.entityId)?.state.height).toBe(1);
    expect(areStorageCheckpointReplicasConverged(env)).toBe(false);

    lagging.state = { ...h1.state, timestamp: h1.state.timestamp + 1 };
    expect(() => buildLiveReplicaMetaPlan(env)).toThrow(
      'STORAGE_ENTITY_REPLICA_STATE_DIVERGENCE',
    );
  });
});
