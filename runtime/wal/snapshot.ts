import type {
  EntityReplica,
  Env,
  EnvSnapshot,
  JReplica,
  Profile,
  RoutedEntityInput,
  RuntimeInput,
} from '../types';
import { cloneEntityReplica } from '../state-helpers';
import { markRestoredJSubmitRuntimeTxs } from '../machine/j-submit-state';
import { markRestoredJAuthorityRuntimeTxs } from '../jurisdiction/registration-evidence';
import { markRestoredJImportResultRuntimeTxs } from '../machine/jurisdiction-import';
import { markRestoredEntityProviderActionRuntimeTxs } from '../machine/entity-provider-action-submit-auth';
import {
  collectReachableCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
} from '../jurisdiction/board-registry';
import {
  collectReachableConsumptionNodes,
  getConsumptionNodeStore,
  getLiveConsumptionAccumulatorStates,
} from '../entity/consumption-store';
import {
  collectReachableAccountJClaimNodes,
} from '../account/j-claim-accumulator';
import {
  getAccountJClaimNodeStore,
  getLiveAccountJClaimAccumulatorStates,
} from '../account/j-claim-store';
import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
} from '../protocol/runtime-input-clone';

export const authorizeRestoredRuntimeInput = (runtimeInput: RuntimeInput): RuntimeInput => {
  markRestoredJSubmitRuntimeTxs(runtimeInput.runtimeTxs);
  markRestoredJAuthorityRuntimeTxs(runtimeInput.runtimeTxs);
  markRestoredJImportResultRuntimeTxs(runtimeInput.runtimeTxs);
  markRestoredEntityProviderActionRuntimeTxs(runtimeInput.runtimeTxs);
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
  if (value === undefined || value === null || value === '') return 0n;
  let blockNumber: bigint;
  try {
    blockNumber = BigInt(value as bigint | number | string);
  } catch (error) {
    throw new Error(`RUNTIME_MACHINE_J_BLOCK_NUMBER_INVALID:${String(value)}`, { cause: error });
  }
  if (blockNumber < 0n) throw new Error(`RUNTIME_MACHINE_J_BLOCK_NUMBER_NEGATIVE:${blockNumber}`);
  return blockNumber;
};

const normalizeNonNegativeNumber = (value: unknown, fallback: number): number => {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : fallback;
};

