import { deserializeTaggedJson } from '../serialization-utils';
import type { Env, FrameLogEntry, RuntimeInput } from '../types';
import { computePersistedEnvStateHash } from './hash';
import { buildRuntimeCheckpointSnapshot } from './snapshot';
import { readPersistedFrameJournalBuffer, type RuntimeWalDb } from './store';

export type ReplayStartMode = 'default' | 'force-genesis';

export type ReplayStartSelection = {
  snapshotHeight: number;
  snapshotLabel: string;
  source: 'checkpoint' | 'forced-genesis' | 'retry-genesis';
};

export const selectReplayStart = (
  mode: ReplayStartMode,
  checkpointHeight: number,
): ReplayStartSelection => {
  if (mode === 'force-genesis') {
    return {
      snapshotHeight: 1,
      snapshotLabel: 'forced-genesis:1',
      source: 'forced-genesis',
    };
  }
  return {
    snapshotHeight: checkpointHeight,
    snapshotLabel: `checkpoint:${checkpointHeight}`,
    source: 'checkpoint',
  };
};

export const selectReplayRetryFromGenesis = (): ReplayStartSelection => {
  return {
    snapshotHeight: 1,
    snapshotLabel: 'genesis:1',
    source: 'retry-genesis',
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
  buildSkippedReplayAckKey: (
    runtimeFrameHeight: number,
    entityId: string,
    counterpartyId: string,
    inputHeight: number,
    prevHanko: unknown,
  ) => string;
  buildSkippedReplayNewFrameKey: (
    runtimeFrameHeight: number,
    entityId: string,
    counterpartyId: string,
    frameHeight: number,
    stateHash: unknown,
    prevFrameHash: unknown,
  ) => string;
  safeStringify: (value: unknown) => string;
  normalizeEntitySwapTradingPairs: (state: unknown) => void;
  isDbNotFound: (error: unknown) => boolean;
  replayModeKey: symbol;
  replaySkippedAccountInputsKey: symbol;
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
  requestedFromGenesis: boolean;
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
    requestedFromGenesis,
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

  if (latestHeight > selectedSnapshotHeight) {
    const missingFrames: number[] = [];
    for (let h = selectedSnapshotHeight + 1; h <= latestHeight; h++) {
      try {
        await readPersistedFrameJournalBuffer(db, dbNamespace, h);
      } catch (error) {
        if (deps.isDbNotFound(error)) {
          missingFrames.push(h);
          continue;
        }
        throw error;
      }
    }
    if (missingFrames.length > 0) {
      const sample = missingFrames.slice(0, 8).join(',');
      throw new Error(
        `REPLAY_INVARIANT_FAILED: frame=${missingFrames[0]} checkpoint=${selectedSnapshotHeight} latest=${latestHeight} restored=${selectedSnapshotHeight} reason=Missing WAL frames (${sample}${missingFrames.length > 8 ? ',…' : ''})`,
      );
    }
  }

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
        runtimeEnv[deps.replaySkippedAccountInputsKey] = new Set<string>();
        runtimeEnv[deps.applyAllowedKey] = true;
        await deps.applyRuntimeInput(env, frame.runtimeInput);
        runtimeEnv[deps.applyAllowedKey] = false;
        if (typeof frame.runtimeStateHash === 'string' && frame.runtimeStateHash.length > 0) {
          const actualRuntimeStateHash = computePersistedEnvStateHash(buildRuntimeCheckpointSnapshot(env));
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
        for (const entityInput of frame.runtimeInput.entityInputs ?? []) {
          for (const tx of entityInput.entityTxs ?? []) {
            if (tx.type !== 'accountInput') continue;
            const data = tx.data as Record<string, unknown> | undefined;
            const fromEntityId = typeof data?.fromEntityId === 'string' ? data.fromEntityId : '';
            const newAccountFrame = data?.newAccountFrame as Record<string, unknown> | undefined;
            const hasPrevHanko = Boolean(data?.prevHanko);
            const inputHeightRaw = data?.height;
            const inputHeight = Number(inputHeightRaw ?? 0);
            if (hasPrevHanko && !newAccountFrame && fromEntityId && Number.isFinite(inputHeight) && inputHeight > 0) {
              const entityIdNorm = String(entityInput.entityId || '').toLowerCase();
              for (const replica of env.eReplicas.values()) {
                if (String(replica?.entityId || '').toLowerCase() !== entityIdNorm) continue;
                const accountMachine = replica?.state?.accounts?.get?.(fromEntityId);
                const currentHeight = Number(accountMachine?.currentHeight ?? 0);
                const pendingHeight = Number(accountMachine?.pendingFrame?.height ?? 0);
                console.log(
                  `[loadEnvFromDB] frame=${h} ACK-check entity=${String(entityInput.entityId).slice(-8)} ` +
                    `from=${fromEntityId.slice(-8)} current=${currentHeight} pending=${pendingHeight} inputHeight=${inputHeight}`,
                );
                if (currentHeight < inputHeight || pendingHeight === inputHeight) {
                  const skippedReplayAccountInputs =
                    ((runtimeEnv[deps.replaySkippedAccountInputsKey] as Set<string> | undefined) ?? new Set<string>());
                  const skippedReplayAckKey = deps.buildSkippedReplayAckKey(
                    h,
                    entityIdNorm,
                    fromEntityId,
                    inputHeight,
                    data?.prevHanko,
                  );
                  if (skippedReplayAccountInputs.has(skippedReplayAckKey)) {
                    console.warn(
                      `[loadEnvFromDB] frame=${h} ACK-check skipping replay-stale ack entity=${String(entityInput.entityId).slice(-8)} ` +
                        `from=${fromEntityId.slice(-8)} inputHeight=${inputHeight}`,
                    );
                    continue;
                  }
                  throw new Error(
                    `REPLAY_ACK_NOT_APPLIED: frame=${h} ackHeight=${inputHeight} currentHeight=${currentHeight} pendingHeight=${pendingHeight} ` +
                      `entity=${String(entityInput.entityId).slice(0, 12)} from=${fromEntityId.slice(0, 12)}`,
                  );
                }
              }
            }
            const expectedHeight = Number(newAccountFrame?.height ?? 0);
            if (!fromEntityId || !Number.isFinite(expectedHeight) || expectedHeight <= 0) continue;
            const entityIdNorm = String(entityInput.entityId || '').toLowerCase();
            let applied = false;
            for (const replica of env.eReplicas.values()) {
              if (String(replica?.entityId || '').toLowerCase() !== entityIdNorm) continue;
              const accountMachine = replica?.state?.accounts?.get?.(fromEntityId);
              const currentHeight = Number(accountMachine?.currentHeight ?? 0);
              const pendingHeight = Number(accountMachine?.pendingFrame?.height ?? 0);
              console.log(
                `[loadEnvFromDB] frame=${h} NEWFRAME-check entity=${String(entityInput.entityId).slice(-8)} ` +
                  `from=${fromEntityId.slice(-8)} current=${currentHeight} pending=${pendingHeight} expected=${expectedHeight}`,
              );
              if (currentHeight >= expectedHeight || pendingHeight === expectedHeight) {
                applied = true;
                break;
              }
            }
            if (!applied) {
              const skippedReplayAccountInputs =
                ((runtimeEnv[deps.replaySkippedAccountInputsKey] as Set<string> | undefined) ?? new Set<string>());
              const skippedReplayNewFrameKey = deps.buildSkippedReplayNewFrameKey(
                h,
                entityIdNorm,
                fromEntityId,
                expectedHeight,
                newAccountFrame?.stateHash,
                newAccountFrame?.prevFrameHash,
              );
              if (skippedReplayAccountInputs.has(skippedReplayNewFrameKey)) {
                console.warn(
                  `[loadEnvFromDB] frame=${h} NEWFRAME-check skipping replay-stale frame entity=${String(entityInput.entityId).slice(-8)} ` +
                    `from=${fromEntityId.slice(-8)} expected=${expectedHeight}`,
                );
                continue;
              }
              const replayDebug = Array.from(env.eReplicas.values())
                .filter(replica => String(replica?.entityId || '').toLowerCase() === entityIdNorm)
                .map(replica => {
                  const am = replica?.state?.accounts?.get?.(fromEntityId);
                  return {
                    replicaKey: `${String(replica.entityId).slice(0, 10)}...:${String(replica.signerId).slice(0, 10)}...`,
                    currentHeight: Number(am?.currentHeight ?? 0),
                    currentHash: am?.currentFrame?.stateHash ?? null,
                    currentPrev: am?.currentFrame?.prevFrameHash ?? null,
                    pendingFrame: Number(am?.pendingFrame?.height ?? 0),
                    pendingHash: am?.pendingFrame?.stateHash ?? null,
                    pendingPrev: am?.pendingFrame?.prevFrameHash ?? null,
                    mempoolSize: Number(am?.mempool?.length ?? 0),
                    frameHistorySize: Number(am?.frameHistory?.length ?? 0),
                    frameHistoryTail: (am?.frameHistory ?? []).slice(-3).map((frame) => ({
                      height: Number(frame?.height ?? 0),
                      stateHash: frame?.stateHash ?? null,
                      prevFrameHash: frame?.prevFrameHash ?? null,
                    })),
                  };
                });
              console.warn(
                `[loadEnvFromDB] frame=${h} REPLAY_ACCOUNT_FRAME_NOT_APPLIED entity=${String(entityInput.entityId).slice(-8)} ` +
                  `from=${fromEntityId.slice(-8)} expected=${expectedHeight} debug=${deps.safeStringify(replayDebug)}`,
              );
              throw new Error(
                `REPLAY_ACCOUNT_FRAME_NOT_APPLIED: frame=${h} expected=${expectedHeight} actual=${JSON.stringify(replayDebug)}`,
              );
            }
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
        delete runtimeEnv[deps.replaySkippedAccountInputsKey];
        lastGoodHeight = h;
      } catch (error) {
        runtimeEnv[deps.applyAllowedKey] = false;
        delete runtimeEnv[deps.replaySkippedAccountInputsKey];
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
    requestedFromGenesis,
    selectedSnapshotLabel,
    restoredHeight: lastGoodHeight,
    recoveredHistoryFrames: env.history?.length ?? 0,
  };
  (env as any).__replayMeta.recoveredHistoryFrames = env.history?.length ?? 0;
  return env;
};
