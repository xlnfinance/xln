import { deserializeTaggedJson } from '../serialization-utils';
import type { Env, FrameLogEntry, RuntimeInput } from '../types';
import { computePersistedEnvStateHash } from './hash';
import { buildRuntimeCheckpointSnapshot } from './snapshot';
import { readPersistedFrameJournalBuffer, type RuntimeWalDb } from './store';

export type ReplayStartSelection = {
  snapshotHeight: number;
  snapshotLabel: string;
  source: 'checkpoint' | 'override';
};

export const selectReplayStart = (
  checkpointHeight: number,
  fromSnapshotHeight?: number,
): ReplayStartSelection => {
  if (Number.isFinite(fromSnapshotHeight) && Number(fromSnapshotHeight) > 0) {
    const snapshotHeight = Math.floor(Number(fromSnapshotHeight));
    return {
      snapshotHeight,
      snapshotLabel: snapshotHeight === 1 ? 'genesis:1' : `snapshot:${snapshotHeight}`,
      source: 'override',
    };
  }
  return {
    snapshotHeight: checkpointHeight,
    snapshotLabel: `checkpoint:${checkpointHeight}`,
    source: 'checkpoint',
  };
};

type ReplayRuntimeStateRef = {
  db?: unknown;
  dbOpenPromise?: unknown;
};

export type ReplaySnapshotDeps = {
  normalizeSnapshotInPlace: (snapshot: unknown) => void;
  createEmptyEnv: (seed?: Uint8Array | string | null) => Env;
  deriveRuntimeIdFromSeed: (seed: string) => string;
  normalizeReplicaMap: (raw: unknown) => Map<string, unknown>;
  normalizeJReplicaMap: (raw: unknown) => Map<string, unknown>;
  assertPersistedContractConfigReady: (env: Env, label: string) => void;
  validateEntityState: (state: unknown, label: string) => void;
  rebuildEntitySwapBookFromAccounts: (env: Env) => void;
  rebuildEntityLockBookFromAccounts: (env: Env) => void;
  rebuildEntityOrderbookExtFromAccounts: (env: Env) => void;
  buildCanonicalEnvSnapshot: (
    env: Env,
    options: {
      runtimeInput: RuntimeInput;
      runtimeOutputs: unknown[];
      description: string;
      meta: Record<string, unknown>;
      logs: FrameLogEntry[] | undefined;
      gossipProfiles: unknown[];
    },
  ) => unknown;
  ensureRuntimeState: (env: Env) => ReplayRuntimeStateRef;
  applyRuntimeInput: (env: Env, input: RuntimeInput) => Promise<void>;
  normalizeEntitySwapTradingPairs: (state: unknown) => void;
  isDbNotFound: (error: unknown) => boolean;
  replayModeKey: symbol;
  applyAllowedKey: symbol;
};

export type ReplayFromSnapshotOptions = {
  db: RuntimeWalDb;
  dbNamespace: string;
  tempEnv: Env;
  latestHeight: number;
  checkpointHeight: number;
  selectedSnapshotHeight: number;
  selectedSnapshotLabel: string;
  snapshotBuffer: Buffer;
  deps: ReplaySnapshotDeps;
};

const isLegacyNoopFrame = (input: RuntimeInput | undefined): boolean => {
  if (!input) return false;
  const hasRuntimeTxs = (input.runtimeTxs?.length ?? 0) > 0;
  const hasJInputs = (input.jInputs?.length ?? 0) > 0;
  const hasMeaningfulEntityInputs = (input.entityInputs ?? []).some((entityInput) => {
    const hasEntityTxs = (entityInput.entityTxs?.length ?? 0) > 0;
    const hasProposal = !!entityInput.proposedFrame;
    const hasHashPrecommits = !!entityInput.hashPrecommits && entityInput.hashPrecommits.size > 0;
    return hasEntityTxs || hasProposal || hasHashPrecommits;
  });
  return !hasRuntimeTxs && !hasJInputs && !hasMeaningfulEntityInputs;
};

