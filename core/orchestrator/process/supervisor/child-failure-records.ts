import { randomUUID } from 'node:crypto';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';
import { normalizeRuntimeFailureCode } from '../../../protocol/errors/failure-taxonomy';
import { pushDebugEvent, type RelayStore } from '../../../network/relay/store';
import { createStructuredLogger } from '../../../support/logger';
import type { HubChild, MarketMakerChild, ResetState } from '../../orchestrator-types';
import { persistChildFailureReceipt, type ChildFailureReceipt } from '../child-failure-diagnostics';
import type { ManagedChildFatalReport } from '../managed-child-fatal-ipc';
import {
  decideChildFailure,
  type ChildFailureDecision,
  type ChildFailureObservation,
} from '../child-recovery-policy';

type RecoverableChild = HubChild | MarketMakerChild;

type ChildFailureRecordDeps = Readonly<{
  relayStore: RelayStore;
  resetState: ResetState;
  childDiagnosticsDir: string;
  orchestratorCodeFingerprint: ChildFailureReceipt['codeFingerprint'];
  marketMakerChild: MarketMakerChild;
  managedChildFatalRoot: Map<string, string>;
  persistedRuntimeHaltFingerprints: Set<string>;
}>;

const meshLog = createStructuredLogger('mesh.orchestrator');
const serializeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const persistManagedChildFailure = (
  deps: ChildFailureRecordDeps,
  child: RecoverableChild,
  observation: ChildFailureObservation,
  decision: ChildFailureDecision,
  action: ChildFailureReceipt['action'] = decision.action,
): string => {
  const { resetState, orchestratorCodeFingerprint, childDiagnosticsDir } = deps;
  const receipt: ChildFailureReceipt = {
    schema: 'xln-child-failure-v1',
    recordedAt: new Date().toISOString(),
    role: observation.role,
    name: observation.name,
    pid: child.proc?.pid ?? null,
    code: observation.code,
    signal: observation.signal,
    reason: observation.reason,
    reasonCode: decision.reasonCode,
    fingerprint: decision.fingerprint,
    identicalFailureCount: decision.count,
    action,
    backoffMs: action === 'recover' ? decision.backoffMs : 0,
    startedAt: child.startedAt,
    exitedAt: child.exitedAt ?? Date.now(),
    reset: { ...resetState },
    codeFingerprint: orchestratorCodeFingerprint,
    lastHealth: child.lastHealth,
    lastInfo: child.lastInfo,
    recentStdout: [...child.recentStdout],
    recentStderr: [...child.recentStderr],
  };
  return persistChildFailureReceipt(childDiagnosticsDir, receipt, randomUUID()).receiptPath;
};

const pushManagedChildIncident = (
  deps: ChildFailureRecordDeps,
  child: RecoverableChild,
  code: string,
  message: string,
  details: Record<string, unknown>,
): string => {
  const { relayStore, managedChildFatalRoot } = deps;
  const runtimeId = String(child.lastHealth?.runtimeId || child.lastInfo?.runtimeId || '').trim() || undefined;
  const incident = pushDebugEvent(relayStore, {
    event: 'error',
    ...(managedChildFatalRoot.get(child.name)
      ? { rootFingerprint: managedChildFatalRoot.get(child.name) }
      : {}),
    runtimeId,
    status: 'fatal',
    reason: code,
    details: {
      source: 'orchestrator',
      severity: 'fatal',
      message,
      child: child.name,
      ...details,
    },
  });
  if (!incident) throw new Error(`MANAGED_CHILD_FATAL_INCIDENT_NOT_CLASSIFIED:${child.name}:${code}`);
  return incident.fingerprint;
};

const persistManagedChildFatalReport = (
  deps: ChildFailureRecordDeps,
  child: RecoverableChild,
  report: ManagedChildFatalReport,
): string => {
  const { relayStore, managedChildFatalRoot } = deps;
  const incident = pushDebugEvent(relayStore, {
    event: 'error',
    runtimeId: report.runtimeId || undefined,
    status: 'fatal',
    reason: report.code,
    details: {
      source: 'runtime',
      severity: 'fatal',
      message: report.message,
      child: child.name,
      height: report.height,
      timestamp: report.timestamp,
      transport: 'local-ipc',
    },
  });
  if (!incident) throw new Error(`MANAGED_CHILD_FATAL_INCIDENT_NOT_CLASSIFIED:${child.name}:${report.code}`);
  managedChildFatalRoot.set(child.name, incident.fingerprint);
  return incident.fingerprint;
};

const MANAGED_CHILD_ERROR_LINE_MAX = 8_192;
const MANAGED_CHILD_ERROR_MESSAGE_MAX = 2_000;

