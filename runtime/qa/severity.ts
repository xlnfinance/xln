export type QaSeverity = 'OK' | 'WARN' | 'DEGRADED' | 'FAIL' | 'BLOCKED' | 'UNKNOWN';

export type QaSeverityEvidence = {
  label: string;
  value?: string | number | boolean | null;
  unit?: string | null;
  code?: string | null;
  path?: string | null;
  url?: string | null;
};

export type QaSeveritySignal = {
  severity: QaSeverity;
  reason: string;
  since: number;
  owner: string;
  evidence: QaSeverityEvidence[];
};

const QA_SEVERITIES = new Set<QaSeverity>(['OK', 'WARN', 'DEGRADED', 'FAIL', 'BLOCKED', 'UNKNOWN']);

const QA_SEVERITY_RANK: Record<QaSeverity, number> = {
  OK: 0,
  WARN: 1,
  DEGRADED: 2,
  FAIL: 3,
  BLOCKED: 4,
  UNKNOWN: 5,
};

const asFiniteSince = (value: unknown): number | null => {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
};

const normalizeEvidence = (value: unknown): QaSeverityEvidence[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): QaSeverityEvidence[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const label = String(record['label'] || '').trim();
    if (!label) return [];
    const out: QaSeverityEvidence = { label };
    const valueField = record['value'];
    if (
      typeof valueField === 'string' ||
      typeof valueField === 'number' ||
      typeof valueField === 'boolean' ||
      valueField === null
    ) out.value = valueField;
    for (const key of ['unit', 'code', 'path', 'url'] as const) {
      const field = record[key];
      if (typeof field === 'string' && field.trim()) out[key] = field.trim();
      else if (field === null) out[key] = null;
    }
    return [out];
  });
};

export const isQaSeverity = (value: unknown): value is QaSeverity =>
  QA_SEVERITIES.has(value as QaSeverity);

export const makeQaSeveritySignal = (input: QaSeveritySignal): QaSeveritySignal => ({
  severity: input.severity,
  reason: input.reason.trim() || input.severity,
  since: asFiniteSince(input.since) ?? 0,
  owner: input.owner.trim() || 'unknown',
  evidence: normalizeEvidence(input.evidence),
});

export const normalizeQaSeveritySignal = (
  value: unknown,
  fallback: QaSeveritySignal,
): QaSeveritySignal => {
  if (!value || typeof value !== 'object') return makeQaSeveritySignal(fallback);
  const record = value as Record<string, unknown>;
  const severity = isQaSeverity(record['severity']) ? record['severity'] : fallback.severity;
  const reason = typeof record['reason'] === 'string' && record['reason'].trim()
    ? record['reason'].trim()
    : fallback.reason;
  const since = asFiniteSince(record['since']) ?? fallback.since;
  const owner = typeof record['owner'] === 'string' && record['owner'].trim()
    ? record['owner'].trim()
    : fallback.owner;
  const evidence = Array.isArray(record['evidence']) ? normalizeEvidence(record['evidence']) : fallback.evidence;
  return makeQaSeveritySignal({ severity, reason, since, owner, evidence });
};

export const assertQaSeveritySignal = (value: unknown, label: string): void => {
  if (!value || typeof value !== 'object') throw new Error(`${label}_SEVERITY_SIGNAL_REQUIRED`);
  const record = value as Record<string, unknown>;
  if (!isQaSeverity(record['severity'])) throw new Error(`${label}_SEVERITY_REQUIRED`);
  if (typeof record['reason'] !== 'string' || !record['reason'].trim()) throw new Error(`${label}_REASON_REQUIRED`);
  if (asFiniteSince(record['since']) === null) throw new Error(`${label}_SINCE_REQUIRED`);
  if (typeof record['owner'] !== 'string' || !record['owner'].trim()) throw new Error(`${label}_OWNER_REQUIRED`);
  if (!Array.isArray(record['evidence'])) throw new Error(`${label}_EVIDENCE_REQUIRED`);
};

export const worstQaSeverity = (signals: readonly QaSeveritySignal[]): QaSeverity =>
  signals.reduce<QaSeverity>((worst, signal) => {
    const severity = signal.severity;
    return QA_SEVERITY_RANK[severity] > QA_SEVERITY_RANK[worst] ? severity : worst;
  }, 'OK');