const normalizeFiniteNumber = (value: unknown, fallback: number): number => {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
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
    delete snapshot.validatorExecution;
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
  mempool: Array.isArray(jr.mempool) ? structuredClone(jr.mempool) : [],
  blockDelayMs: normalizeNonNegativeNumber(jr.blockDelayMs, 300),
  ...(jr.blockTimeMs !== undefined ? { blockTimeMs: jr.blockTimeMs } : {}),
  lastBlockTimestamp: normalizeNonNegativeNumber(jr.lastBlockTimestamp, 0),
  ...(jr.blockReady !== undefined ? { blockReady: jr.blockReady } : {}),
  ...(jr.defaultDisputeDelayBlocks !== undefined ? { defaultDisputeDelayBlocks: jr.defaultDisputeDelayBlocks } : {}),
  ...(jr.watcherConfirmationDepth !== undefined
    ? { watcherConfirmationDepth: jr.watcherConfirmationDepth }
    : {}),
  ...(jr.rpcs ? { rpcs: [...jr.rpcs] } : {}),
  ...(jr.chainId !== undefined ? { chainId: jr.chainId } : {}),
  position: {
    x: normalizeFiniteNumber(jr.position?.x, 0),
    y: normalizeFiniteNumber(jr.position?.y, 50),
    z: normalizeFiniteNumber(jr.position?.z, 0),
  },
  ...(jr.depositoryAddress ? { depositoryAddress: jr.depositoryAddress } : {}),
  ...(jr.entityProviderAddress ? { entityProviderAddress: jr.entityProviderAddress } : {}),
  ...((jr.entityProviderDeploymentBlock ?? jr.jadapter?.entityProviderDeploymentBlock) !== undefined
    ? { entityProviderDeploymentBlock: jr.entityProviderDeploymentBlock ?? jr.jadapter!.entityProviderDeploymentBlock }
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

const withoutEphemeralScheduledWake = (runtimeInput?: RuntimeInput): RuntimeInput => {
  const cloned = cloneIsolatedRuntimeInput(runtimeInput ?? { runtimeTxs: [], entityInputs: [] });
  const { jInputs, reliableReceipts, ...requiredInput } = cloned;
  return {
    ...requiredInput,
    ...(jInputs && jInputs.length > 0 ? { jInputs } : {}),
    ...(reliableReceipts && reliableReceipts.length > 0 ? { reliableReceipts } : {}),
    entityInputs: cloned.entityInputs.flatMap(input => {
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
    }),
  };
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
  'halted',
  'fatalDebugPayload',
  'maxEntityInputsPerFrame',
  'maxEntityTxsPerFrame',
  'securityIncidents',
  'quarantinedRuntimeInputs',
  'pendingFrameDbRecords',
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
] as const;

const buildDurableRuntimeStateSnapshot = (
  env: Env,
  options?: {
    includeCertifiedBoardNodes?: boolean;
    includeIngressWorkingState?: boolean;
    excludePersistedFrameDbRecords?: boolean;
  },
): Record<string, unknown> | undefined => {
  const state = env.runtimeState;
  if (!state) return undefined;
  const durable = {
    ...(state.halted === true ? { halted: true } : {}),
    ...(state.fatalDebugPayload ? { fatalDebugPayload: structuredClone(state.fatalDebugPayload) } : {}),
    ...(state.maxEntityInputsPerFrame !== undefined ? { maxEntityInputsPerFrame: state.maxEntityInputsPerFrame } : {}),
    ...(state.maxEntityTxsPerFrame !== undefined ? { maxEntityTxsPerFrame: state.maxEntityTxsPerFrame } : {}),
    ...(hasDurableEntries(state.securityIncidents) ? { securityIncidents: structuredClone(state.securityIncidents) } : {}),
    ...(hasDurableEntries(state.quarantinedRuntimeInputs) ? { quarantinedRuntimeInputs: structuredClone(state.quarantinedRuntimeInputs) } : {}),
    ...(!options?.excludePersistedFrameDbRecords && hasDurableEntries(state.pendingFrameDbRecords)
      ? { pendingFrameDbRecords: structuredClone(state.pendingFrameDbRecords) }
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
    ...(options?.includeCertifiedBoardNodes
      ? {
          certifiedBoardNodes: collectReachableCertifiedBoardNodes(
            getCertifiedBoardNodeStore(env),
            [...env.eReplicas.values()]
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
  env: Env,
  options?: {
    pendingNetworkOutputs?: RoutedEntityInput[];
    includeIngressWorkingState?: boolean;
    excludePersistedFrameDbRecords?: boolean;
  },
): Record<string, unknown> => ({
  ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
  ...(env.activeJurisdiction ? { activeJurisdiction: env.activeJurisdiction } : {}),
  ...(env.browserVMState ? { browserVMState: structuredClone(env.browserVMState) } : {}),
  ...(env.runtimeConfig ? { runtimeConfig: structuredClone(env.runtimeConfig) } : {}),
  ...(buildDurableRuntimeStateSnapshot(env, {
    includeIngressWorkingState: options?.includeIngressWorkingState === true,
    excludePersistedFrameDbRecords: options?.excludePersistedFrameDbRecords === true,
  }) ? {
      runtimeState: buildDurableRuntimeStateSnapshot(env, {
        includeIngressWorkingState: options?.includeIngressWorkingState === true,
        excludePersistedFrameDbRecords: options?.excludePersistedFrameDbRecords === true,
      }),
    } : {}),
  runtimeInput: withoutEphemeralScheduledWake(env.runtimeMempool ?? env.runtimeInput),
  ...(env.pendingOutputs?.length ? { pendingOutputs: cloneRuntimeOutputs(env.pendingOutputs) } : {}),
  ...(env.networkInbox?.length ? { networkInbox: cloneRuntimeOutputs(env.networkInbox) } : {}),
  ...((options?.pendingNetworkOutputs ?? env.pendingNetworkOutputs)?.length
    ? { pendingNetworkOutputs: cloneRuntimeOutputs(options?.pendingNetworkOutputs ?? env.pendingNetworkOutputs ?? []) }
    : {}),
  jReplicas: Array.from((env.jReplicas || new Map()).entries()).map(([key, replica]) => [
    key,
    buildDurableJReplicaSnapshot(replica),
  ]),
});

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
  env: Env,
  options?: {
    pendingNetworkOutputs?: RoutedEntityInput[];
    includeIngressWorkingState?: boolean;
    excludePersistedFrameDbRecords?: boolean;
  },
): Record<string, unknown> => projectReplayVerifiableRuntimeMachine(
  buildDurableRuntimeMachineSnapshot(env, options),
);

const cloneProfiles = (profiles: Profile[] | undefined): Profile[] | undefined => {
  if (!profiles || profiles.length === 0) return undefined;
  return profiles.map(profile => structuredClone(profile));
};

const cloneLogs = (logs: Env['frameLogs'] | undefined): Env['frameLogs'] | undefined => {
  if (!Array.isArray(logs) || logs.length === 0) return undefined;
  return logs.map(entry => ({ ...entry }));
};

export const buildCanonicalRuntimeStateSnapshot = (
  env: Env,
  options?: {
    browserVMState?: Env['browserVMState'];
    compactTransient?: boolean;
    includeCertifiedBoardNodes?: boolean;
  },
): Record<string, unknown> => ({
  height: env.height,
  timestamp: env.timestamp,
  ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
  ...(env.activeJurisdiction ? { activeJurisdiction: env.activeJurisdiction } : {}),
  ...(options?.browserVMState ?? env.browserVMState ? { browserVMState: options?.browserVMState ?? env.browserVMState } : {}),
  ...(env.runtimeConfig ? { runtimeConfig: structuredClone(env.runtimeConfig) } : {}),
  ...(buildDurableRuntimeStateSnapshot(env, {
    includeCertifiedBoardNodes: options?.includeCertifiedBoardNodes === true,
  }) ? { runtimeState: buildDurableRuntimeStateSnapshot(env, {
    includeCertifiedBoardNodes: options?.includeCertifiedBoardNodes === true,
  }) } : {}),
  runtimeInput: withoutEphemeralScheduledWake(env.runtimeMempool ?? env.runtimeInput),
  ...(env.pendingOutputs ? { pendingOutputs: cloneRuntimeOutputs(env.pendingOutputs) } : {}),
  ...(env.networkInbox ? { networkInbox: cloneRuntimeOutputs(env.networkInbox) } : {}),
  ...(env.pendingNetworkOutputs ? { pendingNetworkOutputs: cloneRuntimeOutputs(env.pendingNetworkOutputs) } : {}),
  eReplicas: Array.from(env.eReplicas.entries()).map(([replicaKey, replica]) => [
    replicaKey,
    buildCanonicalEntityReplicaSnapshot(
      replica,
      options?.compactTransient ? { compactTransient: true } : undefined,
    ),
  ]),
  jReplicas: Array.from((env.jReplicas || new Map()).entries()).map(([replicaKey, jr]) => [
    replicaKey,
    buildCanonicalJReplicaSnapshot(jr),
  ]),
});

export const buildRuntimeCheckpointSnapshot = (env: Env): Record<string, unknown> => {
  return buildCanonicalRuntimeStateSnapshot(env, { includeCertifiedBoardNodes: true });
};

export const buildRuntimeRecoveryCheckpointSnapshot = (env: Env): Record<string, unknown> => {
  const snapshot = buildCanonicalRuntimeStateSnapshot(env, { includeCertifiedBoardNodes: true });
  const gossipProfiles = cloneProfiles(env.gossip?.getProfiles?.());
  return {
    ...snapshot,
    ...(gossipProfiles ? { gossip: { profiles: gossipProfiles } } : {}),
  };
};

export const restoreDurableRuntimeSnapshot = (
  env: Env,
  snapshot: Record<string, unknown>,
): void => {
  if (env.runtimeState?.runtimeFrameIngressBuffer) {
    throw new Error('RUNTIME_SNAPSHOT_RESTORE_DURING_ACTIVE_FRAME');
  }
  const snapshotRuntimeState = snapshot['runtimeState'];
  if (
    snapshotRuntimeState &&
    typeof snapshotRuntimeState === 'object' &&
    Object.prototype.hasOwnProperty.call(snapshotRuntimeState, 'runtimeFrameIngressBuffer')
  ) {
    throw new Error('RUNTIME_SNAPSHOT_EPHEMERAL_FRAME_INGRESS_FORBIDDEN');
  }
  if (typeof snapshot['runtimeId'] === 'string') env.runtimeId = snapshot['runtimeId'];
  if (typeof snapshot['activeJurisdiction'] === 'string') env.activeJurisdiction = snapshot['activeJurisdiction'];
  if (snapshot['browserVMState']) {
    env.browserVMState = structuredClone(snapshot['browserVMState']) as NonNullable<Env['browserVMState']>;
  }
  const runtimeInput = snapshot['runtimeInput'];
  if (runtimeInput && typeof runtimeInput === 'object') {
    const restoredInput = authorizeRestoredRuntimeInput(
      withoutEphemeralScheduledWake(runtimeInput as RuntimeInput),
    );
    env.runtimeInput = restoredInput;
    env.runtimeMempool = restoredInput;
  }
  if (snapshot['runtimeConfig'] && typeof snapshot['runtimeConfig'] === 'object') {
    env.runtimeConfig = structuredClone(snapshot['runtimeConfig']) as Env['runtimeConfig'];
  }
  const retainedRuntimeState = { ...(env.runtimeState ?? {}) };
  for (const key of DURABLE_RUNTIME_STATE_KEYS) delete retainedRuntimeState[key];
  const restoredRuntimeState = snapshot['runtimeState'] && typeof snapshot['runtimeState'] === 'object'
    ? structuredClone(snapshot['runtimeState']) as NonNullable<Env['runtimeState']>
    : {};
  env.runtimeState = { ...retainedRuntimeState, ...restoredRuntimeState };
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
    env.jReplicas = new Map(snapshot['jReplicas'].map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
        throw new Error('RUNTIME_MACHINE_J_REPLICA_ENTRY_INVALID');
      }
      return [entry[0], structuredClone(entry[1]) as JReplica];
    }));
  }
};

export const buildCanonicalEnvSnapshot = (
  env: Env,
  options: {
    runtimeInput: RuntimeInput;
    runtimeOutputs: RoutedEntityInput[];
    description: string;
    meta?: EnvSnapshot['meta'];
    browserVMState?: Env['browserVMState'];
    gossipProfiles?: Profile[];
    logs?: Env['frameLogs'];
  },
): EnvSnapshot => {
  const core = buildCanonicalRuntimeStateSnapshot(env, { browserVMState: options.browserVMState }) as {
    height: number;
    timestamp: number;
    runtimeId?: string;
    browserVMState?: Env['browserVMState'];
    eReplicas: Array<[string, EntityReplica]>;
    jReplicas: Array<[string, JReplica]>;
  };

  const logs = cloneLogs(options.logs);
  return {
    height: core.height,
    timestamp: core.timestamp,
    ...(core.runtimeId ? { runtimeId: core.runtimeId } : {}),
    eReplicas: new Map(core.eReplicas),
    jReplicas: new Map(core.jReplicas),
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
            ...(options.meta.displayMs !== undefined ? { displayMs: options.meta.displayMs } : {}),
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