const captureManagedChildErrorLine = (deps: ChildFailureRecordDeps, child: RecoverableChild, line: string): void => {
  // One oversized child stderr record must not crash the orchestrator: the
  // previous path threw DEBUG_EVENT_TOO_LARGE out of the stream handler and
  // took down the whole mesh mid-E2E.
  const boundedLine = line.length > MANAGED_CHILD_ERROR_LINE_MAX
    ? line.slice(0, MANAGED_CHILD_ERROR_LINE_MAX)
    : line;
  const match = boundedLine.match(/^\[ERROR\]\[([^\]]+)\]\s+([^\s{]+)/);
  if (!match) return;
  const [, scope = 'runtime', phase = 'MANAGED_CHILD_ERROR'] = match;
  const jsonStart = boundedLine.indexOf('{', match[0].length);
  let structuredError = '';
  if (jsonStart >= 0) {
    try {
      const parsed = requireBoundaryRecord(JSON.parse(boundedLine.slice(jsonStart)), 'MANAGED_CHILD_ERROR_JSON_INVALID');
      const error = parsed['error'];
      const detail = parsed['message'];
      structuredError = String(error || detail || '').trim();
    } catch {
      structuredError = '';
    }
  }
  const message = (structuredError || phase).slice(0, MANAGED_CHILD_ERROR_MESSAGE_MAX);
  try {
    pushManagedChildIncident(deps, child, normalizeRuntimeFailureCode(message), message, {
      scope,
      phase,
      truncated: line.length > MANAGED_CHILD_ERROR_LINE_MAX,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    meshLog.warn('managed_child.error_line_incident_dropped', {
      child: child.name,
      scope,
      phase,
      reason: reason.slice(0, 500),
    });
  }
};

const observeManagedRuntimeHalt = (
  deps: ChildFailureRecordDeps,
  child: RecoverableChild,
  health: { runtime?: { halted?: boolean; fatalDebugPayload?: unknown } },
): void => {
  const { marketMakerChild, persistedRuntimeHaltFingerprints } = deps;
  if (health.runtime?.halted !== true) return;
  const reason = safeStringify(health.runtime.fatalDebugPayload ?? { message: 'RUNTIME_HALTED' });
  const observation: ChildFailureObservation = {
    role: child === marketMakerChild ? 'market-maker' : 'hub',
    name: child.name,
    code: null,
    signal: null,
    reason,
  };
  const decision = decideChildFailure({}, observation);
  if (persistedRuntimeHaltFingerprints.has(decision.fingerprint)) return;
  const receiptPath = persistManagedChildFailure(deps, child, observation, decision, 'fail-stop');
  persistedRuntimeHaltFingerprints.add(decision.fingerprint);
  meshLog.error('runtime.halted', {
    child: child.name,
    receiptPath,
    fatal: health.runtime.fatalDebugPayload ?? null,
  });
  pushManagedChildIncident(deps, child, 'RUNTIME_HALTED', reason, {
    receiptPath,
    fatal: health.runtime.fatalDebugPayload ?? null,
  });
};

const persistOrchestratorFailure = (deps: ChildFailureRecordDeps, error: unknown): string => {
  const { resetState, orchestratorCodeFingerprint, childDiagnosticsDir } = deps;
  const exitedAt = Date.now();
  const reason = serializeError(error);
  const observation: ChildFailureObservation = {
    role: 'orchestrator',
    name: 'mesh-orchestrator',
    code: 1,
    signal: null,
    reason,
  };
  const decision = decideChildFailure({}, observation);
  const receipt: ChildFailureReceipt = {
    schema: 'xln-child-failure-v1',
    recordedAt: new Date(exitedAt).toISOString(),
    ...observation,
    pid: process.pid,
    reasonCode: decision.reasonCode,
    fingerprint: decision.fingerprint,
    identicalFailureCount: decision.count,
    action: 'fail-stop',
    backoffMs: 0,
    startedAt: null,
    exitedAt,
    reset: { ...resetState },
    codeFingerprint: orchestratorCodeFingerprint,
    lastHealth: null,
    lastInfo: null,
    recentStdout: [],
    recentStderr: [error instanceof Error && error.stack ? error.stack : reason],
  };
  return persistChildFailureReceipt(childDiagnosticsDir, receipt, randomUUID()).receiptPath;
};

export const createChildFailureRecords = (deps: ChildFailureRecordDeps) => ({
  persistManagedChildFailure: (
    child: RecoverableChild,
    observation: ChildFailureObservation,
    decision: ChildFailureDecision,
    action?: ChildFailureReceipt['action'],
  ): string => persistManagedChildFailure(deps, child, observation, decision, action),
  pushManagedChildIncident: (
    child: RecoverableChild,
    code: string,
    message: string,
    details: Record<string, unknown>,
  ): string => pushManagedChildIncident(deps, child, code, message, details),
  persistManagedChildFatalReport: (child: RecoverableChild, report: ManagedChildFatalReport): string =>
    persistManagedChildFatalReport(deps, child, report),
  captureManagedChildErrorLine: (child: RecoverableChild, line: string): void =>
    captureManagedChildErrorLine(deps, child, line),
  observeManagedRuntimeHalt: (
    child: RecoverableChild,
    health: { runtime?: { halted?: boolean; fatalDebugPayload?: unknown } },
  ): void => observeManagedRuntimeHalt(deps, child, health),
  persistOrchestratorFailure: (error: unknown): string => persistOrchestratorFailure(deps, error),
});
