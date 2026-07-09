import type { AggregatedHealth } from './orchestrator-types';
import {
  classifyRuntimeImportReadinessReason,
  classifyRuntimeHealthDegradedReason,
  isRuntimeFailureSignal,
  type RuntimeFailureCategory,
  type RuntimeFailureSignal,
} from '../failure-taxonomy';

export type RuntimeImportReadinessDecision =
  | { ok: true }
  | {
    ok: false;
    status: 503;
    error: 'RUNTIME_IMPORT_NETWORK_NOT_READY';
    reason: string;
    category: RuntimeFailureCategory;
    code: string;
    retryable: boolean;
    fatal: boolean;
    failure: RuntimeFailureSignal;
    degraded: string[];
  };

export const resolveRuntimeImportReadiness = (
  health: Pick<AggregatedHealth,
    'systemOk' |
    'coreOk' |
    'degraded' |
    'failures' |
    'reset' |
    'hubMesh' |
    'marketMaker' |
    'custody' |
    'bootstrapReserves'
  >,
): RuntimeImportReadinessDecision => {
  const degraded = Array.isArray(health.degraded) ? health.degraded : [];
  const typedFailures = Array.isArray(health.failures)
    ? health.failures.filter(isRuntimeFailureSignal)
    : [];
  const failureForDegradedReason = (reason: string): RuntimeFailureSignal => {
    if (reason === 'marketMaker' && health.marketMaker?.failure) return health.marketMaker.failure;
    const classified = classifyRuntimeHealthDegradedReason(reason);
    return typedFailures.find(failure => failure.code === classified.code) ?? classified;
  };
  const fail = (
    reason: string,
    sourceFailure?: RuntimeFailureSignal | null,
  ): RuntimeImportReadinessDecision => {
    const failure = sourceFailure ?? classifyRuntimeImportReadinessReason(reason);
    return {
      ok: false,
      status: 503,
      error: 'RUNTIME_IMPORT_NETWORK_NOT_READY',
      reason,
      category: failure.category,
      code: failure.code,
      retryable: failure.retryable,
      fatal: failure.fatal,
      failure,
      degraded,
    };
  };

  if (health.reset?.inProgress === true) return fail('reset-in-progress');
  const fatalFailure = typedFailures.find(failure => failure.fatal === true);
  if (fatalFailure) return fail(`fatal:${fatalFailure.code}`, fatalFailure);
  if (health.systemOk !== true) return fail('system-not-ok');
  if (health.coreOk !== true) return fail('core-not-ok');
  if (degraded.length > 0) {
    const componentFailure = degraded
      .map(failureForDegradedReason)
      .find(failure => failure.fatal === true) ?? failureForDegradedReason(degraded[0] ?? 'degraded');
    return fail(`degraded:${degraded.join(',')}`, componentFailure);
  }
  if (health.hubMesh?.ok !== true) return fail('hub-mesh-not-ready');
  if (health.marketMaker?.enabled === true) {
    if (health.marketMaker.ok !== true) return fail('market-maker-not-ready', health.marketMaker.failure);
    if (health.marketMaker.startupPhase !== 'offers-ready') return fail('market-maker-offers-not-ready');
    if (health.marketMaker.cross?.applicable !== false && health.marketMaker.cross?.ok !== true) {
      return fail('market-maker-cross-not-ready');
    }
  }
  if (health.custody?.enabled === true && health.custody.ok !== true) return fail('custody-not-ready');
  if (health.bootstrapReserves?.ok !== true) return fail('bootstrap-reserves-not-ready');
  if (health.bootstrapReserves.targetMet !== true) return fail('bootstrap-reserve-targets-not-ready');
  return { ok: true };
};
