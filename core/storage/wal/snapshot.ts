/**
 * Projects live Runtime/Entity/Jurisdiction replicas into durable recovery snapshots.
 * Key builders: canonical checkpoints that exclude proposals, handles, and transport state.
 * Human-audit importance: 99/100 — projection coverage defines recoverable authority.
 */
import type { EntityReplica, EntityState } from '../../entity/types';
import type { RuntimeReplica, EnvSnapshot, RoutedEntityInput, RuntimeInput } from '../../runtime/types';
import type { FrameLogEntry } from '../../types/logging';
import type { JReplica } from '../../types/jurisdiction-runtime';
import type { Profile } from '../../entity/profile';
import type { StorageReplicaMeta } from '../types';
import {
  collectReachableCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
} from '../../jurisdiction/machine/board-registry';
import {
  collectReachableAccountJClaimNodes,
} from '../../account/j-claims/j-claim-accumulator';
import {
  getAccountJClaimNodeStore,
  getLiveAccountJClaimAccumulatorStates,
} from '../../entity/account/account-j-claim-node-store';
import { decodeRuntimeConfig } from './runtime-machine-schema';
import {
  projectEntityCoreDoc,
  projectPortableAccountDoc,
} from '../read/projections';
import { projectPortableBook } from '../schema/book/portable';
import { decodeBrowserVmSerializedState } from '../../jurisdiction/adapter/browservm/browservm-state';

const projectPortableEntityState = (state: EntityState): Record<string, unknown> => {
  const accounts = new Map<string, ReturnType<typeof projectPortableAccountDoc>>();
  for (const [counterpartyId, account] of state.accounts) {
    accounts.set(counterpartyId, projectPortableAccountDoc(account));
  }
  const books = new Map<string, ReturnType<typeof projectPortableBook>>();
  for (const [pairId, book] of state.orderbookExt?.books ?? []) {
    books.set(pairId, projectPortableBook(state.entityId, pairId, book));
  }
  return {
    // Portable recovery is a storage graph, not a shallow EntityState clone.
    // Keeping this exact core/accounts/books split makes every custom Patricia
    // container cross one explicit codec and prevents private-field `{}` loss.
    core: projectEntityCoreDoc(state),
    accounts,
    books,
  };
};

const isZeroBytes32 = (value: Uint8Array): boolean =>
  value.length === 32 && value.every(byte => byte === 0);

const normalizeJStateRoot = (
  stateRoot: unknown,
  options?: { rpcBacked?: boolean },
): Uint8Array | null => {
  const normalized = stateRoot instanceof Uint8Array
    ? stateRoot
    : Array.isArray(stateRoot)
      ? new Uint8Array(stateRoot.map((value) => Number(value) & 0xff))
      : null;
  if (!(normalized instanceof Uint8Array) || normalized.length === 0) return null;
  if (options?.rpcBacked && isZeroBytes32(normalized)) return null;
  return new Uint8Array(normalized);
};

const normalizeJBlockNumber = (value: unknown): bigint => {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new Error(`RUNTIME_MACHINE_J_BLOCK_NUMBER_INVALID:${String(value)}`);
  }
  return value;
};

const requireNonNegativeNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`RUNTIME_MACHINE_J_${label}_INVALID:${String(value)}`);
  }
  return value;
};

const requireFinitePosition = (
  value: JReplica['position'],
): JReplica['position'] => {
  if (!value || typeof value !== 'object') {
    throw new Error('RUNTIME_MACHINE_J_POSITION_INVALID');
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    if (typeof value[axis] !== 'number' || !Number.isFinite(value[axis])) {
      throw new Error(`RUNTIME_MACHINE_J_POSITION_${axis.toUpperCase()}_INVALID`);
    }
  }
  return { ...value };
};

export type PersistedEntityReplicaSnapshot = StorageReplicaMeta & {
  state: EntityState;
};

