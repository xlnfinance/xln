import { createHash } from 'node:crypto';
import type { RuntimeSecurityIncidentTelemetry } from '../protocol/security-incident';
import {
  pushDebugEvent,
  setDebugIncidentState,
  type RelayStore,
} from '../network/relay/store';

const MAX_INCIDENTS = 256;

const invalid = (path: string): never => {
  throw new Error(`RUNTIME_SECURITY_TELEMETRY_INVALID:${path}`);
};

const requiredText = (value: unknown, path: string, maxLength: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) invalid(path);
  return value as string;
};

const requiredInteger = (value: unknown, path: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(path);
  return Number(value);
};

export const parseRuntimeSecurityIncidentTelemetry = (
  value: unknown,
): RuntimeSecurityIncidentTelemetry[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid('incidents');
  const entries = value as unknown[];
  if (entries.length > MAX_INCIDENTS) invalid('incidents');
  const incidents = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid(`incidents[${index}]`);
    const record = entry as Record<string, unknown>;
    const source = requiredText(record['source'], `incidents[${index}].source`, 30);
    const severity = requiredText(record['severity'], `incidents[${index}].severity`, 20);
    const status = requiredText(record['status'], `incidents[${index}].status`, 20);
    if (source !== 'local-consensus' && source !== 'remote-ingress') invalid(`incidents[${index}].source`);
    if (severity !== 'warning' && severity !== 'critical') invalid(`incidents[${index}].severity`);
    if (status !== 'active' && status !== 'resolved') invalid(`incidents[${index}].status`);
    const firstSeenAt = requiredInteger(record['firstSeenAt'], `incidents[${index}].firstSeenAt`);
    const lastSeenAt = requiredInteger(record['lastSeenAt'], `incidents[${index}].lastSeenAt`);
    const occurrences = requiredInteger(record['occurrences'], `incidents[${index}].occurrences`, 1);
    if (lastSeenAt < firstSeenAt) invalid(`incidents[${index}].lastSeenAt`);
    const resolvedAt = record['resolvedAt'] === undefined
      ? undefined
      : requiredInteger(record['resolvedAt'], `incidents[${index}].resolvedAt`);
    if ((status === 'resolved') !== (resolvedAt !== undefined) || (resolvedAt !== undefined && resolvedAt < firstSeenAt)) {
      invalid(`incidents[${index}].resolvedAt`);
    }
    return {
      id: requiredText(record['id'], `incidents[${index}].id`, 1_000),
      code: requiredText(record['code'], `incidents[${index}].code`, 200),
      source: source as RuntimeSecurityIncidentTelemetry['source'],
      severity: severity as RuntimeSecurityIncidentTelemetry['severity'],
      status: status as RuntimeSecurityIncidentTelemetry['status'],
      firstSeenAt,
      lastSeenAt,
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
      occurrences,
    };
  });
  if (new Set(incidents.map(incident => incident.id)).size !== incidents.length) invalid('duplicate-id');
  return incidents;
};

const sameIncident = (
  left: RuntimeSecurityIncidentTelemetry | undefined,
  right: RuntimeSecurityIncidentTelemetry,
): boolean => Boolean(left) &&
  left!.code === right.code &&
  left!.source === right.source &&
  left!.severity === right.severity &&
  left!.status === right.status &&
  left!.firstSeenAt === right.firstSeenAt &&
  left!.lastSeenAt === right.lastSeenAt &&
  left!.resolvedAt === right.resolvedAt &&
  left!.occurrences === right.occurrences;

const runtimeSecurityIncidentFingerprint = (runtimeId: string, incidentId: string): string =>
  `runtime-security-${createHash('sha256').update(`${runtimeId}\0${incidentId}`).digest('hex').slice(0, 32)}`;

export const syncRuntimeSecurityTelemetry = (
  store: RelayStore,
  childName: string,
  runtimeIdValue: unknown,
  previousValue: unknown,
  nextValue: unknown,
): number => {
  const previous = new Map(parseRuntimeSecurityIncidentTelemetry(previousValue).map(incident => [incident.id, incident]));
  const next = parseRuntimeSecurityIncidentTelemetry(nextValue);
  if (next.length === 0) return 0;
  const runtimeId = requiredText(runtimeIdValue, 'runtimeId', 200).toLowerCase();
  const child = requiredText(childName, 'childName', 100);
  let changed = 0;
  for (const incident of next) {
    if (sameIncident(previous.get(incident.id), incident)) continue;
    const fingerprint = runtimeSecurityIncidentFingerprint(runtimeId, incident.id);
    const recorded = pushDebugEvent(store, {
      event: 'error',
      rootFingerprint: fingerprint,
      runtimeId,
      status: 'error',
      reason: incident.code,
      details: {
        source: 'runtime-security',
        severity: incident.severity === 'critical' ? 'fatal' : 'error',
        message: incident.code,
        child,
        incidentSource: incident.source,
        incidentStatus: incident.status,
        occurrences: incident.occurrences,
        firstSeenAt: incident.firstSeenAt,
        lastSeenAt: incident.lastSeenAt,
      },
    });
    if (!recorded) throw new Error(`RUNTIME_SECURITY_TELEMETRY_NOT_CLASSIFIED:${incident.code}`);
    if (incident.status === 'resolved') setDebugIncidentState(store, fingerprint, 'resolved');
    changed += 1;
  }
  return changed;
};

export const createManagedRuntimeSecurityTelemetrySync = (store: RelayStore) => {
  const previousByChild = new Map<string, unknown>();
  return (
    childName: string,
    health: { runtimeId?: string | null; runtime?: { securityIncidents?: unknown } },
  ): void => {
    const next = health.runtime?.securityIncidents ?? [];
    syncRuntimeSecurityTelemetry(store, childName, health.runtimeId, previousByChild.get(childName), next);
    previousByChild.set(childName, next);
  };
};
