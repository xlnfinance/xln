import type { AggregatedHealth } from './orchestrator-types';
import {
  classifyRuntimeImportReadinessReason,
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
    'reset' |
    'hubMesh' |
    'marketMaker' |
    'custody' |
    'bootstrapReserves'
  >,
): RuntimeImportReadinessDecision => {
  const degraded = Array.isArray(health.degraded) ? health.degraded : [];
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
  if (health.systemOk !== true) return fail('system-not-ok');
  if (health.coreOk !== true) return fail('core-not-ok');
  if (degraded.length > 0) {
    const componentFailure = degraded.includes('marketMaker') ? health.marketMaker?.failure : null;
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