export const buildCanonicalEntityReplicaSnapshot = (
  replica: EntityReplica,
): PersistedEntityReplicaSnapshot => {
  // This is an immutable projection, not an Entity clone. The committed state
  // and certified authority are persistent values. Replica-envelope work is
  // rebuilt from accepted Runtime WAL inputs and never enters a snapshot.
  return {
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: replica.state,
    ...(replica.certifiedFrameHead ? { certifiedFrameHead: replica.certifiedFrameHead } : {}),
    isProposer: replica.isProposer,
    ...(replica.leaderVotes ? { leaderVotes: replica.leaderVotes } : {}),
    ...(replica.pendingLeaderCertificate ? { pendingLeaderCertificate: replica.pendingLeaderCertificate } : {}),
    ...(replica.lastConsensusProgressAt !== undefined
      ? { lastConsensusProgressAt: replica.lastConsensusProgressAt }
      : {}),
    ...(replica.jHistory ? { jHistory: replica.jHistory } : {}),
    ...(replica.jPrefixRound ? { jPrefixRound: replica.jPrefixRound } : {}),
    ...(replica.jSubmitState ? { jSubmitState: replica.jSubmitState } : {}),
    ...(replica.entityProviderActionSubmitState
      ? { entityProviderActionSubmitState: replica.entityProviderActionSubmitState }
      : {}),
    ...(replica.htlcNotes ? { htlcNotes: replica.htlcNotes } : {}),
    ...(replica.position ? { position: replica.position } : {}),
    ...(replica.hankoWitness ? { hankoWitness: replica.hankoWitness } : {}),
  };
};

/** Rebuild the RAM-only Entity envelope after strict persisted-byte validation. */
export const hydratePersistedEntityReplicaSnapshot = (
  snapshot: PersistedEntityReplicaSnapshot,
): EntityReplica => ({
  entityId: snapshot.entityId,
  signerId: snapshot.signerId,
  state: snapshot.state,
  mempool: [],
  isProposer: snapshot.isProposer,
  ...(snapshot.certifiedFrameHead ? { certifiedFrameHead: snapshot.certifiedFrameHead } : {}),
  ...(snapshot.leaderVotes ? { leaderVotes: snapshot.leaderVotes } : {}),
  ...(snapshot.pendingLeaderCertificate
    ? { pendingLeaderCertificate: snapshot.pendingLeaderCertificate }
    : {}),
  ...(snapshot.lastConsensusProgressAt !== undefined
    ? { lastConsensusProgressAt: snapshot.lastConsensusProgressAt }
    : {}),
  ...(snapshot.jHistory ? { jHistory: snapshot.jHistory } : {}),
  ...(snapshot.jPrefixRound ? { jPrefixRound: snapshot.jPrefixRound } : {}),
  ...(snapshot.jSubmitState ? { jSubmitState: snapshot.jSubmitState } : {}),
  ...(snapshot.entityProviderActionSubmitState
    ? { entityProviderActionSubmitState: snapshot.entityProviderActionSubmitState }
    : {}),
  ...(snapshot.htlcNotes ? { htlcNotes: snapshot.htlcNotes } : {}),
  ...(snapshot.position ? { position: snapshot.position } : {}),
  ...(snapshot.hankoWitness ? { hankoWitness: snapshot.hankoWitness } : {}),
});

export const buildCanonicalJReplicaSnapshot = (jr: JReplica): JReplica => ({
  name: jr.name,
  // Storage can reconstruct jurisdiction identity before its external adapter
  // is attached. Canonical snapshots must still be complete JReplica values;
  // zero means no local tip has been observed yet, not an invented chain tip.
  blockNumber: normalizeJBlockNumber(jr.blockNumber),
  stateRoot: normalizeJStateRoot(jr.stateRoot, { rpcBacked: Boolean(jr.rpcs?.length) }),
  mempool: (() => {
    if (!Array.isArray(jr.mempool)) throw new Error('RUNTIME_MACHINE_J_MEMPOOL_INVALID');
    return jr.mempool;
  })(),
  blockDelayMs: requireNonNegativeNumber(jr.blockDelayMs, 'BLOCK_DELAY'),
  ...(jr.blockTimeMs !== undefined ? { blockTimeMs: jr.blockTimeMs } : {}),
  lastBlockTimestamp: requireNonNegativeNumber(jr.lastBlockTimestamp, 'LAST_BLOCK_TIMESTAMP'),
  ...(jr.blockReady !== undefined ? { blockReady: jr.blockReady } : {}),
  ...(jr.watcherConfirmationDepth !== undefined
    ? { watcherConfirmationDepth: jr.watcherConfirmationDepth }
    : {}),
  ...(jr.rpcs ? { rpcs: [...jr.rpcs] } : {}),
  ...(jr.chainId !== undefined ? { chainId: jr.chainId } : {}),
  position: requireFinitePosition(jr.position),
  ...(jr.entityProviderDeploymentBlock !== undefined
    ? { entityProviderDeploymentBlock: jr.entityProviderDeploymentBlock }
    : {}),
  ...(jr.contracts
    ? {
        contracts: {
          ...(jr.contracts.depository ? { depository: jr.contracts.depository } : {}),
          ...(jr.contracts.entityProvider ? { entityProvider: jr.contracts.entityProvider } : {}),
          ...(jr.contracts.account ? { account: jr.contracts.account } : {}),
          ...(jr.contracts.deltaTransformer ? { deltaTransformer: jr.contracts.deltaTransformer } : {}),
        },
      }
    : {}),
});

