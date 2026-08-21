import type { EntityInputCausalTrace } from '../../qa/account-causal-trace';
import { cumulativeMarksToPhases, snapshotPerfPhases } from '../../support/performance/profile';
import { isRuntimePerfProfileEnabled, readRuntimePerfSlowMs } from '../../support/performance/runtime-flags';
import { createStructuredLogger } from '../../support/logger';
import type { EntityInput } from '../../entity/types';
import type { EntityTx } from '../../types/entity-tx';
import type { RuntimeReplica } from '../types';
import { getPerfMs } from '../../support/time';
import { nodeProcess } from '../../support/process/runtime-process';
import { OP_COUNTERS_ENABLED, diffOpCounters, snapshotOpCounters, type OpCounterSnapshot } from '../../support/performance/op-counters';

const runtimeLog = createStructuredLogger('runtime');
const APPLY_PROFILE = nodeProcess?.env?.['XLN_RUNTIME_APPLY_PROFILE'] === '1';
export const ACCOUNT_CAUSAL_TRACE = nodeProcess?.env?.['XLN_ACCOUNT_CAUSAL_TRACE'] === '1';
const PROCESS_PROFILE =
  APPLY_PROFILE || ACCOUNT_CAUSAL_TRACE || nodeProcess?.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const PROCESS_SLOW_MS = Math.max(0, Number(nodeProcess?.env?.['XLN_RUNTIME_PROCESS_SLOW_MS'] || '1000'));

type RuntimeProcessProfileMetrics = {
  triggerReason?: string;
  heightBefore: number;
  heightAfter: number;
  timestampBefore: number;
  timestampAfter: number;
  runtimeTxs: number;
  entityInputs: number;
  entityTxs: number;
  /** Top-level EntityTx kinds in this Runtime frame (accountInput:ack, consensusOutput:…). */
  txKinds?: Record<string, number>;
  /** Distinct `from` Runtime ids on the EntityInputs applied this frame. */
  senders?: number;
  jInputs: number;
  localOutputs: number;
  remoteOutputs: number;
  deferredOutputs: number;
  pendingNetworkBefore: number;
  readyPendingOutputs: number;
  waitingPendingOutputs: number;
  pendingNetworkAfter: number;
  deferredNetworkMeta: number;
  jOutputs: number;
  frameAdvanced: boolean;
  cloneBytes?: number;
  cloneMs?: number;
  reducerMs?: number;
  walMs?: number;
  storageMs?: unknown;
  cpuMs?: { user: number; system: number; total: number };
  /** Exact per-frame operation counters (XLN_RUNTIME_OP_COUNTERS=1). */
  ops?: OpCounterSnapshot;
  /** CPU ms attributed to each phase (cpuUsage delta between marks). */
  phasesCpu?: Array<{ name: string; cpuMs: number }>;
  /** Op counter deltas attributed to each phase. */
  phasesOps?: Record<string, OpCounterSnapshot>;
  accountCausality?: {
    ingress: EntityInputCausalTrace[];
    egress: EntityInputCausalTrace[];
  };
};

export type RuntimeProcessProfile = {
  enabled: boolean;
  metrics: RuntimeProcessProfileMetrics;
  outcome: string;
  mark(label: string): void;
  finish(env: RuntimeReplica): void;
};

const profileEnabled = (env: RuntimeReplica): boolean =>
  PROCESS_PROFILE ||
  Object.keys(env.runtimeConfig?.performance ?? {}).length > 0 ||
  isRuntimePerfProfileEnabled('XLN_RUNTIME_APPLY_PROFILE', 'XLN_ACCOUNT_CAUSAL_TRACE');

const slowThresholdMs = (): number =>
  readRuntimePerfSlowMs('XLN_RUNTIME_PROCESS_SLOW_MS', PROCESS_SLOW_MS);