export const replayFromSnapshotBuffer = async (options: ReplayFromSnapshotOptions): Promise<Env> => {
  const {
    db,
    dbNamespace,
    tempEnv,
    latestHeight,
    checkpointHeight,
    selectedSnapshotHeight,
    selectedSnapshotLabel,
    snapshotBuffer,
    deps,
  } = options;

  console.log(
    `[loadEnvFromDB] snapshot selection checkpoint=${checkpointHeight} selected=${selectedSnapshotHeight} source=${selectedSnapshotLabel}`,
  );

  const data = deserializeTaggedJson<any>(snapshotBuffer.toString());
  deps.normalizeSnapshotInPlace(data);
  const persistedSnapshotStateHash =
    typeof data?.runtimeStateHash === 'string' ? data.runtimeStateHash : undefined;

  const runtimeSeedRaw = Array.isArray(data.runtimeSeed)
    ? new TextDecoder().decode(new Uint8Array(data.runtimeSeed))
    : data.runtimeSeed;
  const env = deps.createEmptyEnv(runtimeSeedRaw ?? null);
  env.height = Number(data.height || 0);
  env.timestamp = Number(data.timestamp || 0);
  env.dbNamespace = data.dbNamespace ?? dbNamespace;
  env.activeJurisdiction = typeof data.activeJurisdiction === 'string' ? data.activeJurisdiction : undefined;
  if (data.browserVMState) {
    env.browserVMState = data.browserVMState;
  }
  if (data.runtimeId) {
    env.runtimeId = data.runtimeId;
  } else if (runtimeSeedRaw !== undefined && runtimeSeedRaw !== null) {
    try {
      env.runtimeId = deps.deriveRuntimeIdFromSeed(runtimeSeedRaw);
    } catch (error) {
      console.warn('⚠️ Failed to derive runtimeId from DB snapshot:', error);
    }
  }
  env.eReplicas = deps.normalizeReplicaMap(data.eReplicas || data.replicas || []) as typeof env.eReplicas;
  env.jReplicas = deps.normalizeJReplicaMap(data.jReplicas || []) as typeof env.jReplicas;
  deps.assertPersistedContractConfigReady(env, `snapshot=${selectedSnapshotHeight} source=${selectedSnapshotLabel}`);
  for (const replica of env.eReplicas.values()) {
    deps.validateEntityState(replica.state, `loadEnvFromDB.eReplicas[${String(replica.entityId)}].state`);
  }
  deps.rebuildEntitySwapBookFromAccounts(env);
  deps.rebuildEntityLockBookFromAccounts(env);
  deps.rebuildEntityOrderbookExtFromAccounts(env);
  env.history = [];
  if (selectedSnapshotHeight > 0) {
    env.history.push(
      deps.buildCanonicalEnvSnapshot(env, {
        runtimeInput: env.runtimeInput ?? { runtimeTxs: [], entityInputs: [] },
        runtimeOutputs: env.pendingOutputs ?? [],
        description: `Frame ${selectedSnapshotHeight}`,
        meta: { title: `Frame ${selectedSnapshotHeight}` },
        logs: env.frameLogs,
        gossipProfiles: env.gossip?.getProfiles ? env.gossip.getProfiles() : [],
      }) as any,
    );
  }
  if (persistedSnapshotStateHash) {
    const actualSnapshotStateHash = computePersistedEnvStateHash(buildRuntimeCheckpointSnapshot(env));
    if (actualSnapshotStateHash !== persistedSnapshotStateHash) {
      throw new Error(
        `SNAPSHOT_STATE_HASH_MISMATCH: snapshot=${selectedSnapshotHeight} expected=${persistedSnapshotStateHash} actual=${actualSnapshotStateHash}`,
      );
    }
  }
  if (env.jReplicas.size > 0) {
    for (const [name, jr] of env.jReplicas.entries()) {
      if ((jr as any).stateRoot) {
        env.jReplicas.set(name, {
          ...jr,
          stateRoot: new Uint8Array((jr as any).stateRoot),
        });
      }
    }
  }
  const envState = deps.ensureRuntimeState(env);
  const tempState = deps.ensureRuntimeState(tempEnv);
  envState.db = tempState.db;
  envState.dbOpenPromise = tempState.dbOpenPromise;

  let lastGoodHeight = selectedSnapshotHeight;
  const runtimeEnv = env as Record<PropertyKey, unknown>;
  const originalLog = env.log;
  const originalInfo = env.info;
  const originalWarn = env.warn;
  const originalError = env.error;
  const originalEmit = env.emit;
  const replayNoop = () => {};
  const assertReplayNoSideEffects = (frame: number): void => {
    const pendingOutputs = env.pendingOutputs?.length ?? 0;
    const pendingNetworkOutputs = env.pendingNetworkOutputs?.length ?? 0;
    const networkInbox = env.networkInbox?.length ?? 0;
    if (pendingOutputs > 0 || pendingNetworkOutputs > 0 || networkInbox > 0) {
      throw new Error(
        `REPLAY_SIDE_EFFECT_DETECTED: frame=${frame} pendingOutputs=${pendingOutputs} pendingNetworkOutputs=${pendingNetworkOutputs} networkInbox=${networkInbox}`,
      );
    }
  };

  runtimeEnv[deps.replayModeKey] = true;
  env.log = replayNoop;
  env.info = replayNoop;
  env.warn = replayNoop;
  env.error = replayNoop;
  env.emit = replayNoop;
  try {
    for (let h = selectedSnapshotHeight + 1; h <= latestHeight; h++) {
      try {
        const frameBuffer = await readPersistedFrameJournalBuffer(db, dbNamespace, h);
        const frame = deserializeTaggedJson<{
          height: number;
          timestamp: number;
          runtimeInput: RuntimeInput;
          runtimeStateHash?: string;
          logs?: FrameLogEntry[];
        }>(frameBuffer.toString());
        const replayRuntimeTxs = frame?.runtimeInput?.runtimeTxs?.length ?? 0;
        const replayEntityInputs = frame?.runtimeInput?.entityInputs?.length ?? 0;
        const replayJInputs = frame?.runtimeInput?.jInputs?.length ?? 0;
        console.log(
          `[loadEnvFromDB] replay frame=${h} runtimeTxs=${replayRuntimeTxs} entityInputs=${replayEntityInputs} jInputs=${replayJInputs}`,
        );
        if (Number(frame?.height) !== h) {
          throw new Error(`Frame height mismatch: key=${h} payload=${String(frame?.height)}`);
        }
        if (!frame?.runtimeInput) {
          throw new Error(`Missing runtimeInput at frame ${h}`);
        }
        for (const entityInput of frame.runtimeInput.entityInputs ?? []) {
          for (const tx of entityInput.entityTxs ?? []) {
            if (tx.type !== 'accountInput') continue;
            const data = tx.data as Record<string, unknown> | undefined;
            const inputHeight = Number(data?.height ?? 0);
            const newFrameHeight = Number((data?.newAccountFrame as { height?: number } | undefined)?.height ?? 0);
            const hasPrev = Boolean(data?.prevHanko);
            const fromEntityId = typeof data?.fromEntityId === 'string' ? data.fromEntityId : '';
            console.log(
              `[loadEnvFromDB] frame=${h} accountInput from=${fromEntityId.slice(-8)} ` +
                `height=${inputHeight} hasPrev=${hasPrev} newFrame=${newFrameHeight || 'none'}`,
            );
          }
        }
        env.height = h - 1;
        env.timestamp = Number(frame.timestamp ?? env.timestamp);
        runtimeEnv[deps.applyAllowedKey] = true;
        await deps.applyRuntimeInput(env, frame.runtimeInput);
        runtimeEnv[deps.applyAllowedKey] = false;
        if (typeof frame.runtimeStateHash === 'string' && frame.runtimeStateHash.length > 0) {
          const actualSnapshot = buildRuntimeCheckpointSnapshot(env);
          const actualRuntimeStateHash = computePersistedEnvStateHash(actualSnapshot);
          if (actualRuntimeStateHash !== frame.runtimeStateHash) {
            throw new Error(
              `REPLAY_STATE_HASH_MISMATCH: frame=${h} expected=${frame.runtimeStateHash} actual=${actualRuntimeStateHash}`,
            );
          }
        }
        assertReplayNoSideEffects(h);
        for (const entityInput of frame.runtimeInput.entityInputs ?? []) {
          const entityIdNorm = String(entityInput.entityId || '').toLowerCase();
          for (const tx of entityInput.entityTxs ?? []) {
            if (tx.type !== 'accountInput') continue;
            const data = tx.data as Record<string, unknown> | undefined;
            const fromEntityId = typeof data?.fromEntityId === 'string' ? data.fromEntityId : '';
            if (!fromEntityId) continue;
            for (const replica of env.eReplicas.values()) {
              if (String(replica?.entityId || '').toLowerCase() !== entityIdNorm) continue;
              const accountMachine = replica?.state?.accounts?.get?.(fromEntityId);
              console.log(
                `[loadEnvFromDB] frame=${h} POST-APPLY entity=${String(entityInput.entityId).slice(-8)} ` +
                  `from=${fromEntityId.slice(-8)} current=${Number(accountMachine?.currentHeight ?? 0)} ` +
                  `pending=${Number(accountMachine?.pendingFrame?.height ?? 0)} mempool=${Number(accountMachine?.mempool?.length ?? 0)}`,
              );
            }
          }
        }
        if (env.height !== h) {
          const canAdvanceLegacyNoop = env.height === h - 1 && isLegacyNoopFrame(frame.runtimeInput);
          if (canAdvanceLegacyNoop) {
            console.warn(
              `[loadEnvFromDB] frame=${h} legacy no-op WAL frame detected; advancing replay height without state mutation`,
            );
            env.height = h;
          } else {
            throw new Error(`Replay height mismatch after apply: expected=${h} actual=${env.height}`);
          }
        }
        env.frameLogs = Array.isArray(frame.logs)
          ? frame.logs.map((entry): FrameLogEntry => ({ ...entry }))
          : [];
        env.history.push(
          deps.buildCanonicalEnvSnapshot(env, {
            runtimeInput: env.runtimeInput ?? { runtimeTxs: [], entityInputs: [] },
            runtimeOutputs: env.pendingOutputs ?? [],
            description: `Frame ${h}`,
            meta: { title: `Frame ${h}` },
            logs: env.frameLogs,
            gossipProfiles: env.gossip?.getProfiles ? env.gossip.getProfiles() : [],
          }) as any,
        );
        env.frameLogs = [];
        lastGoodHeight = h;
      } catch (error) {
        runtimeEnv[deps.applyAllowedKey] = false;
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw new Error(
          `REPLAY_INVARIANT_FAILED: frame=${h} checkpoint=${selectedSnapshotHeight} latest=${latestHeight} restored=${lastGoodHeight} reason=${message}`,
        );
      }
    }
  } finally {
    runtimeEnv[deps.applyAllowedKey] = false;
    runtimeEnv[deps.replayModeKey] = false;
    env.log = originalLog;
    env.info = originalInfo;
    env.warn = originalWarn;
    env.error = originalError;
    env.emit = originalEmit;
  }
  env.height = lastGoodHeight;
  if (lastGoodHeight !== latestHeight) {
    throw new Error(
      `REPLAY_INVARIANT_FAILED: replay completed at ${lastGoodHeight}, expected latest ${latestHeight}`,
    );
  }
  console.log(
    `[loadEnvFromDB] replay complete latest=${latestHeight} restored=${lastGoodHeight} history=${env.history?.length ?? 0}`,
  );

  for (const replica of env.eReplicas.values()) {
    deps.normalizeEntitySwapTradingPairs(replica.state);
  }
  deps.rebuildEntitySwapBookFromAccounts(env);
  deps.rebuildEntityLockBookFromAccounts(env);
  deps.rebuildEntityOrderbookExtFromAccounts(env);
  (env as any).__replayMeta = {
    namespace: dbNamespace,
    latestHeight,
    checkpointHeight: selectedSnapshotHeight,
    selectedSnapshotLabel,
    restoredHeight: lastGoodHeight,
    recoveredHistoryFrames: env.history?.length ?? 0,
  };
  (env as any).__replayMeta.recoveredHistoryFrames = env.history?.length ?? 0;
  return env;
};
