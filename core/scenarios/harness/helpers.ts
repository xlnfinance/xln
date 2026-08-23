/**
 * Shared scenario helpers
 */

import type { RuntimeReplica, RoutedEntityInput, RuntimeInput } from '../../runtime/types';
import type { EntityInput, EntityReplica } from '../../entity/types';
import type { Delta } from '../../types/account';
import { formatRuntime } from '../../qa/runtime-ascii';
import { setFailFastErrors } from '../../support/logger';
import { deriveSignerAddressSync, getSignerPrivateKey } from '../../account/crypto';
import { getTokenInfo } from '../../account/utils';
import { createGossipLayer } from '../../network/p2p/gossip';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import { drainJWatcherBacklog } from '../../jurisdiction/adapter/operations/backlog-drain';
import { accountHasProposableMempool } from '../../entity/consensus/account/mempool-eligibility';
import type { JAdapter } from '../../jurisdiction/adapter/types';

// Lazy-loaded process to avoid circular deps
let _process: ((env: RuntimeReplica, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<RuntimeReplica>) | null = null;

export const getProcess = async () => {
  if (!_process) {
    const runtime = await import('../../runtime');
    _process = runtime.processRuntime;
  }
  return _process;
};

// Preferred scenario ingress for anything that should become a durable
// runtime frame. Direct applyRuntimeInput is only for replay/debug code that is
// intentionally bypassing WAL commit semantics.
export const commitRuntimeInput = async (env: RuntimeReplica, runtimeInput: RuntimeInput): Promise<RuntimeReplica> => {
  const runtime = await import('../../runtime');
  runtime.enqueueRuntimeInput(env, runtimeInput);
  return runtime.processRuntime(env);
};

export { checkSolvency } from './solvency-check';

const normalizeRuntimeSeed = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) return null;
  return String(value).trim().length > 0 ? value : null;
};

export function requireRuntimeSeed(env: RuntimeReplica, label: string): string {
  const envSeed = normalizeRuntimeSeed(env.runtimeSeed ?? null);
  const processSeed = (typeof process !== 'undefined' && process.env)
    ? normalizeRuntimeSeed(process.env['XLN_RUNTIME_SEED'] ?? process.env['RUNTIME_SEED'] ?? null)
    : null;
  const seed = envSeed ?? processSeed;
  if (!seed) {
    throw new Error(`${label}: runtimeSeed missing - unlock vault or set XLN_RUNTIME_SEED`);
  }
  if (!envSeed) {
    env.runtimeSeed = seed;
  }
  return seed;
}

export function ensureSignerKeysFromSeed(env: RuntimeReplica, signerIds: string[], label: string): void {
  const runtimeSeed = requireRuntimeSeed(env, label);
  const derivedRuntimeId = deriveSignerAddressSync(runtimeSeed, '1').toLowerCase();
  if (env.runtimeId && normalizeRuntimeId(env.runtimeId) !== derivedRuntimeId) {
    throw new Error(`${label}: runtimeId does not match runtimeSeed`);
  }
  env.runtimeId = derivedRuntimeId;
  // The runtime identity signs authenticated watcher evidence independently
  // of whichever Entity validator aliases this scenario imports.
  getSignerPrivateKey(env, '1');
  for (const signerId of signerIds) {
    // Force exact RuntimeReplica-scoped derivation now. Never accept a same-named numeric
    // alias left in process-global state by another scenario/runtime.
    getSignerPrivateKey(env, signerId);
  }
}

export function setScenarioStorageEnabled(env: RuntimeReplica, enabled: boolean): void {
  env.runtimeConfig = {
    ...env.runtimeConfig,
    storage: {
      ...env.runtimeConfig?.storage,
      enabled,
    },
  };
  if (env.infrastructure) env.infrastructure.persistencePaused = !enabled;
  if (!enabled) env.gossip = createGossipLayer();
}

type ScenarioLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<ScenarioLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let strictScenarioDepth = 0;
let strictScenarioLogLevel: ScenarioLogLevel = 'info';
let strictScenarioOriginalLog: typeof console.log | null = null;
let strictScenarioOriginalInfo: typeof console.info | null = null;
let strictScenarioOriginalWarn: typeof console.warn | null = null;
let strictScenarioOriginalDebug: typeof console.debug | null = null;
let strictScenarioOriginalError: typeof console.error | null = null;

const getScenarioTickMs = (env: RuntimeReplica): number => {
  if (!env.state.jReplicas || env.state.jReplicas.size === 0) return 1;
  let maxDelay = 0;
  for (const replica of env.state.jReplicas.values()) {
    const delay = typeof replica.blockDelayMs === 'number' ? replica.blockDelayMs : 0;
    if (delay > maxDelay) maxDelay = delay;
  }
  return Math.max(1, maxDelay);
};

