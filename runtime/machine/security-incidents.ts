import type { Env, RuntimeSecurityIncident } from '../types';

export const MAX_RUNTIME_SECURITY_INCIDENTS = 256;
const OVERFLOW_INCIDENT_ID = 'cross-j:incident-capacity';

type RuntimeSecurityIncidentIdentity = Pick<
  RuntimeSecurityIncident,
  'domain' | 'code' | 'source' | 'severity' | 'summary' | 'entityId'
> & Pick<RuntimeSecurityIncident, 'accountId' | 'offerId' | 'routeHash'>;

const canonicalPart = (value: string | undefined): string =>
  encodeURIComponent(String(value ?? '').trim().toLowerCase());

export const buildRuntimeSecurityIncidentId = (
  incident: RuntimeSecurityIncidentIdentity,
): string => [
  incident.domain,
  canonicalPart(incident.code),
  canonicalPart(incident.entityId),
  canonicalPart(incident.accountId),
  canonicalPart(incident.offerId),
  canonicalPart(incident.routeHash),
].join(':');

const getIncidentMap = (env: Env): Map<string, RuntimeSecurityIncident> => {
  const runtimeState = env.runtimeState ?? (env.runtimeState = {});
  return runtimeState.securityIncidents ?? (runtimeState.securityIncidents = new Map());
};

const incidentTimestamp = (env: Env): number => {
  const timestamp = Number(env.timestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`RUNTIME_SECURITY_INCIDENT_TIMESTAMP_INVALID:${String(env.timestamp)}`);
  }
  return timestamp;
};

const recordCapacityIncident = (env: Env, incidents: Map<string, RuntimeSecurityIncident>): RuntimeSecurityIncident => {
  const now = incidentTimestamp(env);
  const existing = incidents.get(OVERFLOW_INCIDENT_ID);
  const next: RuntimeSecurityIncident = existing
    ? { ...existing, status: 'active', lastSeenAt: now, occurrences: existing.occurrences + 1 }
    : {
        id: OVERFLOW_INCIDENT_ID,
        domain: 'cross-j',
        code: 'SECURITY_INCIDENT_CAPACITY_REACHED',
        source: 'local-consensus',
        severity: 'critical',
        status: 'active',
        summary: `Security incident history reached its ${MAX_RUNTIME_SECURITY_INCIDENTS}-entry bound`,
        entityId: '',
        firstSeenAt: now,
        lastSeenAt: now,
        occurrences: 1,
      };
  incidents.set(OVERFLOW_INCIDENT_ID, next);
  return next;
};

export const recordRuntimeSecurityIncident = (
  env: Env,
  identity: RuntimeSecurityIncidentIdentity,
): RuntimeSecurityIncident => {
  const incidents = getIncidentMap(env);
  const id = buildRuntimeSecurityIncidentId(identity);
  const now = incidentTimestamp(env);
  const existing = incidents.get(id);
  let incident: RuntimeSecurityIncident;
  if (existing) {
    incident = {
      ...existing,
      status: 'active',
      lastSeenAt: now,
      occurrences: existing.occurrences + 1,
    };
    delete incident.resolvedAt;
    incidents.set(id, incident);
  } else if (incidents.size >= MAX_RUNTIME_SECURITY_INCIDENTS - 1) {
    incident = recordCapacityIncident(env, incidents);
  } else {
    incident = {
      ...identity,
      id,
      status: 'active',
      firstSeenAt: now,
      lastSeenAt: now,
      occurrences: 1,
    };
    incidents.set(id, incident);
  }
  env.error?.('system', 'SECURITY_INCIDENT_ACTIVE', {
    incidentId: incident.id,
    code: incident.code,
    severity: incident.severity,
    summary: incident.summary,
  }, identity.entityId || env.runtimeId);
  return incident;
};

export const resolveRuntimeSecurityIncident = (
  env: Env,
  identity: RuntimeSecurityIncidentIdentity,
): RuntimeSecurityIncident | null => {
  const incidents = getIncidentMap(env);
  const id = buildRuntimeSecurityIncidentId(identity);
  const existing = incidents.get(id);
  if (!existing || existing.status === 'resolved') return existing ?? null;
  const now = incidentTimestamp(env);
  const resolved: RuntimeSecurityIncident = {
    ...existing,
    status: 'resolved',
    lastSeenAt: now,
    resolvedAt: now,
  };
  incidents.set(id, resolved);
  env.info?.('system', 'SECURITY_INCIDENT_RESOLVED', {
    incidentId: resolved.id,
    code: resolved.code,
    summary: resolved.summary,
  }, identity.entityId || env.runtimeId);
  return resolved;
};
