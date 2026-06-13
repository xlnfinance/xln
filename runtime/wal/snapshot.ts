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
  blockNumber: jr.blockNumber,
  stateRoot: cloneJStateRoot(jr.stateRoot, { rpcBacked: Boolean(jr.rpcs?.length) }),
  mempool: [],
  blockDelayMs: jr.blockDelayMs,
  lastBlockTimestamp: jr.lastBlockTimestamp,
  ...(jr.defaultDisputeDelayBlocks !== undefined ? { defaultDisputeDelayBlocks: jr.defaultDisputeDelayBlocks } : {}),
  ...(jr.blockReady !== undefined ? { blockReady: jr.blockReady } : {}),
  ...(jr.rpcs ? { rpcs: [...jr.rpcs] } : {}),
  ...(jr.chainId !== undefined ? { chainId: jr.chainId } : {}),
  position: { ...jr.position },
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

const cloneRuntimeInput = (runtimeInput: RuntimeInput): RuntimeInput => ({
  runtimeTxs: [...runtimeInput.runtimeTxs],
  entityInputs: runtimeInput.entityInputs.map(input => ({
    entityId: input.entityId,
    signerId: input.signerId,
    ...(input.entityTxs ? { entityTxs: [...input.entityTxs] } : {}),
    ...(input.hashPrecommits
      ? { hashPrecommits: new Map(Array.from(input.hashPrecommits.entries()).map(([key, value]) => [key, [...value]])) }
      : {}),
    ...(input.proposedFrame ? { proposedFrame: input.proposedFrame } : {}),
  })),
});

const cloneRuntimeOutputs = (runtimeOutputs: RoutedEntityInput[]): RoutedEntityInput[] =>
  runtimeOutputs.map(output => ({
    entityId: output.entityId,
    signerId: output.signerId,
    ...(output.entityTxs ? { entityTxs: [...output.entityTxs] } : {}),
    ...(output.hashPrecommits
      ? { hashPrecommits: new Map(Array.from(output.hashPrecommits.entries()).map(([key, value]) => [key, [...value]])) }
      : {}),
    ...(output.proposedFrame ? { proposedFrame: output.proposedFrame } : {}),
  }));

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
  ...(env.runtimeSeed !== undefined && env.runtimeSeed !== null ? { runtimeSeed: env.runtimeSeed } : {}),
  ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
  ...(env.dbNamespace ? { dbNamespace: env.dbNamespace } : {}),
  ...(env.activeJurisdiction ? { activeJurisdiction: env.activeJurisdiction } : {}),
  ...(options?.browserVMState ?? env.browserVMState ? { browserVMState: options?.browserVMState ?? env.browserVMState } : {}),
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
  return buildCanonicalRuntimeStateSnapshot(env, { compactTransient: true });
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
    runtimeSeed?: string;
    runtimeId?: string;
    browserVMState?: Env['browserVMState'];
    eReplicas: Array<[string, EntityReplica]>;
    jReplicas: Array<[string, JReplica]>;
  };

  const logs = cloneLogs(options.logs);
  return {
    height: core.height,
    timestamp: core.timestamp,
    ...(core.runtimeSeed !== undefined && core.runtimeSeed !== null ? { runtimeSeed: core.runtimeSeed } : {}),
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
