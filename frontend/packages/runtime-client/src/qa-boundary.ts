/** Exact HTTP boundary for the operator-only QA surface. */
import type {
  QaAuthInfo,
  QaCatalogEntry,
  QaHistoryBackfillResult,
  QaHistoryEntry,
  QaRegressionReport,
  QaRetentionPurgeResult,
  QaRestartAuditEntry,
  QaRun,
  QaShard,
  QaRunLedgerEntry,
  QaStoryScreenshot,
  QaSummary,
  QaSystemVerdict,
  QaTestLedgerEntry,
  QaUxReleasePackAudit,
  RestartStatus,
} from './qa-types';
import { isUnknownRecord, optionalBoolean, optionalString, rejectExtraKeys, requireUnknownRecord } from './boundary';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isNullableFiniteNumber = (value: unknown): boolean => value === null || isFiniteNumber(value);
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

export const decodeQaAuthInfo = (value: unknown): QaAuthInfo | undefined => {
  if (value === undefined) return undefined;
  const record = requireUnknownRecord(value, 'QA_AUTH_INVALID');
  rejectExtraKeys(record, ['scope', 'disabled', 'actorKeyId'], 'QA_AUTH_EXTRA_FIELD');
  if (record['actorKeyId'] !== undefined && typeof record['actorKeyId'] !== 'string') throw new Error('QA_AUTH_ACTOR_INVALID');
  if (record['scope'] !== undefined && record['scope'] !== 'read' && record['scope'] !== 'admin') throw new Error('QA_AUTH_SCOPE_INVALID');
  const disabled = optionalBoolean(record['disabled'], 'QA_AUTH_DISABLED_INVALID');
  return {
    ...(record['scope'] === undefined ? {} : { scope: record['scope'] }),
    ...(disabled === undefined ? {} : { disabled }),
  };
};

const isRunStatus = (value: unknown): boolean => value === 'passed' || value === 'failed' || value === 'unknown';

export const isQaSummary = (value: unknown): value is QaSummary =>
  isUnknownRecord(value) && typeof value['runId'] === 'string' && isRunStatus(value['status']) &&
  isFiniteNumber(value['createdAt']) && isNullableFiniteNumber(value['completedAt']) && typeof value['suiteKey'] === 'string' &&
  typeof value['suiteLabel'] === 'string' && typeof value['category'] === 'string' && isStringArray(value['failingTargets']);

const isShardStatus = (value: unknown): boolean =>
  value === 'passed' || value === 'failed' || value === 'cancelled' || value === 'unknown';

const isQaArtifact = (value: unknown): boolean =>
  isUnknownRecord(value) && typeof value['name'] === 'string' && typeof value['relativePath'] === 'string';

export const isQaShard = (value: unknown): value is QaShard =>
  isUnknownRecord(value) && isFiniteNumber(value['shard']) && isShardStatus(value['status']) &&
  isNullableFiniteNumber(value['durationMs']) && isNullableString(value['handle']) && isNullableString(value['target']) &&
  isNullableString(value['title']) && isNullableString(value['error']) && typeof value['hasVideo'] === 'boolean' &&
  typeof value['hasTrace'] === 'boolean' && Array.isArray(value['artifacts']) && value['artifacts'].every(isQaArtifact) &&
  Array.isArray(value['timelineSteps']) && Array.isArray(value['slowSteps']);

export const isQaRun = (value: unknown): value is QaRun => {
  if (!isUnknownRecord(value)) return false;
  const shards = value['shards'];
  // A run view is the manifest shape: suite/category fields belong to the
  // ledger summary and are not part of the per-run manifest.
  return typeof value['runId'] === 'string' && isRunStatus(value['status']) && isFiniteNumber(value['createdAt']) &&
    isNullableFiniteNumber(value['completedAt']) && isFiniteNumber(value['totalShards']) &&
    Array.isArray(shards) && shards.every(isQaShard);
};

export const isQaRunLedgerEntry = (value: unknown): value is QaRunLedgerEntry =>
  isUnknownRecord(value) && typeof value['runId'] === 'string' && isRunStatus(value['status']) &&
  isFiniteNumber(value['createdAt']) && isNullableFiniteNumber(value['completedAt']) && typeof value['suiteKey'] === 'string' &&
  typeof value['suiteLabel'] === 'string' && isStringArray(value['failedTargets']) && isUnknownRecord(value['timing']);