const buildDurableJReplicaSnapshot = (jr: JReplica): JReplica => ({
  ...buildCanonicalJReplicaSnapshot(jr),
  // Submission/watcher infrastructure updates this wall-clock marker after
  // the authoritative R-frame is committed. Input-only WAL replay therefore
  // cannot reproduce it, and no reducer may treat it as consensus state.
  lastBlockTimestamp: 0,
});

const projectRuntimeInput = (runtimeInput?: RuntimeInput): RuntimeInput =>
  runtimeInput ?? { runtimeTxs: [], entityInputs: [] };

const projectRuntimeOutputs = (runtimeOutputs: RoutedEntityInput[]): RoutedEntityInput[] =>
  runtimeOutputs;

const hasDurableEntries = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
};

const DURABLE_RUNTIME_STATE_KEYS = [
  'maxEntityInputsPerFrame',
  'maxEntityTxsPerFrame',
  'pendingHistoryRecords',
  'runtimeAdapterCommandFrontiers',
  'pendingCommittedJOutbox',
  'pendingJurisdictionImports',
  'numberedRegistrationIntents',
  'certifiedRegistrationEvidence',
  'entityEncryptionSeeds',
] as const;

const buildDurableRuntimeStateSnapshot = (
  env: RuntimeReplica,
  options?: {
    includeCertifiedBoardNodes?: boolean;
    excludePersistedHistoryRecords?: boolean;
  },
): Record<string, unknown> | undefined => {
  const state = env.infrastructure;
  if (!state) return undefined;
  const durable = {
    ...(state.maxEntityInputsPerFrame !== undefined ? { maxEntityInputsPerFrame: state.maxEntityInputsPerFrame } : {}),
    ...(state.maxEntityTxsPerFrame !== undefined ? { maxEntityTxsPerFrame: state.maxEntityTxsPerFrame } : {}),
    ...(!options?.excludePersistedHistoryRecords && hasDurableEntries(state.pendingHistoryRecords)
      ? { pendingHistoryRecords: state.pendingHistoryRecords }
      : {}),
    ...(hasDurableEntries(state.runtimeAdapterCommandFrontiers)
      ? { runtimeAdapterCommandFrontiers: state.runtimeAdapterCommandFrontiers }
      : {}),
    ...(hasDurableEntries(state.pendingCommittedJOutbox) ? { pendingCommittedJOutbox: state.pendingCommittedJOutbox } : {}),
    ...(hasDurableEntries(state.pendingJurisdictionImports)
      ? { pendingJurisdictionImports: state.pendingJurisdictionImports }
      : {}),
    ...(hasDurableEntries(state.numberedRegistrationIntents)
      ? { numberedRegistrationIntents: state.numberedRegistrationIntents }
      : {}),
    ...(hasDurableEntries(state.certifiedRegistrationEvidence)
      ? { certifiedRegistrationEvidence: state.certifiedRegistrationEvidence }
      : {}),
    ...(hasDurableEntries(state.entityEncryptionSeeds)
      ? { entityEncryptionSeeds: state.entityEncryptionSeeds }
      : {}),
    ...(options?.includeCertifiedBoardNodes
      ? {
          certifiedBoardNodes: collectReachableCertifiedBoardNodes(
            getCertifiedBoardNodeStore(env),
            [...env.state.eReplicas.values()]
              .map((replica) => replica.state.certifiedBoardState?.boardRegistryRoot)
              .filter((root): root is string => Boolean(root)),
          ),
          accountJClaimNodes: collectReachableAccountJClaimNodes(
            getAccountJClaimNodeStore(env),
            getLiveAccountJClaimAccumulatorStates(env),
          ),
        }
      : {}),
  };
  return Object.keys(durable).length > 0 ? durable : undefined;
};