export const advanceScenarioTime = (env: RuntimeReplica, stepMs?: number, force: boolean = false): void => {
  if (!force && !env.scenarioMode) return;
  const step = Math.max(1, stepMs ?? getScenarioTickMs(env));
  // env.timestamp is typed as number - add step directly
  env.state.timestamp = (env.state.timestamp || 0) + step;
};

export async function waitScenario(env: RuntimeReplica, ms: number): Promise<void> {
  if (ms <= 0) return;
  // Always simulate time for scenarios; avoid real sleeps.
  advanceScenarioTime(env, ms, true);
}

/** Align runtime wake clock with an absolute L1 unix deadline (seconds → ms). */
const syncRuntimeToUnixSeconds = (env: RuntimeReplica, unixSeconds: number): void => {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) {
    throw new Error(`SCENARIO_UNIX_TARGET_INVALID:${unixSeconds}`);
  }
  env.state.timestamp = Math.max(env.state.timestamp || 0, unixSeconds * 1000);
};

type ScenarioRpcSendProvider = {
  send: (method: string, params: unknown[]) => Promise<unknown>;
};

const requireScenarioRpcSend = (jadapter: JAdapter, operation: string): ScenarioRpcSendProvider => {
  const provider = jadapter.provider as unknown as Partial<ScenarioRpcSendProvider>;
  if (typeof provider.send !== 'function') {
    throw new Error(`${operation}_RPC_SEND_UNAVAILABLE`);
  }
  return { send: provider.send.bind(provider) };
};

const requireScenarioUnixSeconds = (unixSeconds: number): number => {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) {
    throw new Error(`SCENARIO_UNIX_TARGET_INVALID:${unixSeconds}`);
  }
  return unixSeconds;
};

const requireScenarioBlockUnix = (value: unknown): number => {
  const unixSeconds = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(unixSeconds) || Number(unixSeconds) < 0) {
    throw new Error(`SCENARIO_JURISDICTION_UNIX_INVALID:${String(value)}`);
  }
  return Number(unixSeconds);
};

/**
 * Pin the next economically relevant jurisdiction block in both scenario modes.
 *
 * BrowserVM's clock is already deterministic and owned by Runtime frames, so
 * an external absolute pin must not jump every Runtime timer forward with it.
 * Align the adapter to the current Runtime clock and let the next frame keep
 * that authority. External RPC chains need the explicit absolute instruction
 * because their autominer owns wall time. Keeping this split here prevents both
 * raw Anvil calls through BrowserVM and premature HTLC/scheduler wakeups.
 */
export const pinScenarioJurisdictionUnix = async (
  env: RuntimeReplica,
  jadapter: JAdapter,
  unixSeconds: number,
): Promise<void> => {
  const target = requireScenarioUnixSeconds(unixSeconds);
  if (typeof jadapter.setBlockTimestamp === 'function') {
    jadapter.setBlockTimestamp(env.state.timestamp || 0);
    return;
  }
  await requireScenarioRpcSend(jadapter, 'SCENARIO_PIN_JURISDICTION_UNIX')
    .send('evm_setNextBlockTimestamp', [target]);
};

/** Latest jurisdiction clock in absolute unix seconds. */
export const readScenarioJurisdictionUnix = async (
  jadapter: JAdapter,
): Promise<number> => {
  if (typeof jadapter.setBlockTimestamp === 'function') {
    const block = await jadapter.provider.getBlock('latest');
    if (!block) throw new Error('SCENARIO_JURISDICTION_BLOCK_MISSING');
    return requireScenarioBlockUnix(block.timestamp);
  }
  const { readRpcUnixSeconds } = await import('./rpc-block-mining');
  return await readRpcUnixSeconds(requireScenarioRpcSend(jadapter, 'SCENARIO_READ_JURISDICTION_UNIX'));
};

