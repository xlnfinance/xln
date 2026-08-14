/**
 * Projects live Runtime/Entity/Jurisdiction replicas into durable recovery snapshots.
 * Key builders: canonical checkpoints that exclude proposals, handles, and transport state.
 * Human-audit importance: 99/100 — projection coverage defines recoverable authority.
 */
import type { EntityReplica } from '../../entity/types';
import type { RuntimeReplica, EnvSnapshot, RoutedEntityInput, RuntimeInput } from '../../runtime/types';
import type { JReplica } from '../../types/jurisdiction-runtime';
import type { Profile } from '../../entity/profile';
import { cloneEntityReplica } from '../../entity/replica/replica-clone';
import { markRestoredJSubmitRuntimeTxs } from '../../runtime/jurisdiction/j-submit-state';
import { markRestoredJAuthorityRuntimeTxs } from '../../jurisdiction/machine/registration-evidence';
import { markRestoredJImportResultRuntimeTxs } from '../../runtime/jurisdiction/jurisdiction-import';
import { markRestoredEntityProviderActionRuntimeTxs } from '../../runtime/registration/entity-provider-action-submit-auth';
import { markRestoredGovernanceResultRuntimeTxs } from '../../runtime/registration/governance-submit-state';
import { markRestoredNumberedRegistrationTxs } from '../../runtime/registration/numbered-registration-auth';
import { markRestoredRuntimeAdapterCommandTxs } from '../../runtime/command/frontier-auth';
import {
  collectReachableCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
} from '../../jurisdiction/machine/board-registry';
import {
  collectReachableConsumptionNodes,
  getConsumptionNodeStore,
  getLiveConsumptionAccumulatorStates,
} from '../../entity/consumption/consumption-store';
import {
  collectReachableAccountJClaimNodes,
} from '../../account/j-claims/j-claim-accumulator';
import {
  getAccountJClaimNodeStore,
  getLiveAccountJClaimAccumulatorStates,
} from '../../entity/account/account-j-claim-node-store';
import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
} from '../../runtime/input-pipeline/input-clone';
import { assertRuntimeInputCapabilitiesAuthorized } from '../../runtime/transactions/internal-tx-auth';
import { decodeRuntimeConfig } from './runtime-machine-schema';

export const authorizeRestoredRuntimeInput = (runtimeInput: RuntimeInput): RuntimeInput => {
  markRestoredJSubmitRuntimeTxs(runtimeInput.runtimeTxs);
  markRestoredJAuthorityRuntimeTxs(runtimeInput.runtimeTxs);
  markRestoredJImportResultRuntimeTxs(runtimeInput.runtimeTxs);
  markRestoredEntityProviderActionRuntimeTxs(runtimeInput.runtimeTxs);
  markRestoredGovernanceResultRuntimeTxs(runtimeInput.runtimeTxs);
  markRestoredNumberedRegistrationTxs(runtimeInput.runtimeTxs);
  markRestoredRuntimeAdapterCommandTxs(runtimeInput.runtimeTxs);
  return runtimeInput;
};

const cloneHankoWitness = (
  hankoWitness?: EntityReplica['hankoWitness'],
): EntityReplica['hankoWitness'] | undefined => {
  if (!(hankoWitness instanceof Map) || hankoWitness.size === 0) return undefined;
  return new Map(
    Array.from(hankoWitness.entries()).map(([hash, entry]) => [
      hash,
      {
        hanko: entry.hanko,
        type: entry.type,
        entityHeight: entry.entityHeight,
        createdAt: entry.createdAt,
      },
    ]),
  );
};

const isZeroBytes32 = (value: Uint8Array): boolean =>
  value.length === 32 && value.every(byte => byte === 0);