export const buildDurableRuntimeMachineSnapshot = (
  env: RuntimeReplica,
  options?: {
    // WAL still passes this empty override. RAM queue bodies never enter durable snapshots.
    pendingNetworkOutputs?: RoutedEntityInput[];
    excludePersistedHistoryRecords?: boolean;
  },
): Record<string, unknown> => {
  const browserVMState = env.browserVMState;
  const runtimeConfig = env.runtimeConfig;
  const infrastructure = buildDurableRuntimeStateSnapshot(env, {
    excludePersistedHistoryRecords: options?.excludePersistedHistoryRecords === true,
  });
  return {
    ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
    ...(env.activeJurisdiction ? { activeJurisdiction: env.activeJurisdiction } : {}),
    ...(browserVMState ? { browserVMState } : {}),
    ...(runtimeConfig ? { runtimeConfig } : {}),
    ...(infrastructure ? { infrastructure } : {}),
    jReplicas: Array.from(requireRuntimeJReplicas(env).entries()).map(([key, replica]) => [
      key,
      buildDurableJReplicaSnapshot(replica),
    ]),
  };
};

/**
 * WAL Runtime-machine projection. Transport queues stay in RAM; the committed
 * flat outbox is RuntimeFrame.runtimeOutputs + runtimeOutputsDigest.
 */
export const buildStorageRuntimeMachineSnapshot = (
  env: RuntimeReplica,
  options?: { excludePersistedHistoryRecords?: boolean },
): Record<string, unknown> => buildDurableRuntimeMachineSnapshot(env, options);

/**
 * Project the part of a durable Runtime snapshot that deterministic frame
 * replay can reproduce. Runtime config is local operator policy (loop timing,
 * storage retention, checkpoint cadence). activeJurisdiction selects the local
 * J-adapter and the hub bootstrap temporarily changes it while creating sibling
 * entities. Neither value is a Runtime input, so either may change between
 * frames without a replayable transition and cannot be a reducer post-state
 * oracle. Full checkpoints still preserve both for process restoration.
 */
export const projectReplayVerifiableRuntimeMachine = (
  snapshot: Record<string, unknown>,
): Record<string, unknown> => {
  const replayVerifiable = { ...snapshot };
  delete replayVerifiable['runtimeConfig'];
  delete replayVerifiable['activeJurisdiction'];
  return replayVerifiable;
};

export const buildReplayVerifiableRuntimeMachineSnapshot = (
  env: RuntimeReplica,
  options?: {
    pendingNetworkOutputs?: RoutedEntityInput[];
    excludePersistedHistoryRecords?: boolean;
  },
): Record<string, unknown> => projectReplayVerifiableRuntimeMachine(
  buildDurableRuntimeMachineSnapshot(env, options),
);

/**
 * Per-frame Runtime integrity view. The BrowserVM trie is intentionally absent:
 * its canonical stateRoot already commits that graph, so serializing every trie
 * node again would turn each Runtime frame into O(chain state). The remaining
 * fields are split into independently hashed components by storage/hashes.ts;
 * unbounded components can therefore migrate to Patricia roots without changing
 * the parent Runtime-root shape.
 */
const projectBrowserVmPostState = (
  state: NonNullable<RuntimeReplica['browserVMState']>,
): Omit<NonNullable<RuntimeReplica['browserVMState']>, 'trieData'> => {
  const { trieData: _committedByStateRoot, ...header } = state;
  return header;
};

export const buildReplayVerifiableRuntimePostStateView = (
  env: RuntimeReplica,
  options?: {
    pendingNetworkOutputs?: RoutedEntityInput[];
    excludePersistedHistoryRecords?: boolean;
  },
): Record<string, unknown> => {
  const infrastructure = buildDurableRuntimeStateSnapshot(env, {
    excludePersistedHistoryRecords: options?.excludePersistedHistoryRecords === true,
  });
  return {
    ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
    ...(env.browserVMState
      ? { browserVMState: projectBrowserVmPostState(env.browserVMState) }
      : {}),
    ...(infrastructure ? { infrastructure } : {}),
    jReplicas: Array.from(requireRuntimeJReplicas(env).entries()).map(([key, replica]) => [
      key,
      buildDurableJReplicaSnapshot(replica),
    ]),
  };
};

export const projectReplayVerifiableRuntimePostStateView = (
  snapshot: Record<string, unknown>,
): Record<string, unknown> => {
  const projected = projectReplayVerifiableRuntimeMachine(snapshot);
  const browserVMState = projected['browserVMState'];
  if (browserVMState && typeof browserVMState === 'object' && !Array.isArray(browserVMState)) {
    const { trieData: _committedByStateRoot, ...header } = browserVMState as Record<string, unknown>;
    projected['browserVMState'] = header;
  }
  return projected;
};

