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
  try {
    const blockNumber = BigInt(value as bigint | number | string);
    return blockNumber >= 0n ? blockNumber : 0n;
  } catch {
    return 0n;
  }
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
    delete snapshot.validatorComputedState;
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
  ...(jr.rpcs ? { rpcs: [...jr.rpcs] } : {}),
  ...(jr.chainId !== undefined ? { chainId: jr.chainId } : {}),
  position: {
    x: normalizeFiniteNumber(jr.position?.x, 0),
    y: normalizeFiniteNumber(jr.position?.y, 50),
    z: normalizeFiniteNumber(jr.position?.z, 0),
  },
  ...(jr.depositoryAddress ? { depositoryAddress: jr.depositoryAddress } : {}),
  ...(jr.entityProviderAddress ? { entityProviderAddress: jr.entityProviderAddress } : {}),
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

const cloneEntityInput = <T extends RoutedEntityInput>(input: T): T => ({
  ...input,
  ...(input.entityTxs ? { entityTxs: [...input.entityTxs] } : {}),
  ...(input.hashPrecommits
    ? { hashPrecommits: new Map(Array.from(input.hashPrecommits.entries()).map(([key, value]) => [key, [...value]])) }
    : {}),
}) as T;

const cloneRuntimeInput = (runtimeInput?: RuntimeInput): RuntimeInput => ({
  ...runtimeInput,
  runtimeTxs: [...(runtimeInput?.runtimeTxs ?? [])],
  entityInputs: (runtimeInput?.entityInputs ?? []).map(input => cloneEntityInput(input)),
  ...(runtimeInput?.jInputs
    ? { jInputs: runtimeInput.jInputs.map(input => ({ ...input, jTxs: [...input.jTxs] })) }
    : {}),
});

const cloneRuntimeOutputs = (runtimeOutputs: RoutedEntityInput[]): RoutedEntityInput[] =>
  runtimeOutputs.map(output => cloneEntityInput(output));

const buildDurableRuntimeStateSnapshot = (env: Env): Record<string, unknown> | undefined => {
  const state = env.runtimeState;
  if (!state) return undefined;
  const durable = {
    ...(state.halted !== undefined ? { halted: state.halted } : {}),
    ...(state.fatalDebugPayload ? { fatalDebugPayload: structuredClone(state.fatalDebugPayload) } : {}),
    ...(state.clockPrimed !== undefined ? { clockPrimed: state.clockPrimed } : {}),
    ...(state.maxEntityInputsPerFrame !== undefined ? { maxEntityInputsPerFrame: state.maxEntityInputsPerFrame } : {}),
    ...(state.maxEntityTxsPerFrame !== undefined ? { maxEntityTxsPerFrame: state.maxEntityTxsPerFrame } : {}),
    ...(state.pendingAuditEvents ? { pendingAuditEvents: structuredClone(state.pendingAuditEvents) } : {}),
    ...(state.quarantinedRuntimeInputs ? { quarantinedRuntimeInputs: structuredClone(state.quarantinedRuntimeInputs) } : {}),
    ...(state.pendingFrameDbRecords ? { pendingFrameDbRecords: structuredClone(state.pendingFrameDbRecords) } : {}),
    ...(state.deferredNetworkMeta ? { deferredNetworkMeta: structuredClone(state.deferredNetworkMeta) } : {}),
    ...(state.pendingCommittedJOutbox ? { pendingCommittedJOutbox: structuredClone(state.pendingCommittedJOutbox) } : {}),
  };
  return Object.keys(durable).length > 0 ? durable : undefined;
};

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
  },
): Record<string, unknown> => ({
  height: env.height,
  timestamp: env.timestamp,
  ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
  ...(env.dbNamespace ? { dbNamespace: env.dbNamespace } : {}),
  ...(env.activeJurisdiction ? { activeJurisdiction: env.activeJurisdiction } : {}),
  ...(options?.browserVMState ?? env.browserVMState ? { browserVMState: options?.browserVMState ?? env.browserVMState } : {}),
  ...(env.runtimeConfig ? { runtimeConfig: structuredClone(env.runtimeConfig) } : {}),
  ...(buildDurableRuntimeStateSnapshot(env) ? { runtimeState: buildDurableRuntimeStateSnapshot(env) } : {}),
  runtimeInput: cloneRuntimeInput(env.runtimeMempool ?? env.runtimeInput),
  ...(env.pendingOutputs ? { pendingOutputs: cloneRuntimeOutputs(env.pendingOutputs) } : {}),
  ...(env.networkInbox ? { networkInbox: cloneRuntimeOutputs(env.networkInbox) } : {}),
  ...(env.pendingNetworkOutputs ? { pendingNetworkOutputs: cloneRuntimeOutputs(env.pendingNetworkOutputs) } : {}),
  ...(env.lockRuntimeSeed !== undefined ? { lockRuntimeSeed: env.lockRuntimeSeed } : {}),
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
  return buildCanonicalRuntimeStateSnapshot(env);
};

export const buildRuntimeRecoveryCheckpointSnapshot = (env: Env): Record<string, unknown> => {
  const snapshot = buildCanonicalRuntimeStateSnapshot(env);
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
  const runtimeInput = snapshot['runtimeInput'];
  if (runtimeInput && typeof runtimeInput === 'object') {
    const restoredInput = structuredClone(runtimeInput) as RuntimeInput;
    env.runtimeInput = restoredInput;
    env.runtimeMempool = restoredInput;
  }
  if (snapshot['runtimeConfig'] && typeof snapshot['runtimeConfig'] === 'object') {
    env.runtimeConfig = structuredClone(snapshot['runtimeConfig']) as Env['runtimeConfig'];
  }
  if (snapshot['runtimeState'] && typeof snapshot['runtimeState'] === 'object') {
    env.runtimeState = {
      ...(env.runtimeState ?? {}),
      ...(structuredClone(snapshot['runtimeState']) as NonNullable<Env['runtimeState']>),
    };
  }
  env.pendingOutputs = Array.isArray(snapshot['pendingOutputs'])
    ? structuredClone(snapshot['pendingOutputs']) as RoutedEntityInput[]
    : [];
  env.networkInbox = Array.isArray(snapshot['networkInbox'])
    ? structuredClone(snapshot['networkInbox']) as RoutedEntityInput[]
    : [];
  env.pendingNetworkOutputs = Array.isArray(snapshot['pendingNetworkOutputs'])
    ? structuredClone(snapshot['pendingNetworkOutputs']) as RoutedEntityInput[]
    : [];
  if (typeof snapshot['lockRuntimeSeed'] === 'boolean') {
    env.lockRuntimeSeed = snapshot['lockRuntimeSeed'];
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
