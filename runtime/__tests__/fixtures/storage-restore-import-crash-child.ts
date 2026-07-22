import {
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeStorageDb,
  persistRestoredEnvToDB,
  process as processRuntime,
  registerSignerKey,
} from '../../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  signAccountFrame,
} from '../../account/crypto';
import { createEntityFrameHashFromStateRoot } from '../../entity/consensus/frame';
import { getEntityLeaderState } from '../../entity/consensus/leader';
import { generateLazyEntityId } from '../../entity/factory';
import {
  applyConsumptionOutput,
  createConsumptionProof,
  createEmptyConsumptionAccumulator,
  getConsumptionKey,
} from '../../entity/consumption-accumulator';
import {
  cacheCommittedConsumptionNodeChanges,
  getConsumptionNodeStore,
} from '../../entity/consumption-store';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../entity/consensus/state-root';
import type { StoragePersistenceBoundary } from '../../storage';
import type { CertifiedEntityFrameLink, JReplica, JurisdictionConfig } from '../../types';

const [seed, requestedBoundary] = Bun.argv.slice(2);
if (!seed || !requestedBoundary) throw new Error('seed and restore boundary are required');
const boundary = requestedBoundary as StoragePersistenceBoundary;
const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
const signerId = runtimeId;
registerSignerKey(seed, signerId, deriveSignerKeySync(seed, '1'));
const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
const jurisdiction: JurisdictionConfig = {
  name: 'restore-import-crash',
  address: 'browservm://restore-import-crash',
  depositoryAddress: '0x000000000000000000000000000000000000dead',
  entityProviderAddress: '0x000000000000000000000000000000000000beef',
  chainId: 31337,
};
const env = createEmptyEnv(seed);
env.runtimeId = runtimeId;
env.dbNamespace = runtimeId;
env.quietRuntimeLogs = true;
env.runtimeConfig = {
  ...env.runtimeConfig,
  storage: { ...env.runtimeConfig?.storage, enabled: false },
};
env.activeJurisdiction = jurisdiction.name;
env.jReplicas.set(jurisdiction.name, {
  ...jurisdiction,
  blockNumber: 0n,
  stateRoot: new Uint8Array(32),
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  rpcs: [jurisdiction.address!],
  position: { x: 0, y: 0, z: 0 },
  contracts: {
    depository: jurisdiction.depositoryAddress,
    entityProvider: jurisdiction.entityProviderAddress,
    account: '0x000000000000000000000000000000000000ac01',
    deltaTransformer: '0x000000000000000000000000000000000000de17',
  },
} as JReplica);
enqueueRuntimeInput(env, {
  runtimeTxs: [{
    type: 'importReplica',
    entityId,
    signerId,
    data: {
      isProposer: true,
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [signerId],
        shares: { [signerId]: 1n },
        jurisdiction,
      },
    },
  }],
  entityInputs: [],
});
await processRuntime(env, []);
const replica = Array.from(env.eReplicas.values())[0];
if (!replica) throw new Error('restore import crash replica missing');
const consumptionIdentity = (height: number) => ({
  targetEntityId: entityId,
  sourceEntityId: `0x${'22'.repeat(32)}`,
  lane: 'generic' as const,
  sequence: height,
  semanticHash: `0x${height.toString(16).padStart(2, '0').repeat(32)}`,
  outputHash: `0x${(height + 16).toString(16).padStart(2, '0').repeat(32)}`,
  outputHanko: `0x${height.toString(16).padStart(2, '0')}`,
});
const commitConsumption = async (height: number): Promise<void> => {
  const preState = replica.state;
  const before = replica.state.consumptionAccumulator ?? createEmptyConsumptionAccumulator();
  const identity = consumptionIdentity(height);
  const proof = createConsumptionProof(
    getConsumptionNodeStore(env),
    before.root,
    getConsumptionKey(identity),
  );
  const applied = applyConsumptionOutput(before, identity, proof);
  const entityHeight = preState.height + 1;
  const timestamp = preState.timestamp + 1;
  const postStateWithoutHead = {
    ...preState,
    height: entityHeight,
    timestamp,
    consumptionAccumulator: applied.state,
  };
  const stateRoot = computeCanonicalEntityConsensusStateHash(postStateWithoutHead);
  const postAuthority = buildEntityFrameAuthority(postStateWithoutHead);
  const authorityRoot = computeEntityFrameAuthorityRoot(postAuthority);
  const parentFrameHash = preState.height === 0 ? 'genesis' : String(preState.prevFrameHash || '');
  const txs = [];
  const hash = createEntityFrameHashFromStateRoot(
    parentFrameHash,
    entityHeight,
    timestamp,
    txs,
    entityId,
    stateRoot,
    authorityRoot,
  );
  const hashesToSign = [{
    hash,
    type: 'entityFrame' as const,
    context: `entity-frame:${entityHeight}`,
  }];
  const signature = await signAccountFrame(env, signerId, hash);
  const link: CertifiedEntityFrameLink = {
    frame: {
      parentFrameHash,
      height: entityHeight,
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
    },
    postAuthority,
  };
  replica.state = { ...postStateWithoutHead, prevFrameHash: hash };
  replica.certifiedFrameLineage = [
    ...(replica.certifiedFrameLineage ?? []),
    link,
  ];
  cacheCommittedConsumptionNodeChanges(env, {
    newNodes: applied.newNodes,
    replacedNodeHashes: applied.replacedNodeHashes,
  });
};
await commitConsumption(1);
replica.lastConsensusProgressAt = 1_000;
env.timestamp = 1_000;
await persistRestoredEnvToDB(env);

// Exercise the chunked cache-clear boundary too. This key is deliberately not
// authoritative: recovery must discard it and rebuild solely from history.
await getRuntimeStorageDb(env).put(Buffer.from([0x7f]), Buffer.from('stale-cache'), { sync: true });
env.height += 1;
await commitConsumption(2);
replica.lastConsensusProgressAt = 2_000;
env.timestamp = 2_000;
await persistRestoredEnvToDB(env, {
  onPersistenceBoundary: (reached) => {
    if (reached !== boundary) return;
    process.kill(process.pid, 'SIGKILL');
  },
});
throw new Error(`SIGKILL did not stop process at ${boundary}`);