const profileHasWork = (metrics: RuntimeProcessProfileMetrics): boolean =>
  metrics.runtimeTxs > 0 ||
  metrics.entityInputs > 0 ||
  metrics.jInputs > 0 ||
  metrics.localOutputs > 0 ||
  metrics.remoteOutputs > 0 ||
  metrics.jOutputs > 0 ||
  metrics.frameAdvanced;

const FRAME_LOG = typeof process !== 'undefined' && process.env?.['XLN_RUNTIME_FRAME_LOG'] === '1';

const bumpKind = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const nestedConsensusOutputKind = (tx: Extract<EntityTx, { type: 'consensusOutput' }>): string => {
  const inner = tx.data.entityTxs[0];
  if (!inner) return 'consensusOutput:empty';
  return `consensusOutput:${inner.type}`;
};

/** Cheap ingress histogram. Counts top-level EntityTxs only; nested certified payloads stay in the key. */
export const countEntityInputTxKinds = (
  entityInputs: readonly EntityInput[],
): { txKinds: Record<string, number>; senders: number } => {
  const txKinds: Record<string, number> = {};
  const senders = new Set<string>();
  for (const input of entityInputs) {
    const from = input.from?.trim().toLowerCase();
    if (from) senders.add(from);
    for (const tx of input.entityTxs ?? []) {
      if (tx.type === 'accountInput') {
        bumpKind(txKinds, `accountInput:${tx.data.kind}`);
        continue;
      }
      if (tx.type === 'consensusOutput') {
        bumpKind(txKinds, nestedConsensusOutputKind(tx));
        continue;
      }
      bumpKind(txKinds, tx.type);
    }
  }
  return { txKinds, senders: senders.size };
};