/** Jump chain + runtime clocks past an absolute disputeTimeout (unix seconds). */
export const advanceScenarioPastDisputeTimeout = async (
  env: RuntimeReplica,
  jadapter: JAdapter,
  timeoutUnixSeconds: number,
) => {
  const target = requireScenarioUnixSeconds(timeoutUnixSeconds);
  if (typeof jadapter.setBlockTimestamp === 'function') {
    const startUnix = await readScenarioJurisdictionUnix(jadapter);
    if (startUnix >= target) {
      syncRuntimeToUnixSeconds(env, startUnix);
      return { startUnix, finalUnix: startUnix, advancedSeconds: 0 };
    }
    syncRuntimeToUnixSeconds(env, target);
    jadapter.setBlockTimestamp(target * 1000);
    const finalUnix = await readScenarioJurisdictionUnix(jadapter);
    return {
      startUnix,
      finalUnix,
      advancedSeconds: Math.max(0, finalUnix - startUnix),
    };
  }
  const { advanceRpcToUnixSeconds } = await import('./rpc-block-mining');
  const advanced = await advanceRpcToUnixSeconds(
    requireScenarioRpcSend(jadapter, 'SCENARIO_ADVANCE_JURISDICTION_UNIX'),
    target,
  );
  syncRuntimeToUnixSeconds(env, target);
  return advanced;
};

function shouldEmitScenarioLog(level: ScenarioLogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[strictScenarioLogLevel];
}

export function enableStrictScenario(env: RuntimeReplica, label: string): () => void {
  env.strictScenario = true;
  env.strictScenarioLabel = label;
  if (!env.scenarioLogLevel) {
    env.scenarioLogLevel = env.quietRuntimeLogs ? 'warn' : 'info';
  }
  strictScenarioLogLevel = env.scenarioLogLevel;
  setFailFastErrors(true);

  if (strictScenarioDepth === 0) {
    strictScenarioOriginalLog = console.log;
    strictScenarioOriginalInfo = console.info;
    strictScenarioOriginalWarn = console.warn;
    strictScenarioOriginalDebug = console.debug;
    strictScenarioOriginalError = console.error;
    const formatConsoleArg = (arg: unknown): string => {
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'bigint') return `${arg.toString()}n`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    };
    console.log = (...args: unknown[]) => {
      if (shouldEmitScenarioLog('info')) {
        strictScenarioOriginalLog?.(...args);
      }
    };
    console.info = (...args: unknown[]) => {
      if (shouldEmitScenarioLog('info')) {
        strictScenarioOriginalInfo?.(...args);
      }
    };
    console.warn = (...args: unknown[]) => {
      if (shouldEmitScenarioLog('warn')) {
        strictScenarioOriginalWarn?.(...args);
      }
    };
    console.debug = (...args: unknown[]) => {
      if (shouldEmitScenarioLog('debug')) {
        strictScenarioOriginalDebug?.(...args);
      }
    };
    console.error = (...args: unknown[]) => {
      strictScenarioOriginalError?.(...args);
      throw new Error(`[${label}] console.error: ${args.map(formatConsoleArg).join(' ')}`);
    };
  }

  strictScenarioDepth += 1;

  // A deterministic scenario hosts every simulated peer in this Runtime instead
  // of opening real sockets. Model that observable fact explicitly at the same
  // proposer-local boundary used by P2P; production must still supply its socket observer.
  const infrastructure = env.infrastructure ?? (env.infrastructure = {});
  const previousOnlineObserver = infrastructure.observeOnlineEntityIds;
  if (!previousOnlineObserver) {
    infrastructure.observeOnlineEntityIds = entityIds => {
      const localEntityIds = new Set(
        Array.from(env.state.eReplicas.values(), replica => replica.entityId.toLowerCase()),
      );
      return new Set(entityIds.map(entityId => entityId.toLowerCase()).filter(entityId => localEntityIds.has(entityId)));
    };
  }

  return () => {
    if (!previousOnlineObserver) delete infrastructure.observeOnlineEntityIds;
    strictScenarioDepth = Math.max(0, strictScenarioDepth - 1);
    if (strictScenarioDepth === 0) {
      env.strictScenario = false;
      delete env.strictScenarioLabel;
      if (strictScenarioOriginalLog) {
        console.log = strictScenarioOriginalLog;
        strictScenarioOriginalLog = null;
      }
      if (strictScenarioOriginalInfo) {
        console.info = strictScenarioOriginalInfo;
        strictScenarioOriginalInfo = null;
      }
      if (strictScenarioOriginalWarn) {
        console.warn = strictScenarioOriginalWarn;
        strictScenarioOriginalWarn = null;
      }
      if (strictScenarioOriginalDebug) {
        console.debug = strictScenarioOriginalDebug;
        strictScenarioOriginalDebug = null;
      }
      if (strictScenarioOriginalError) {
        console.error = strictScenarioOriginalError;
        strictScenarioOriginalError = null;
      }
      setFailFastErrors(false);
    }
  };
}

// ============================================================================
// ENTITY LOOKUP HELPERS
// ============================================================================

/**
 * Find entity replica by ID prefix (handles "entityId:signerId" composite keys)
 */
