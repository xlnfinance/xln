export type RuntimeSecurityIncident = {
  id: string;
  domain: 'cross-j';
  code: string;
  source: 'local-consensus' | 'remote-ingress';
  severity: 'warning' | 'critical';
  status: 'active' | 'resolved';
  summary: string;
  entityId: string;
  accountId?: string;
  offerId?: string;
  routeHash?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt?: number;
  occurrences: number;
};

export type RuntimeSecurityIncidentIdentity = Pick<
  RuntimeSecurityIncident,
  'domain' | 'code' | 'source' | 'severity' | 'summary' | 'entityId'
> & Pick<RuntimeSecurityIncident, 'accountId' | 'offerId' | 'routeHash'>;

/** Strict child-health projection. Routing identities and raw evidence stay local. */
export type RuntimeSecurityIncidentTelemetry = Pick<
  RuntimeSecurityIncident,
  | 'id'
  | 'code'
  | 'source'
  | 'severity'
  | 'status'
  | 'firstSeenAt'
  | 'lastSeenAt'
  | 'resolvedAt'
  | 'occurrences'
>;