const cloneJStateRoot = (
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

export const buildCanonicalEntityReplicaSnapshot = (
  replica: EntityReplica,
  options?: { compactTransient?: boolean },
): EntityReplica => {
  const snapshot = cloneEntityReplica(replica, true);
  const hankoWitness = cloneHankoWitness(replica.hankoWitness);
  if (options?.compactTransient) {
    snapshot.mempool = [];
    delete snapshot.proposal;
    delete snapshot.lockedFrame;
    delete snapshot.candidate;
  }
  return {
    ...snapshot,
    ...(hankoWitness ? { hankoWitness } : {}),
  };
};

export const buildCanonicalJReplicaSnapshot = (jr: JReplica): JReplica => ({
  name: jr.name,
  // Storage can reconstruct jurisdiction identity before its external adapter
  // is attached. Canonical snapshots must still be complete JReplica values;
  // zero means no local tip has been observed yet, not an invented chain tip.
  blockNumber: normalizeJBlockNumber(jr.blockNumber),
  stateRoot: cloneJStateRoot(jr.stateRoot, { rpcBacked: Boolean(jr.rpcs?.length) }),
  mempool: (() => {
    if (!Array.isArray(jr.mempool)) throw new Error('RUNTIME_MACHINE_J_MEMPOOL_INVALID');
    return structuredClone(jr.mempool);
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

/**
 * Scheduled wakes are derived from durable Entity crontab state. Persisting
 * one in the Runtime mempool would turn a process-local authorization marker
 * into unauthenticated bytes after reload, and could also replay an obsolete
 * wake. Persist only the non-derived work; recovery regenerates due wakes.
 */
const cloneDurableRuntimeMempool = (runtimeInput?: RuntimeInput): RuntimeInput => {
  const cloned = cloneIsolatedRuntimeInput(runtimeInput ?? { runtimeTxs: [], entityInputs: [] });
  const { jInputs, reliableReceipts, queuedAt, timestamp, ...requiredInput } = cloned;
  const entityInputs = cloned.entityInputs.flatMap(input => {
    const originallyEmptyTrigger = Array.isArray(input.entityTxs) && input.entityTxs.length === 0;
    const durableInput = {
      ...input,
      entityTxs: (input.entityTxs ?? []).filter(tx => tx.type !== 'scheduledWake'),
    };
    const keep =
      originallyEmptyTrigger ||
      durableInput.entityTxs.length > 0 ||
      durableInput.proposedFrame !== undefined ||
      (durableInput.hashPrecommits?.size ?? 0) > 0 ||
      (durableInput.jPrefixAttestations?.size ?? 0) > 0;
    return keep ? [durableInput] : [];
  });
  const hasWork =
    requiredInput.runtimeTxs.length > 0 ||
    entityInputs.length > 0 ||
    (jInputs?.length ?? 0) > 0 ||
    (reliableReceipts?.length ?? 0) > 0;
  return {
    ...requiredInput,
    entityInputs,
    ...(jInputs && jInputs.length > 0 ? { jInputs } : {}),
    ...(reliableReceipts && reliableReceipts.length > 0 ? { reliableReceipts } : {}),
    ...(hasWork && timestamp !== undefined ? { timestamp } : {}),
    ...(hasWork && queuedAt !== undefined ? { queuedAt } : {}),
  };
};

export const buildDurableRuntimeMempool = (runtimeInput?: RuntimeInput): RuntimeInput => {
  const source = runtimeInput ?? { runtimeTxs: [], entityInputs: [] };
  assertRuntimeInputCapabilitiesAuthorized(source);
  return cloneDurableRuntimeMempool(source);
};

const cloneRuntimeInput = (runtimeInput?: RuntimeInput): RuntimeInput =>
  cloneIsolatedRuntimeInput(runtimeInput ?? { runtimeTxs: [], entityInputs: [] });

const cloneRuntimeOutputs = (runtimeOutputs: RoutedEntityInput[]): RoutedEntityInput[] =>
  cloneIsolatedRoutedEntityInputs(runtimeOutputs);

const hasDurableEntries = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
};

const DURABLE_RUNTIME_STATE_KEYS = [
  'maxEntityInputsPerFrame',
  'maxEntityTxsPerFrame',
  'pendingHistoryRecords',
  'deferredNetworkMeta',
  'reliableIngressReceiptLedger',
  'reliableIngressTerminalWatermarks',
  'receivedReliableReceiptLedger',
  'receivedReliableTerminalWatermarks',
  'pendingReliableIngress',
  'reliableIngressCommitting',
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
    includeIngressWorkingState?: boolean;
    excludePersistedHistoryRecords?: boolean;
  },
): Record<string, unknown> | undefined => {
  const state = env.infrastructure;
  if (!state) return undefined;
  const durable = {
    ...(state.maxEntityInputsPerFrame !== undefined ? { maxEntityInputsPerFrame: state.maxEntityInputsPerFrame } : {}),
    ...(state.maxEntityTxsPerFrame !== undefined ? { maxEntityTxsPerFrame: state.maxEntityTxsPerFrame } : {}),
    ...(!options?.excludePersistedHistoryRecords && hasDurableEntries(state.pendingHistoryRecords)
      ? { pendingHistoryRecords: structuredClone(state.pendingHistoryRecords) }
      : {}),
    ...(hasDurableEntries(state.deferredNetworkMeta) ? { deferredNetworkMeta: structuredClone(state.deferredNetworkMeta) } : {}),
    ...(hasDurableEntries(state.reliableIngressReceiptLedger)
      ? { reliableIngressReceiptLedger: structuredClone(state.reliableIngressReceiptLedger) }
      : {}),
    ...(hasDurableEntries(state.reliableIngressTerminalWatermarks)
      ? { reliableIngressTerminalWatermarks: structuredClone(state.reliableIngressTerminalWatermarks) }
      : {}),
    ...(hasDurableEntries(state.receivedReliableReceiptLedger)
      ? { receivedReliableReceiptLedger: structuredClone(state.receivedReliableReceiptLedger) }
      : {}),
    ...(hasDurableEntries(state.receivedReliableTerminalWatermarks)
      ? { receivedReliableTerminalWatermarks: structuredClone(state.receivedReliableTerminalWatermarks) }
      : {}),
    ...(options?.includeIngressWorkingState
      ? {
          pendingReliableIngress: structuredClone(state.pendingReliableIngress ?? new Map()),
          reliableIngressCommitting: structuredClone(state.reliableIngressCommitting ?? new Set()),
        }
      : {}),
    ...(hasDurableEntries(state.runtimeAdapterCommandFrontiers)
      ? { runtimeAdapterCommandFrontiers: structuredClone(state.runtimeAdapterCommandFrontiers) }
      : {}),
    ...(hasDurableEntries(state.pendingCommittedJOutbox) ? { pendingCommittedJOutbox: structuredClone(state.pendingCommittedJOutbox) } : {}),
    ...(hasDurableEntries(state.pendingJurisdictionImports)
      ? { pendingJurisdictionImports: structuredClone(state.pendingJurisdictionImports) }
      : {}),
    ...(hasDurableEntries(state.numberedRegistrationIntents)
      ? { numberedRegistrationIntents: structuredClone(state.numberedRegistrationIntents) }
      : {}),
    ...(hasDurableEntries(state.certifiedRegistrationEvidence)
      ? { certifiedRegistrationEvidence: structuredClone(state.certifiedRegistrationEvidence) }
      : {}),
    ...(hasDurableEntries(state.entityEncryptionSeeds)
      ? { entityEncryptionSeeds: structuredClone(state.entityEncryptionSeeds) }
      : {}),
    ...(options?.includeCertifiedBoardNodes
      ? {
          certifiedBoardNodes: collectReachableCertifiedBoardNodes(
            getCertifiedBoardNodeStore(env),
            [...env.state.eReplicas.values()]
              .map((replica) => replica.state.certifiedBoardState?.boardRegistryRoot)
              .filter((root): root is string => Boolean(root)),
          ),
          consumptionNodes: collectReachableConsumptionNodes(
            getConsumptionNodeStore(env),
            getLiveConsumptionAccumulatorStates(env),
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
    pendingNetworkOutputs?: RoutedEntityInput[];
    runtimeInput?: RuntimeInput;
    includeIngressWorkingState?: boolean;
    excludePersistedHistoryRecords?: boolean;
  },
): Record<string, unknown> => {
  const infrastructure = buildDurableRuntimeStateSnapshot(env, {
    includeIngressWorkingState: options?.includeIngressWorkingState === true,
    excludePersistedHistoryRecords: options?.excludePersistedHistoryRecords === true,
  });
  return {
    ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
    ...(env.activeJurisdiction ? { activeJurisdiction: env.activeJurisdiction } : {}),
    ...(env.browserVMState ? { browserVMState: structuredClone(env.browserVMState) } : {}),
    ...(env.runtimeConfig ? { runtimeConfig: structuredClone(env.runtimeConfig) } : {}),
    ...(infrastructure ? { infrastructure } : {}),
    runtimeInput: buildDurableRuntimeMempool(
      options?.runtimeInput ?? env.runtimeMempool,
    ),
    ...(env.pendingOutputs?.length ? { pendingOutputs: cloneRuntimeOutputs(env.pendingOutputs) } : {}),
    ...(env.networkInbox?.length ? { networkInbox: cloneRuntimeOutputs(env.networkInbox) } : {}),
    ...((options?.pendingNetworkOutputs ?? env.pendingNetworkOutputs)?.length
      ? { pendingNetworkOutputs: cloneRuntimeOutputs(options?.pendingNetworkOutputs ?? env.pendingNetworkOutputs ?? []) }
      : {}),
    jReplicas: Array.from(requireRuntimeJReplicas(env).entries()).map(([key, replica]) => [
      key,
      buildDurableJReplicaSnapshot(replica),
    ]),
  };
};

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
    runtimeInput?: RuntimeInput;
    includeIngressWorkingState?: boolean;
    excludePersistedHistoryRecords?: boolean;
  },
): Record<string, unknown> => projectReplayVerifiableRuntimeMachine(
  buildDurableRuntimeMachineSnapshot(env, options),
);

const cloneProfiles = (profiles: Profile[] | undefined): Profile[] | undefined => {
  if (!profiles || profiles.length === 0) return undefined;
  return profiles.map(profile => structuredClone(profile));
};

const cloneLogs = (logs: RuntimeReplica['frameLogs'] | undefined): RuntimeReplica['frameLogs'] | undefined => {
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
    compactTransient?: boolean;
    includeCertifiedBoardNodes?: boolean;
  },
): Record<string, unknown> => {
  const infrastructure = buildDurableRuntimeStateSnapshot(env, {
    includeCertifiedBoardNodes: options?.includeCertifiedBoardNodes === true,
  });
  const browserVMState = options?.browserVMState ?? env.browserVMState;
  return {
    height: env.state.height,
    timestamp: env.state.timestamp,
    ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
    ...(env.activeJurisdiction ? { activeJurisdiction: env.activeJurisdiction } : {}),
    ...(browserVMState
      ? { browserVMState: structuredClone(browserVMState) }
      : {}),
    ...(env.runtimeConfig ? { runtimeConfig: structuredClone(env.runtimeConfig) } : {}),
    ...(infrastructure ? { infrastructure } : {}),
    runtimeInput: buildDurableRuntimeMempool(env.runtimeMempool),
    ...(env.pendingOutputs ? { pendingOutputs: cloneRuntimeOutputs(env.pendingOutputs) } : {}),
    ...(env.networkInbox ? { networkInbox: cloneRuntimeOutputs(env.networkInbox) } : {}),
    ...(env.pendingNetworkOutputs ? { pendingNetworkOutputs: cloneRuntimeOutputs(env.pendingNetworkOutputs) } : {}),
    eReplicas: Array.from(env.state.eReplicas.entries()).map(([replicaKey, replica]) => [
      replicaKey,
      buildCanonicalEntityReplicaSnapshot(
        replica,
        options?.compactTransient ? { compactTransient: true } : undefined,
      ),
    ]),
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
  const snapshot = buildCanonicalRuntimeStateSnapshot(env, { includeCertifiedBoardNodes: true });
  const gossipProfiles = cloneProfiles(env.gossip?.getProfiles?.());
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
    env.browserVMState = structuredClone(snapshot['browserVMState']) as NonNullable<RuntimeReplica['browserVMState']>;
  }
  const runtimeInput = snapshot['runtimeInput'];
  if (runtimeInput && typeof runtimeInput === 'object') {
    env.runtimeMempool = cloneDurableRuntimeMempool(runtimeInput as RuntimeInput);
  }
  if (snapshot['runtimeConfig'] && typeof snapshot['runtimeConfig'] === 'object') {
    env.runtimeConfig = decodeRuntimeConfig(
      snapshot['runtimeConfig'],
      'RUNTIME_SNAPSHOT_RUNTIME_CONFIG',
    );
  }
  const retainedRuntimeState = { ...(env.infrastructure ?? {}) };
  for (const key of DURABLE_RUNTIME_STATE_KEYS) delete retainedRuntimeState[key];
  const restoredRuntimeState = snapshot['infrastructure'] && typeof snapshot['infrastructure'] === 'object'
    ? structuredClone(snapshot['infrastructure']) as NonNullable<RuntimeReplica['infrastructure']>
    : {};
  env.infrastructure = { ...retainedRuntimeState, ...restoredRuntimeState };
  env.pendingOutputs = Array.isArray(snapshot['pendingOutputs'])
    ? cloneIsolatedRoutedEntityInputs(snapshot['pendingOutputs'] as RoutedEntityInput[])
    : [];
  env.networkInbox = Array.isArray(snapshot['networkInbox'])
    ? cloneIsolatedRoutedEntityInputs(snapshot['networkInbox'] as RoutedEntityInput[])
    : [];
  env.pendingNetworkOutputs = Array.isArray(snapshot['pendingNetworkOutputs'])
    ? cloneIsolatedRoutedEntityInputs(snapshot['pendingNetworkOutputs'] as RoutedEntityInput[])
    : [];
  if (Array.isArray(snapshot['jReplicas'])) {
    env.state.jReplicas = new Map(snapshot['jReplicas'].map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
        throw new Error('RUNTIME_MACHINE_J_REPLICA_ENTRY_INVALID');
      }
      return [entry[0], structuredClone(entry[1]) as JReplica];
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
    logs?: RuntimeReplica['frameLogs'];
  },
): EnvSnapshot => {
  const core = buildCanonicalRuntimeStateSnapshot(env, { browserVMState: options.browserVMState }) as {
    height: number;
    timestamp: number;
    runtimeId?: string;
    browserVMState?: RuntimeReplica['browserVMState'];
    eReplicas: Array<[string, EntityReplica]>;
    jReplicas: Array<[string, JReplica]>;
  };

  const logs = cloneLogs(options.logs);
  return {
    state: {
      height: core.height,
      timestamp: core.timestamp,
      eReplicas: new Map(core.eReplicas),
      jReplicas: new Map(core.jReplicas),
    },
    ...(core.runtimeId ? { runtimeId: core.runtimeId } : {}),
    ...(core.browserVMState ? { browserVMState: core.browserVMState } : {}),
    runtimeInput: cloneRuntimeInput(options.runtimeInput),
    runtimeOutputs: cloneRuntimeOutputs(options.runtimeOutputs),
    description: options.description,
    ...(cloneProfiles(options.gossipProfiles) ? { gossip: { profiles: cloneProfiles(options.gossipProfiles)! } } : {}),
    ...(options.meta
      ? {
          meta: {
            ...(options.meta.title ? { title: options.meta.title } : {}),
            ...(options.meta.subtitle ? { subtitle: structuredClone(options.meta.subtitle) } : {}),
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
        const normalizedStateRoot = cloneJStateRoot(jr['stateRoot'], { rpcBacked: rpcs.length > 0 });
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