export function findReplica(env: RuntimeReplica, entityId: string): [string, EntityReplica] {
  const entry = Array.from(env.state.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`Replica for entity ${entityId} not found`);
  }
  return entry as [string, EntityReplica];
}

/**
 * Get offdelta from LEFT entity's perspective (canonical bilateral view)
 */
export function getOffdelta(env: RuntimeReplica, leftId: string, rightId: string, tokenId: number): bigint {
  const [, leftRep] = findReplica(env, leftId);
  const account = leftRep.state.accounts.get(rightId);
  return account?.state.deltas.get(tokenId)?.offdelta || 0n;
}

// ============================================================================
// CONVERGENCE HELPERS
// ============================================================================

function filterOfflineInputs<T extends EntityInput>(
  inputs: T[],
  offlineSigners: Set<string>,
): { filtered: T[]; dropped: T[] } {
  if (offlineSigners.size === 0) {
    return { filtered: inputs, dropped: [] };
  }

  const filtered: T[] = [];
  const dropped: T[] = [];

  for (const input of inputs) {
    const signerId = input.signerId;
    if (signerId && offlineSigners.has(signerId)) {
      dropped.push(input);
    } else {
      filtered.push(input);
    }
  }

  return { filtered, dropped };
}

const isExplicitlyOfflineNetworkTarget = (
  output: RoutedEntityInput,
  offlineSigners: Set<string>,
): boolean => {
  if (!normalizeRuntimeId(output.runtimeId)) return false;
  const signerId = output.signerId.trim().toLowerCase();
  return [...offlineSigners].some(candidate => candidate.trim().toLowerCase() === signerId);
};

const countOnlinePendingNetworkOutputs = (env: RuntimeReplica, offlineSigners: Set<string>): number =>
  (env.pendingNetworkOutputs ?? [])
    .filter(output => !isExplicitlyOfflineNetworkTarget(output, offlineSigners))
    .length;