export const createRuntimeProcessProfile = (
  liveEnv: RuntimeReplica,
  triggerReason: string | null | undefined,
): RuntimeProcessProfile => {
  const enabled = profileEnabled(liveEnv);
  const startedAt = getPerfMs();
  const cpuStart = (enabled || FRAME_LOG) && nodeProcess?.cpuUsage ? nodeProcess.cpuUsage() : undefined;
  const opsStart = enabled && OP_COUNTERS_ENABLED ? snapshotOpCounters('frame') : undefined;
  const marks: Record<string, number> = {};
  const cpuMarks: Array<{ name: string; cpuMs: number }> = [];
  let lastCpu = cpuStart;
  const phaseOps: Record<string, OpCounterSnapshot> = {};
  let lastOps = opsStart;
  const metrics: RuntimeProcessProfileMetrics = {
    ...(enabled && triggerReason ? { triggerReason } : {}),
    heightBefore: liveEnv.state.height,
    heightAfter: liveEnv.state.height,
    timestampBefore: liveEnv.state.timestamp,
    timestampAfter: liveEnv.state.timestamp,
    runtimeTxs: 0,
    entityInputs: 0,
    entityTxs: 0,
    jInputs: 0,
    localOutputs: 0,
    remoteOutputs: 0,
    deferredOutputs: 0,
    pendingNetworkBefore: liveEnv.pendingNetworkOutputs?.length ?? 0,
    readyPendingOutputs: 0,
    waitingPendingOutputs: 0,
    pendingNetworkAfter: liveEnv.pendingNetworkOutputs?.length ?? 0,
    deferredNetworkMeta: liveEnv.infrastructure?.deferredNetworkMeta?.size ?? 0,
    jOutputs: 0,
    frameAdvanced: false,
  };
  const profile: RuntimeProcessProfile = {
    enabled,
    metrics,
    outcome: 'unknown',
    mark(label) {
      marks[label] = Math.round(getPerfMs() - startedAt);
      if (lastCpu && nodeProcess?.cpuUsage) {
        const now = nodeProcess.cpuUsage();
        cpuMarks.push({
          name: label,
          cpuMs: Math.round(((now.user - lastCpu.user) + (now.system - lastCpu.system)) / 100) / 10,
        });
        lastCpu = now;
      }
      if (lastOps) {
        const delta = diffOpCounters(lastOps, 'frame');
        if (Object.keys(delta).length > 0) phaseOps[label] = delta;
        lastOps = snapshotOpCounters('frame');
      }
      liveEnv.activeProcessProgressAt = Date.now();
      liveEnv.activeProcessProgressStep = label;
    },
    finish(env) {
      metrics.heightAfter = env.state.height;
      metrics.timestampAfter = env.state.timestamp;
      const elapsedMs = Math.round(getPerfMs() - startedAt);
      if (cpuStart && nodeProcess?.cpuUsage) {
        const cpu = nodeProcess.cpuUsage(cpuStart);
        const user = cpu.user / 1_000;
        const system = cpu.system / 1_000;
        metrics.cpuMs = { user, system, total: user + system };
        if (lastCpu) {
          const now = nodeProcess.cpuUsage();
          cpuMarks.push({
            name: 'remainder',
            cpuMs: Math.round(((now.user - lastCpu.user) + (now.system - lastCpu.system)) / 100) / 10,
          });
          metrics.phasesCpu = cpuMarks;
        }
      }
      if (opsStart) {
        metrics.ops = diffOpCounters(opsStart, 'frame');
        if (lastOps) {
          const delta = diffOpCounters(lastOps, 'frame');
          if (Object.keys(delta).length > 0) phaseOps['remainder'] = delta;
        }
        metrics.phasesOps = phaseOps;
      }
      if (FRAME_LOG && metrics.frameAdvanced) {
        // One line per Runtime frame: what it applied and what still waits.
        runtimeLog.info('frame', {
          h: metrics.heightAfter,
          ms: Math.round(elapsedMs),
          cpu: metrics.cpuMs?.total ?? null,
          inputs: metrics.entityInputs ?? 0,
          txs: metrics.entityTxs,
          txKinds: metrics.txKinds ?? {},
          senders: metrics.senders ?? 0,
          mempool: env.runtimeMempool?.entityInputs.length ?? 0,
          storageMs: (metrics.storageMs as { total?: number } | undefined)?.total ?? null,
        });
      }
      if ((!enabled || !profileHasWork(metrics)) && elapsedMs < slowThresholdMs()) return;
      const fields = {
        outcome: profile.outcome,
        elapsedMs,
        // Wall clock of the frame start lets a log reader correlate frames
        // with ingress events across processes.
        wallStartMs: Date.now() - elapsedMs,
        ...metrics,
        phases: cumulativeMarksToPhases(marks, elapsedMs),
        perf: snapshotPerfPhases(),
      };
      const budget = env.runtimeConfig?.performance;
      const budgetViolations = [
        budget?.maxCloneBytes !== undefined && (metrics.cloneBytes ?? 0) > budget.maxCloneBytes
          ? `cloneBytes:${metrics.cloneBytes}>${budget.maxCloneBytes}`
          : '',
        budget?.maxCloneMs !== undefined && (metrics.cloneMs ?? 0) > budget.maxCloneMs
          ? `cloneMs:${metrics.cloneMs}>${budget.maxCloneMs}`
          : '',
        budget?.maxReducerMs !== undefined && (metrics.reducerMs ?? 0) > budget.maxReducerMs
          ? `reducerMs:${metrics.reducerMs}>${budget.maxReducerMs}`
          : '',
        budget?.maxWalMs !== undefined && (metrics.walMs ?? 0) > budget.maxWalMs
          ? `walMs:${metrics.walMs}>${budget.maxWalMs}`
          : '',
      ].filter(Boolean);
      if (budgetViolations.length > 0) {
        runtimeLog.warn('process.perf_budget_exceeded', {
          height: metrics.heightAfter,
          violations: budgetViolations,
        });
      }
      if (profile.outcome === 'completed') runtimeLog.info('process.profile', fields);
      else runtimeLog.warn('process.profile', fields);
    },
  };
  return profile;
};