const projectProfiles = (profiles: Profile[] | undefined): Profile[] | undefined => {
  if (!profiles || profiles.length === 0) return undefined;
  return profiles;
};

const projectLogs = (logs: readonly FrameLogEntry[] | undefined): FrameLogEntry[] | undefined => {
  if (!Array.isArray(logs) || logs.length === 0) return undefined;
  return logs.map(entry => ({ ...entry }));
};

const requireRuntimeJReplicas = (env: RuntimeReplica): RuntimeReplica['state']['jReplicas'] => {
  if (!(env.state.jReplicas instanceof Map)) {
    throw new Error('RUNTIME_SNAPSHOT_J_REPLICAS_MISSING');
  }
  return env.state.jReplicas;
};

export const buildCanonicalRuntimeStateSnapshot = (
  env: RuntimeReplica,
  options?: {
    browserVMState?: RuntimeReplica['browserVMState'];
    includeCertifiedBoardNodes?: boolean;
    portableCollections?: boolean;
  },
): Record<string, unknown> => {
  const infrastructure = buildDurableRuntimeStateSnapshot(env, {
    includeCertifiedBoardNodes: options?.includeCertifiedBoardNodes === true,
  });
  const browserVMState = options?.browserVMState ?? env.browserVMState;
  const runtimeConfig = env.runtimeConfig;
  return {
    height: env.state.height,
    timestamp: env.state.timestamp,
    ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
    ...(env.activeJurisdiction ? { activeJurisdiction: env.activeJurisdiction } : {}),
    ...(browserVMState ? { browserVMState } : {}),
    ...(runtimeConfig ? { runtimeConfig } : {}),
    ...(infrastructure ? { infrastructure } : {}),
    eReplicas: Array.from(env.state.eReplicas.entries()).map(([replicaKey, replica]) => {
      const snapshot = buildCanonicalEntityReplicaSnapshot(replica);
      return [
        replicaKey,
        options?.portableCollections
          ? { ...snapshot, state: projectPortableEntityState(replica.state) }
          : snapshot,
      ];
    }),
    jReplicas: Array.from(requireRuntimeJReplicas(env).entries()).map(([replicaKey, jr]) => [
      replicaKey,
      buildCanonicalJReplicaSnapshot(jr),
    ]),
  };
};

export const buildRuntimeCheckpointSnapshot = (env: RuntimeReplica): Record<string, unknown> => {
  return buildCanonicalRuntimeStateSnapshot(env, { includeCertifiedBoardNodes: true });
};

export const buildRuntimeRecoveryCheckpointSnapshot = (env: RuntimeReplica): Record<string, unknown> => {
  const snapshot = buildCanonicalRuntimeStateSnapshot(env, {
    includeCertifiedBoardNodes: true,
    portableCollections: true,
  });
  const gossipProfiles = projectProfiles(env.gossip?.getProfiles?.());
  return {
    ...snapshot,
    ...(gossipProfiles ? { gossip: { profiles: gossipProfiles } } : {}),
  };
};

export const restoreDurableRuntimeSnapshot = (
  env: RuntimeReplica,
  snapshot: Record<string, unknown>,
): void => {
  if (env.infrastructure?.processingPromise) {
    throw new Error('RUNTIME_SNAPSHOT_RESTORE_DURING_ACTIVE_FRAME');
  }
  if (typeof snapshot['runtimeId'] === 'string') env.runtimeId = snapshot['runtimeId'];
  if (typeof snapshot['activeJurisdiction'] === 'string') env.activeJurisdiction = snapshot['activeJurisdiction'];
  if (snapshot['browserVMState']) {
    env.browserVMState = snapshot['browserVMState'] as NonNullable<RuntimeReplica['browserVMState']>;
  }
  // Runtime mempool is replica-envelope ephemeral state: a restored process
  // starts with an empty input queue and peers resend unframed work.
  env.runtimeMempool = { runtimeTxs: [], entityInputs: [] };
  if (snapshot['runtimeConfig'] && typeof snapshot['runtimeConfig'] === 'object') {
    env.runtimeConfig = decodeRuntimeConfig(
      snapshot['runtimeConfig'],
      'RUNTIME_SNAPSHOT_RUNTIME_CONFIG',
    );
  }
  const retainedRuntimeState = { ...(env.infrastructure ?? {}) };
  for (const key of DURABLE_RUNTIME_STATE_KEYS) delete retainedRuntimeState[key];
  const restoredRuntimeState = snapshot['infrastructure'] && typeof snapshot['infrastructure'] === 'object'
    ? snapshot['infrastructure'] as NonNullable<RuntimeReplica['infrastructure']>
    : {};
  env.infrastructure = { ...retainedRuntimeState, ...restoredRuntimeState };
  // Transport queues are replica-envelope RAM. Recovery republishes the
  // committed flat outbox from RuntimeFrame.runtimeOutputs separately.
  env.pendingOutputs = [];
  env.networkInbox = [];
  env.pendingNetworkOutputs = [];
  if (Array.isArray(snapshot['jReplicas'])) {
    env.state.jReplicas = new Map(snapshot['jReplicas'].map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
        throw new Error('RUNTIME_MACHINE_J_REPLICA_ENTRY_INVALID');
      }
      return [entry[0], entry[1] as JReplica];
    }));
  }
};

