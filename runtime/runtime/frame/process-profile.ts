import type { EntityInputCausalTrace } from '../../infra/account-causal-trace';
import { cumulativeMarksToPhases } from '../../infra/perf-profile';
import { isRuntimePerfProfileEnabled, readRuntimePerfSlowMs } from '../../infra/perf-runtime-flags';
import { createStructuredLogger } from '../../infra/logger';
import type { RuntimeState } from '../../types';
import { getPerfMs } from '../../utils';
import { nodeProcess } from '../platform';

const runtimeLog = createStructuredLogger('runtime');
const APPLY_PROFILE = nodeProcess?.env?.['XLN_RUNTIME_APPLY_PROFILE'] === '1';
export const ACCOUNT_CAUSAL_TRACE = nodeProcess?.env?.['XLN_ACCOUNT_CAUSAL_TRACE'] === '1';
const PROCESS_PROFILE =
  APPLY_PROFILE || ACCOUNT_CAUSAL_TRACE || nodeProcess?.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const PROCESS_SLOW_MS = Math.max(0, Number(nodeProcess?.env?.['XLN_RUNTIME_PROCESS_SLOW_MS'] || '1000'));

export type RuntimeProcessProfileMetrics = {
  triggerReason?: string;
  heightBefore: number;
  heightAfter: number;
  timestampBefore: number;
  timestampAfter: number;
  runtimeTxs: number;
  entityInputs: number;
  entityTxs: number;
  jInputs: number;
  reliableReceipts: number;
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
  finish(env: RuntimeState): void;
};

const profileEnabled = (env: RuntimeState): boolean =>
  PROCESS_PROFILE ||
  Object.keys(env.runtimeConfig?.performance ?? {}).length > 0 ||
  isRuntimePerfProfileEnabled('XLN_RUNTIME_APPLY_PROFILE', 'XLN_ACCOUNT_CAUSAL_TRACE');

const slowThresholdMs = (): number =>
  readRuntimePerfSlowMs('XLN_RUNTIME_PROCESS_SLOW_MS', PROCESS_SLOW_MS);

const profileHasWork = (metrics: RuntimeProcessProfileMetrics): boolean =>
  metrics.runtimeTxs > 0 ||
  metrics.entityInputs > 0 ||
  metrics.jInputs > 0 ||
  metrics.reliableReceipts > 0 ||
  metrics.localOutputs > 0 ||
  metrics.remoteOutputs > 0 ||
  metrics.jOutputs > 0 ||
  metrics.frameAdvanced;

export const createRuntimeProcessProfile = (
  liveEnv: RuntimeState,
  triggerReason: string | null | undefined,
): RuntimeProcessProfile => {
  const enabled = profileEnabled(liveEnv);
  const startedAt = getPerfMs();
  const cpuStart = enabled && nodeProcess?.cpuUsage ? nodeProcess.cpuUsage() : undefined;
  const marks: Record<string, number> = {};
  const metrics: RuntimeProcessProfileMetrics = {
    ...(enabled && triggerReason ? { triggerReason } : {}),
    heightBefore: liveEnv.height,
    heightAfter: liveEnv.height,
    timestampBefore: liveEnv.timestamp,
    timestampAfter: liveEnv.timestamp,
    runtimeTxs: 0,
    entityInputs: 0,
    entityTxs: 0,
    jInputs: 0,
    reliableReceipts: 0,
    localOutputs: 0,
    remoteOutputs: 0,
    deferredOutputs: 0,
    pendingNetworkBefore: liveEnv.pendingNetworkOutputs?.length ?? 0,
    readyPendingOutputs: 0,
    waitingPendingOutputs: 0,
    pendingNetworkAfter: liveEnv.pendingNetworkOutputs?.length ?? 0,
    deferredNetworkMeta: liveEnv.runtimeState?.deferredNetworkMeta?.size ?? 0,
    jOutputs: 0,
    frameAdvanced: false,
  };
  const profile: RuntimeProcessProfile = {
    enabled,
    metrics,
    outcome: 'unknown',
    mark(label) {
      marks[label] = Math.round(getPerfMs() - startedAt);
      liveEnv.activeProcessProgressAt = Date.now();
      liveEnv.activeProcessProgressStep = label;
    },
    finish(env) {
      metrics.heightAfter = env.height;
      metrics.timestampAfter = env.timestamp;
      const elapsedMs = Math.round(getPerfMs() - startedAt);
      if (cpuStart && nodeProcess?.cpuUsage) {
        const cpu = nodeProcess.cpuUsage(cpuStart);
        const user = cpu.user / 1_000;
        const system = cpu.system / 1_000;
        metrics.cpuMs = { user, system, total: user + system };
      }
      if ((!enabled || !profileHasWork(metrics)) && elapsedMs < slowThresholdMs()) return;
      const fields = {
        outcome: profile.outcome,
        elapsedMs,
        ...metrics,
        phases: cumulativeMarksToPhases(marks, elapsedMs),
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
