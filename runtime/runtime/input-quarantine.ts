import { createStructuredLogger } from '../infra/logger';
import { recordRuntimeSecurityIncident } from './security-incidents';
import { RuntimeEntityInputApplyError } from './entity-inputs';
import { ENV_REPLAY_MODE_KEY, envRecord } from './loop-environment';
import { ensureRuntimeState } from './runtime-state';
import type { Env, RuntimeInput } from '../types';

const quarantineLog = createStructuredLogger('runtime.input_quarantine');
const MAX_QUARANTINE_RECORDS = 50;
const QUARANTINABLE_ERROR_MARKERS = [
  'FINANCIAL-SAFETY:',
  'Invalid runtimeTxs:',
  'Invalid entityInputs:',
  'Too many runtime transactions:',
  'Too many entity inputs:',
  'RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET',
  'RUNTIME_REPLICA_NOT_FOUND',
  'RUNTIME_SIGNER_MISSING',
  // Broad CROSS_J_/ORDERBOOK_ matching would also swallow internal invariant
  // failures. Only this exact authenticated-ingress rejection is droppable.
  'RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN',
] as const;

const runtimeInputHasWork = (input: RuntimeInput): boolean =>
  input.runtimeTxs.length > 0 ||
  input.entityInputs.length > 0 ||
  (input.jInputs?.length ?? 0) > 0 ||
  (input.reliableReceipts?.length ?? 0) > 0;

const quarantineReason = (error: unknown, message: string): string | null => {
  if (error instanceof RuntimeEntityInputApplyError) {
    return error.isQuarantinableRemoteIngress ? 'REMOTE_ENTITY_INPUT_APPLY_FAILED' : null;
  }
  return QUARANTINABLE_ERROR_MARKERS.find(marker => message.includes(marker)) ?? null;
};

const summarizeRuntimeInput = (input: RuntimeInput) => ({
  counts: {
    runtimeTxs: input.runtimeTxs.length,
    entityInputs: input.entityInputs.length,
    jInputs: input.jInputs?.length ?? 0,
  },
  entityInputs: input.entityInputs.slice(0, 10).map(entityInput => ({
    entityId: String(entityInput.entityId || ''),
    signerId: String(entityInput.signerId || ''),
    txTypes: (entityInput.entityTxs || []).slice(0, 20).map(tx => String(tx?.type || '')),
  })),
  runtimeTxTypes: input.runtimeTxs.slice(0, 20).map(tx => String(tx?.type || '')),
  jInputs: (input.jInputs || []).slice(0, 10).map(jInput => ({
    jurisdictionName: String(jInput.jurisdictionName || ''),
    jTxCount: jInput.jTxs?.length ?? 0,
  })),
});

export const quarantineLiveRuntimeInput = (
  env: Env,
  input: RuntimeInput,
  error: unknown,
  quietLogs: boolean,
): boolean => {
  if (env.scenarioMode || envRecord(env)[ENV_REPLAY_MODE_KEY] === true) return false;
  if (!runtimeInputHasWork(input)) return false;
  const message = error instanceof Error ? error.message : String(error);
  const reason = quarantineReason(error, message);
  if (!reason) return false;

  const state = ensureRuntimeState(env);
  const summary = summarizeRuntimeInput(input);
  const record = {
    id: `runtime-input-quarantine-${Math.max(0, env.height)}-${Math.max(0, env.timestamp || 0)}-${(state.quarantinedRuntimeInputs?.length ?? 0) + 1}`,
    height: Math.max(0, env.height),
    timestamp: Math.max(0, env.timestamp || 0),
    reason,
    message,
    action: 'dropped' as const,
    ...summary,
  };
  state.quarantinedRuntimeInputs = [...(state.quarantinedRuntimeInputs ?? []), record]
    .slice(-MAX_QUARANTINE_RECORDS);
  if (reason === 'RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN') {
    recordRuntimeSecurityIncident(env, {
      domain: 'cross-j',
      code: 'CROSS_J_REMOTE_INPUT_REJECTED',
      source: 'remote-ingress',
      severity: 'warning',
      summary: 'An untrusted cross-j input was rejected before state application',
      entityId: summary.entityInputs[0]?.entityId ?? '',
    });
  }
  const payload = {
    quarantineId: record.id,
    reason,
    action: record.action,
    message,
    ...summary,
  };
  env.error?.('system', 'RUNTIME_INPUT_QUARANTINED', payload, env.runtimeId);
  if (!quietLogs) quarantineLog.error('input.quarantined', payload);
  return true;
};

export class RuntimeInputQuarantinedError extends Error {
  constructor(cause: Error) {
    super(`RUNTIME_INPUT_DROPPED:${cause.message}`, { cause });
    this.name = 'RuntimeInputQuarantinedError';
  }
}