export const buildCanonicalEnvSnapshot = (
  env: RuntimeReplica,
  options: {
    runtimeInput: RuntimeInput;
    runtimeOutputs: RoutedEntityInput[];
    description: string;
    meta?: EnvSnapshot['meta'];
    browserVMState?: RuntimeReplica['browserVMState'];
    gossipProfiles?: Profile[];
    logs?: readonly FrameLogEntry[];
  },
): EnvSnapshot => {
  const core = buildCanonicalRuntimeStateSnapshot(env, { browserVMState: options.browserVMState }) as {
    height: number;
    timestamp: number;
    runtimeId?: string;
    browserVMState?: RuntimeReplica['browserVMState'];
    eReplicas: Array<[string, PersistedEntityReplicaSnapshot]>;
    jReplicas: Array<[string, JReplica]>;
  };

  const logs = projectLogs(options.logs);
  // Decode the flat Runtime-owned replica directory explicitly. Entity and
  // Account graphs remain shared persistent values; this does not clone them.
  const eReplicas = new Map<string, EntityReplica>();
  for (const [replicaKey, replica] of core.eReplicas) {
    eReplicas.set(replicaKey, hydratePersistedEntityReplicaSnapshot(replica));
  }
  const jReplicas = new Map<string, JReplica>();
  for (const [replicaKey, replica] of core.jReplicas) jReplicas.set(replicaKey, replica);
  // EnvSnapshot is a detached history value, never a live BrowserVM view.
  // Reuse the boundary decoder: it validates and path-copies the trie/receipt
  // arrays once, preventing later VM writes from mutating recorded history.
  const browserVMState = core.browserVMState
    ? decodeBrowserVmSerializedState(core.browserVMState)
    : undefined;
  return {
    state: {
      height: core.height,
      timestamp: core.timestamp,
      eReplicas,
      jReplicas,
    },
    ...(core.runtimeId ? { runtimeId: core.runtimeId } : {}),
    ...(browserVMState ? { browserVMState } : {}),
    runtimeInput: projectRuntimeInput(options.runtimeInput),
    runtimeOutputs: projectRuntimeOutputs(options.runtimeOutputs),
    description: options.description,
    ...(projectProfiles(options.gossipProfiles)
      ? { gossip: { profiles: projectProfiles(options.gossipProfiles)! } }
      : {}),
    ...(options.meta
      ? {
          meta: {
            ...(options.meta.title ? { title: options.meta.title } : {}),
            ...(options.meta.subtitle ? { subtitle: options.meta.subtitle } : {}),
          },
        }
      : {}),
    ...(logs ? { logs } : {}),
  };
};

export const normalizePersistedSnapshotInPlace = (
  snapshot: Record<string, unknown> | null | undefined,
  deps: {
    normalizeReplicaMap: (raw: unknown) => Map<string, unknown>;
    normalizeJReplicaMap: (raw: unknown) => Map<string, unknown>;
  },
): void => {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (snapshot['eReplicas']) {
    snapshot['eReplicas'] = deps.normalizeReplicaMap(snapshot['eReplicas']);
  }
  if (snapshot['jReplicas']) {
    const jMap = deps.normalizeJReplicaMap(snapshot['jReplicas']);
    snapshot['jReplicas'] = new Map(
      Array.from(jMap.entries()).map(([name, raw]) => {
        const jr = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        const rpcs = Array.isArray(jr['rpcs']) ? jr['rpcs'] : [];
        const normalizedStateRoot = normalizeJStateRoot(jr['stateRoot'], { rpcBacked: rpcs.length > 0 });
        return [
          String(name),
          {
            ...jr,
            stateRoot: normalizedStateRoot,
          },
        ];
      }),
    );
  }
};