export const isQaTestLedgerEntry = (value: unknown): value is QaTestLedgerEntry =>
  isUnknownRecord(value) && typeof value['testId'] === 'string' && typeof value['target'] === 'string' &&
  typeof value['title'] === 'string' && typeof value['description'] === 'string' && isRunStatus(value['status']) &&
  typeof value['lastRunId'] === 'string' && isFiniteNumber(value['lastRunAt']);

export const isQaCatalogEntry = (value: unknown): value is QaCatalogEntry =>
  isUnknownRecord(value) && ['id', 'group', 'label', 'command', 'description'].every((key) => typeof value[key] === 'string');

export const isQaHistoryEntry = (value: unknown): value is QaHistoryEntry =>
  isUnknownRecord(value) && typeof value['runId'] === 'string' && isRunStatus(value['status']) && isFiniteNumber(value['createdAt']) &&
  isNullableFiniteNumber(value['completedAt']) && typeof value['logsDir'] === 'string';

export const isQaRestartAuditEntry = (value: unknown): value is QaRestartAuditEntry =>
  isUnknownRecord(value) && typeof value['auditId'] === 'string' && typeof value['status'] === 'string' &&
  typeof value['operatorId'] === 'string' && typeof value['target'] === 'string' && isFiniteNumber(value['startedAt']);

export const isRestartStatus = (value: unknown): value is RestartStatus =>
  isUnknownRecord(value) && typeof value['active'] === 'boolean' &&
  (value['command'] === undefined || isStringArray(value['command'])) &&
  (value['pid'] === undefined || isNullableFiniteNumber(value['pid']));

export const isQaRegressionReport = (value: unknown): value is QaRegressionReport =>
  isUnknownRecord(value) && typeof value['status'] === 'string' && Array.isArray(value['comparisons']);

export const isQaSystemVerdict = (value: unknown): value is QaSystemVerdict =>
  isUnknownRecord(value) && value['schemaVersion'] === 1 && typeof value['status'] === 'string' &&
  isFiniteNumber(value['activeCount']) && isFiniteNumber(value['failingSurfaceCount']);

export const isQaStoryScreenshot = (value: unknown): value is QaStoryScreenshot =>
  isUnknownRecord(value) && typeof value['id'] === 'string' && typeof value['source'] === 'string' && typeof value['title'] === 'string' &&
  typeof value['group'] === 'string' && isNullableString(value['description']) && isNullableString(value['platform']) &&
  isStringArray(value['tags']) && typeof value['curated'] === 'boolean' && typeof value['name'] === 'string' &&
  typeof value['relativePath'] === 'string' && isFiniteNumber(value['sizeBytes']) && isFiniteNumber(value['updatedAt']) && typeof value['url'] === 'string';

export const isQaUxReleasePackAudit = (value: unknown): value is QaUxReleasePackAudit =>
  isUnknownRecord(value) && typeof value['status'] === 'string';

export const isQaRetentionPurgeResult = (value: unknown): value is QaRetentionPurgeResult =>
  isUnknownRecord(value) && isFiniteNumber(value['retentionDays']) && isFiniteNumber(value['cutoff']) &&
  isStringArray(value['deletedRunIds']) && isFiniteNumber(value['deletedLogDirs']) && isFiniteNumber(value['deletedHistoryRows']);

export const isQaHistoryBackfillResult = (value: unknown): value is QaHistoryBackfillResult =>
  isUnknownRecord(value) && isFiniteNumber(value['scannedRuns']) && isFiniteNumber(value['recordedRuns']) && Array.isArray(value['failedRuns']) &&
  value['failedRuns'].every((entry) => isUnknownRecord(entry) && typeof entry['runId'] === 'string' && typeof entry['error'] === 'string');

export const decodeQaEnvelope = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  const record = requireUnknownRecord(value, 'QA_RESPONSE_INVALID');
  rejectExtraKeys(record, allowed, 'QA_RESPONSE_EXTRA_FIELD');
  if (record['ok'] !== true) throw new Error(optionalString(record['error'], 'QA_RESPONSE_ERROR_INVALID') ?? 'QA_RESPONSE_NOT_OK');
  return record;
};