const boundedDiagnosticText = (value: unknown): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return 'missing';
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93)}...`;
};

const pendingNetworkLane = (output: RoutedEntityInput): string => {
  if (output.leaderTimeoutVote) return 'leader-timeout-vote';
  if (output.proposedFrame) return output.proposedFrame.collectedSigs?.size
    ? 'entity-frame-commit'
    : 'entity-frame-proposal';
  if (output.hashPrecommits?.size) return 'hash-precommit';
  if (output.jPrefixAttestations?.size) return 'j-prefix-attestation';
  const txTypes = [...new Set((output.entityTxs ?? []).map(tx => boundedDiagnosticText(tx.type)))].slice(0, 4);
  return txTypes.length > 0 ? `tx:${txTypes.join('+')}` : 'trigger';
};

const pendingNetworkDiagnostics = (env: RuntimeReplica): string => {
  const outputs = env.pendingNetworkOutputs ?? [];
  const localReplicaSigners = new Set<string>();
  for (const replicaKey of env.state.eReplicas.keys()) {
    localReplicaSigners.add(String(replicaKey).toLowerCase());
  }
  const visible = outputs.slice(0, 8).map(output => {
    const replicaKey = `${String(output.entityId || '').toLowerCase()}:${String(output.signerId || '').toLowerCase()}`;
    return `${pendingNetworkLane(output)}@entity=${boundedDiagnosticText(output.entityId)},` +
      `signer=${boundedDiagnosticText(output.signerId)},` +
      `runtime=${boundedDiagnosticText(output.runtimeId)},` +
      `hasReplica=${localReplicaSigners.has(replicaKey) ? 'y' : 'n'}`;
  });
  if (outputs.length > visible.length) visible.push(`+${outputs.length - visible.length} more`);
  return visible.join(';');
};

export async function processWithOffline(
  env: RuntimeReplica,
  inputs: EntityInput[] | undefined,
  offlineSigners: Set<string>,
  reason: string = 'offline',
): Promise<RuntimeReplica> {
  const process = await getProcess();

  if (offlineSigners.size === 0) {
    return process(env, inputs);
  }

  const pending = env.pendingOutputs || [];
  const { filtered: filteredPending, dropped: droppedPending } = filterOfflineInputs(pending, offlineSigners);
  if (droppedPending.length > 0) {
    env.info('network', 'OFFLINE_SIGNER_DROP', {
      reason,
      source: 'pendingOutputs',
      signers: Array.from(new Set(droppedPending.map(i => i.signerId))),
      count: droppedPending.length,
      entities: Array.from(new Set(droppedPending.map(i => i.entityId))),
    });
  }
  env.pendingOutputs = filteredPending;

  const queuedInputs = env.runtimeMempool?.entityInputs || [];
  const { filtered: filteredQueued, dropped: droppedQueued } = filterOfflineInputs(queuedInputs, offlineSigners);
  if (droppedQueued.length > 0) {
    env.info('network', 'OFFLINE_SIGNER_DROP', {
      reason,
      source: 'runtimeInput',
      signers: Array.from(new Set(droppedQueued.map(i => i.signerId))),
      count: droppedQueued.length,
      entities: Array.from(new Set(droppedQueued.map(i => i.entityId))),
    });
    env.runtimeMempool.entityInputs = filteredQueued;
  }

  const { filtered: filteredInputs, dropped: droppedInputs } = filterOfflineInputs(inputs || [], offlineSigners);
  if (droppedInputs.length > 0) {
    env.info('network', 'OFFLINE_SIGNER_DROP', {
      reason,
      source: 'inputs',
      signers: Array.from(new Set(droppedInputs.map(i => i.signerId))),
      count: droppedInputs.length,
      entities: Array.from(new Set(droppedInputs.map(i => i.entityId))),
    });
  }

  const processed = await process(env, filteredInputs);
  const postProcessInputs = processed.runtimeMempool?.entityInputs ?? [];
  const { filtered: retainedPostProcessInputs, dropped: droppedPostProcessInputs } =
    filterOfflineInputs(postProcessInputs, offlineSigners);
  if (droppedPostProcessInputs.length > 0) {
    processed.info('network', 'OFFLINE_SIGNER_DROP', {
      reason,
      source: 'postProcess.runtimeInput',
      signers: Array.from(new Set(droppedPostProcessInputs.map(input => input.signerId))),
      count: droppedPostProcessInputs.length,
      entities: Array.from(new Set(droppedPostProcessInputs.map(input => input.entityId))),
    });
    processed.runtimeMempool.entityInputs = retainedPostProcessInputs;
  }
  return processed;
}

/**
 * Process frames until all mempools empty and no pending frames
 * Standard convergence - used in all scenarios
 */
export async function converge(env: RuntimeReplica, maxCycles = 10): Promise<void> {
  const process = await getProcess();
  for (let i = 0; i < maxCycles; i++) {
    await process(env);
    let hasWork = false;
    const pendingOutputs = env.pendingOutputs?.length || 0;
    const pendingNetwork = env.pendingNetworkOutputs?.length || 0;
    const pendingInbox = env.networkInbox?.length || 0;
    const pendingInputs = env.runtimeMempool?.entityInputs?.length || 0;
    if (pendingOutputs > 0 || pendingNetwork > 0 || pendingInbox > 0 || pendingInputs > 0) {
      hasWork = true;
    }
    for (const [, replica] of env.state.eReplicas) {
      // Check entity-level work (multi-signer consensus)
      if (replica.mempool.length > 0 || replica.proposal || replica.lockedFrame) {
        hasWork = true;
        break;
      }
      // Check account-level work (bilateral consensus)
      for (const [, account] of replica.state.accounts) {
        if (account.pendingFrame || accountHasProposableMempool(account, replica.state)) {
          hasWork = true;
          break;
        }
      }
      if (hasWork) break;
    }
    if (!hasWork) return;
    // Time is an input to the next frame, not a side effect of the frame that
    // just converged. Advancing after the terminal cycle leaves live state
    // ahead of its WAL and makes an immediate restart appear divergent.
    advanceScenarioTime(env);
  }
  throwScenarioConvergenceTimeout(env, 'converge', maxCycles);
}

/**
 * Process until predicate condition met (conditional convergence)
 * Useful for waiting on specific state changes
 */
export async function processUntil(
  env: RuntimeReplica,
  predicate: () => boolean,
  maxRounds: number = 10,
  label: string = 'condition',
  onTick?: (round: number) => void,
  onFail?: () => void
): Promise<void> {
  const process = await getProcess();
  for (let round = 0; round < maxRounds; round++) {
    // Check first
    if (predicate()) return;

    // Time is input to the next frame. Advance only when a previous frame did
    // not satisfy the predicate; advancing after the terminal frame would put
    // live state ahead of the last durable WAL frame.
    if (round > 0) advanceScenarioTime(env);

    // Process local state
    await process(env);
    onTick?.(round + 1);

    // Yield to event loop to allow WS messages to be received
    await new Promise(resolve => setTimeout(resolve, 10));

    // Check again after processing
    if (predicate()) return;
  }
  if (!predicate()) {
    onFail?.();
    throw new Error(`processUntil: ${label} not satisfied after ${maxRounds} rounds`);
  }
}

/**
 * Converge with offline signers (drops inputs to specified signerIds)
 * Checks BOTH entity-level AND account-level work (like regular converge)
 */
export async function convergeWithOffline(
  env: RuntimeReplica,
  offlineSigners: Set<string>,
  maxCycles = 10,
  reason: string = 'offline',
): Promise<void> {
  for (let i = 0; i < maxCycles; i++) {
    await processWithOffline(env, undefined, offlineSigners, reason);
    let hasWork = false;
    const pendingOutputs = env.pendingOutputs?.length || 0;
    const pendingNetwork = countOnlinePendingNetworkOutputs(env, offlineSigners);
    const pendingInbox = env.networkInbox?.length || 0;
    const pendingInputs = env.runtimeMempool?.entityInputs?.length || 0;
    if (pendingOutputs > 0 || pendingNetwork > 0 || pendingInbox > 0 || pendingInputs > 0) {
      hasWork = true;
    }
    for (const [, replica] of env.state.eReplicas) {
      // Check entity-level work (multi-signer consensus) - CRITICAL for multi-sig
      if (replica.mempool.length > 0 || replica.proposal || replica.lockedFrame) {
        hasWork = true;
        break;
      }
      // Check account-level work (bilateral consensus)
      for (const [, account] of replica.state.accounts) {
        if (account.pendingFrame || accountHasProposableMempool(account, replica.state)) {
          hasWork = true;
          break;
        }
      }
      if (hasWork) break;
    }
    if (!hasWork) return;
    advanceScenarioTime(env);
  }
  throwScenarioConvergenceTimeout(env, `convergeWithOffline:${reason}`, maxCycles);
}

const throwScenarioConvergenceTimeout = (
  env: RuntimeReplica,
  label: string,
  maxCycles: number,
): never => {
  const pendingInputJobs = (env.runtimeMempool?.entityInputs ?? []).flatMap(input =>
    (input.entityTxs ?? []).flatMap(tx => tx.type === 'scheduledWake'
      ? tx.data.jobs.map(job => `${input.entityId.slice(-4)}:${job.kind}:${job.id}@${job.dueAt}`)
      : [`${input.entityId.slice(-4)}:${tx.type}`])
  ).sort();
  const boardHankoRefreshMarkers = [...env.state.eReplicas.values()].flatMap(replica =>
    [...replica.state.accounts.entries()].flatMap(([counterpartyId, account]) => {
      const marker = account.boardHankoRefreshMigration;
      return marker
        ? [`${replica.entityId.slice(-4)}@${replica.signerId.slice(-4)}>${counterpartyId.slice(-4)}:${marker.reason}`]
        : [];
    })
  ).sort();
  const entityBacklog = [...env.state.eReplicas.values()]
    .flatMap(replica => {
      const pendingAccounts = [...replica.state.accounts.values()]
        .filter(account => account.pendingFrame || accountHasProposableMempool(account, replica.state))
        .length;
      if (!replica.mempool.length && !replica.proposal && !replica.lockedFrame && pendingAccounts === 0) return [];
      const txTypes = replica.mempool.map(tx => tx.type).join(',');
      return [`${replica.state.entityId.slice(0, 10)}@${replica.signerId}:h=${replica.state.height},` +
        `mempool=${replica.mempool.length}[${txTypes}],proposal=${replica.proposal ? 1 : 0},` +
        `lock=${replica.lockedFrame ? 1 : 0},accounts=${pendingAccounts}`];
    })
    .sort();
  throw new Error(
    `${label}: not converged after ${maxCycles} cycles; ` +
    // Own runtimeId, so a lane addressed to this very Runtime is visible as
    // such: that is delivery to self queued as a network output, which has no
    // transport in a scenario and can never drain.
    `self=${String(env.runtimeId ?? 'none').slice(0, 10)},` +
    `outputs=${env.pendingOutputs?.length ?? 0},network=${env.pendingNetworkOutputs?.length ?? 0},` +
    `inbox=${env.networkInbox?.length ?? 0},inputs=${env.runtimeMempool?.entityInputs?.length ?? 0},` +
    `inputJobs=[${pendingInputJobs.join(',')}],` +
    `boardHankoRefreshes=[${boardHankoRefreshMarkers.join(',')}],` +
    `networkLanes=[${pendingNetworkDiagnostics(env)}],entities=[${entityBacklog.join(';')}]`,
  );
};

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

/**
 * Assert with full runtime state dump on failure (critical debugging tool)
 */
export function assert(condition: unknown, message: string, env?: RuntimeReplica): asserts condition {
  if (!condition) {
    if (env) {
      console.log('\n' + '='.repeat(80));
      console.log('ASSERTION FAILED - FULL RUNTIME STATE:');
      console.log('='.repeat(80));
      console.log(formatRuntime(env, { maxAccounts: 5, maxLocks: 20, maxSwaps: 20 }));
      console.log('='.repeat(80) + '\n');
    }
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`[OK] ${message}`);
}

/**
 * Verify bilateral consensus - both sides have identical delta state
 * CRITICAL for bilateral correctness testing
 */
export function assertBilateralSync(
  env: RuntimeReplica,
  entityA: string,
  entityB: string,
  tokenId: number,
  label: string
): void {
  console.log(`\n[BILATERAL-SYNC ${label}] Checking ${entityA.slice(-4)}←→${entityB.slice(-4)} for token ${tokenId}...`);

  const [, replicaA] = findReplica(env, entityA);
  const [, replicaB] = findReplica(env, entityB);

  const accountFromA = replicaA?.state?.accounts?.get(entityB);
  const accountFromB = replicaB?.state?.accounts?.get(entityA);

  if (!accountFromA || !accountFromB) {
    throw new Error(`BILATERAL-SYNC FAIL: Missing account at ${label}`);
  }

  const deltaFromA = accountFromA.state.deltas?.get(tokenId);
  const deltaFromB = accountFromB.state.deltas?.get(tokenId);

  if (!deltaFromA || !deltaFromB) {
    throw new Error(`BILATERAL-SYNC FAIL: Missing delta at ${label}`);
  }

  // Check all 7 delta fields match exactly
  const fieldsToCheck: Array<keyof Delta> = [
    'collateral',
    'ondelta',
    'offdelta',
    'leftCreditLimit',
    'rightCreditLimit',
    'leftAllowance',
    'rightAllowance',
  ];

  const errors: string[] = [];
  for (const field of fieldsToCheck) {
    const valueAB = deltaFromA[field];
    const valueBA = deltaFromB[field];

    if (valueAB !== valueBA) {
      const msg = `${field}: ${entityA.slice(-4)} has ${valueAB}, ${entityB.slice(-4)} has ${valueBA}`;
      console.error(`❌ ${msg}`);
      errors.push(msg);
    }
  }

  if (errors.length > 0) {
    throw new Error(`BILATERAL-SYNC VIOLATION at "${label}":\n${errors.join('\n')}`);
  }

  console.log(`✅ [${label}] Bilateral sync OK: ${entityA.slice(-4)}←→${entityB.slice(-4)} token ${tokenId} - all 7 fields match\n`);
}

// ============================================================================
// J-EVENT PROCESSING
// ============================================================================

/**
 * Process pending j-events from JAdapter operations (BrowserVM or RPC).
 * Drains env.runtimeMempool.entityInputs queue through process().
 * Call after any JAdapter write operation (debugFundReserves, processBatch, etc.)
 */
export async function processJEvents(env: RuntimeReplica): Promise<void> {
  const process = await getProcess();
  await drainJWatcherBacklog(env, async currentEnv => {
    return process(currentEnv);
  });
}

// ============================================================================
// TOKEN CONVERSION HELPERS
// ============================================================================

const wholeTokenAmount = (amount: number | bigint, tokenId: number): bigint =>
  BigInt(amount) * 10n ** BigInt(getTokenInfo(tokenId).decimals);

export const usd = (amount: number | bigint) => wholeTokenAmount(amount, 1);
export const eth = (amount: number | bigint) => wholeTokenAmount(amount, 2);
export const dai = (amount: number | bigint) => wholeTokenAmount(amount, 3);

// ============================================================================
// CHAIN SYNC (poll JAdapter events + process through runtime)
// ============================================================================

/**
 * Poll on-chain events from all JAdapters and process them through the runtime.
 * Used after any on-chain write (j_broadcast, debugFundReserves, etc.)
 * to ensure the runtime sees the resulting events.
 */
export async function syncChain(env: RuntimeReplica, rounds = 3): Promise<void> {
  const process = await getProcess();

  // `rounds` advances explicit scenario time and may trigger new J submissions.
  // Watcher completion is not coupled to this count: every tick captures the
  // resulting trusted chain target and drains until cursor + Entity finality reach it.
  for (let i = 0; i < rounds; i++) {
    advanceScenarioTime(env, 350);
    await process(env);
    await processJEvents(env);
    await process(env);
  }

  await processJEvents(env);
  await converge(env);
}

/** Format bigint as USD string (e.g. "$1,234.56") */
export const formatUSD = (amount: bigint): string => {
  const oneUsd = usd(1);
  const whole = amount / oneUsd;
  const frac = (amount % oneUsd) * 100n / oneUsd;
  return `$${whole.toLocaleString()}.${frac.toString().padStart(2, '0')}`;
};

const isMeaningfulScenarioEntityInput = (input: EntityInput): boolean => {
  const entityTxCount = input.entityTxs?.length ?? 0;
  const hasProposal = Boolean(input.proposedFrame);
  const hashPrecommits = input.hashPrecommits;
  const hasHashPrecommits = Boolean(hashPrecommits && hashPrecommits.size > 0);
  return entityTxCount > 0 || hasProposal || hasHashPrecommits;
};

const pruneIdleScenarioEntityInputs = (env: RuntimeReplica): void => {
  const currentInputs = env.runtimeMempool?.entityInputs;
  if (!currentInputs || currentInputs.length === 0) return;
  const meaningfulInputs = currentInputs.filter(isMeaningfulScenarioEntityInput);
  if (meaningfulInputs.length === currentInputs.length) return;
  env.runtimeMempool.entityInputs = meaningfulInputs;
};

/**
 * Drain runtime - keep processing until all pending work is done
 * Used before assertRuntimeIdle to ensure everything is flushed
 */
export async function drainRuntime(env: RuntimeReplica, maxIterations: number = 20): Promise<RuntimeReplica> {
  const process = await getProcess();
  let iterations = 0;

  while (iterations < maxIterations) {
    pruneIdleScenarioEntityInputs(env);
    const pendingOutputs = env.pendingOutputs?.length || 0;
    const pendingInputs = env.runtimeMempool?.entityInputs?.length || 0;
    const pendingInbox = env.networkInbox?.length || 0;
    const pendingNetwork = env.pendingNetworkOutputs?.length || 0;

    const totalPending = pendingOutputs + pendingInputs + pendingInbox + pendingNetwork;
    if (totalPending === 0) break;

    env = await process(env);
    iterations++;
  }

  return env;
}

export function assertRuntimeIdle(env: RuntimeReplica, label: string = 'runtime'): void {
  pruneIdleScenarioEntityInputs(env);
  const errors: string[] = [];

  const pendingOutputs = env.pendingOutputs?.length || 0;
  const pendingInputs = env.runtimeMempool?.entityInputs?.length || 0;
  const pendingInbox = env.networkInbox?.length || 0;
  const pendingNetwork = env.pendingNetworkOutputs?.length || 0;

  if (pendingOutputs > 0) errors.push(`pendingOutputs=${pendingOutputs}`);
  if (pendingInputs > 0) errors.push(`runtimeInput.entityInputs=${pendingInputs}`);
  if (pendingInbox > 0) errors.push(`networkInbox=${pendingInbox}`);
  if (pendingNetwork > 0) errors.push(`pendingNetworkOutputs=${pendingNetwork}`);

  for (const jReplica of env.state.jReplicas?.values() || []) {
    if (jReplica.mempool.length > 0) {
      errors.push(`jReplica:${jReplica.name} mempool=${jReplica.mempool.length}`);
    }
  }

  for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
    for (const [counterpartyId, account] of replica.state.accounts.entries()) {
      if (account.pendingFrame) {
        errors.push(`pendingFrame ${replicaKey}↔${counterpartyId.slice(-4)}`);
      }
      if (account.mempool.length > 0) {
        errors.push(
          `accountMempool ${replicaKey}↔${counterpartyId.slice(-4)}=${account.mempool.length}` +
          `[${account.mempool.map(tx => tx.type).join(',')}]`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`RUNTIME NOT IDLE (${label}): ${errors.join('; ')}`);
  }
}

// Set snapshot extras before process() - call this, then call process()
export function snap(
  env: RuntimeReplica,
  title: string,
  opts: {
    what?: string;
    why?: string;
    tradfiParallel?: string;
    keyMetrics?: string[];
    expectedSolvency?: bigint;
    description?: string;
    phase?: string;
  } = {}
) {
  env.extra = {
    subtitle: {
      title,
      ...(opts.phase ? { phase: opts.phase } : {}),
      ...(opts.what ? { what: opts.what } : {}),
      ...(opts.why ? { why: opts.why } : {}),
      ...(opts.tradfiParallel ? { tradfiParallel: opts.tradfiParallel } : {}),
      ...(opts.keyMetrics ? { keyMetrics: opts.keyMetrics } : {}),
    },
    ...(opts.expectedSolvency !== undefined ? { expectedSolvency: opts.expectedSolvency } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  };
}
