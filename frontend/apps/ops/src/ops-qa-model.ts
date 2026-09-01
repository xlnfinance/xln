import { buildFailureInbox, buildVerdictSummary } from '../../../packages/runtime-client/src/qa-cockpit-helpers';
import {
  decodeQaAuthInfo,
  decodeQaEnvelope,
  isQaCatalogEntry,
  isQaHistoryEntry,
  isQaRegressionReport,
  isQaRestartAuditEntry,
  isQaRun,
  isQaRunLedgerEntry,
  isQaStoryScreenshot,
  isQaSummary,
  isQaSystemVerdict,
  isQaTestLedgerEntry,
  isQaUxReleasePackAudit,
  isRestartStatus,
} from '../../../packages/runtime-client/src/qa-boundary';
import type {
  QaAuthInfo,
  QaCatalogEntry,
  QaHistoryEntry,
  QaRegressionReport,
  QaRestartAuditEntry,
  QaRun,
  QaRunLedgerEntry,
  QaStoryScreenshot,
  QaSummary,
  QaShard,
  QaSystemVerdict,
  QaTestLedgerEntry,
  QaUxReleasePackAudit,
  QaVerdictSummary,
  RestartStatus,
  RunSortKey,
  ShardSortKey,
} from '../../../packages/runtime-client/src/qa-types';

export type OpsQaAuthLabel = 'locked' | 'read' | 'admin' | 'open';

export type OpsQaRunsPayload = Readonly<{
  auth: QaAuthInfo | undefined;
  runs: readonly QaSummary[];
  ledger: readonly QaRunLedgerEntry[];
  testLedger: readonly QaTestLedgerEntry[];
  regression: QaRegressionReport | null;
  systemVerdict: QaSystemVerdict | null;
}>;

export type OpsQaMetaPayload = Readonly<{
  auth: OpsQaAuthLabel;
  catalog: readonly QaCatalogEntry[];
  history: readonly QaHistoryEntry[];
  audit: readonly QaRestartAuditEntry[];
  stories: readonly QaStoryScreenshot[];
  releasePack: QaUxReleasePackAudit | null;
  restart: RestartStatus;
  restartAllowed: boolean;
}>;

const requireArray = <T>(value: unknown, code: string, guard: (entry: unknown) => entry is T): readonly T[] => {
  if (!Array.isArray(value) || !value.every(guard)) throw new Error(code);
  return value;
};

const optional = <T>(value: unknown, code: string, guard: (entry: unknown) => entry is T): T | null => {
  if (value === undefined || value === null) return null;
  if (!guard(value)) throw new Error(code);
  return value;
};

export const opsQaAuthLabel = (auth: QaAuthInfo | undefined): OpsQaAuthLabel => {
  if (auth?.disabled === true) return 'open';
  if (auth?.scope === 'admin') return 'admin';
  if (auth?.scope === 'read') return 'read';
  return 'locked';
};

export const strongestOpsQaAuth = (labels: readonly OpsQaAuthLabel[]): OpsQaAuthLabel => {
  for (const label of ['open', 'admin', 'read'] as const) if (labels.includes(label)) return label;
  return 'locked';
};

export const decodeOpsQaRuns = (value: unknown): OpsQaRunsPayload => {
  const payload = decodeQaEnvelope(value, ['ok', 'qaAuth', 'runs', 'ledger', 'testLedger', 'regression', 'verdict', 'error']);
  return {
    auth: decodeQaAuthInfo(payload['qaAuth']),
    runs: requireArray(payload['runs'], 'OPS_QA_RUNS_INVALID', isQaSummary),
    ledger: payload['ledger'] === undefined ? [] : requireArray(payload['ledger'], 'OPS_QA_LEDGER_INVALID', isQaRunLedgerEntry),
    testLedger: payload['testLedger'] === undefined ? [] : requireArray(payload['testLedger'], 'OPS_QA_TEST_LEDGER_INVALID', isQaTestLedgerEntry),
    regression: optional(payload['regression'], 'OPS_QA_REGRESSION_INVALID', isQaRegressionReport),
    systemVerdict: optional(payload['verdict'], 'OPS_QA_VERDICT_INVALID', isQaSystemVerdict),
  };
};

export const decodeOpsQaRun = (value: unknown): Readonly<{ auth: OpsQaAuthLabel; run: QaRun }> => {
  const payload = decodeQaEnvelope(value, ['ok', 'qaAuth', 'run', 'error']);
  const run = optional(payload['run'], 'OPS_QA_RUN_INVALID', isQaRun);
  if (!run) throw new Error('OPS_QA_RUN_MISSING');
  return { auth: opsQaAuthLabel(decodeQaAuthInfo(payload['qaAuth'])), run };
};

export const decodeOpsQaMeta = (values: Readonly<{
  catalog: unknown;
  history: unknown;
  audit: unknown;
  stories: unknown;
}>): OpsQaMetaPayload => {
  const catalog = decodeQaEnvelope(values.catalog, ['ok', 'qaAuth', 'catalog', 'restart', 'restartAllowed', 'error']);
  const history = decodeQaEnvelope(values.history, ['ok', 'qaAuth', 'history', 'restart', 'restartAllowed', 'error']);
  const audit = decodeQaEnvelope(values.audit, ['ok', 'qaAuth', 'audit', 'error']);
  const stories = decodeQaEnvelope(values.stories, ['ok', 'qaAuth', 'total', 'stories', 'releasePack', 'error']);
  const historyRestart = optional(history['restart'], 'OPS_QA_HISTORY_RESTART_INVALID', isRestartStatus);
  const catalogRestart = optional(catalog['restart'], 'OPS_QA_CATALOG_RESTART_INVALID', isRestartStatus);
  const auth = strongestOpsQaAuth([
    opsQaAuthLabel(decodeQaAuthInfo(catalog['qaAuth'])),
    opsQaAuthLabel(decodeQaAuthInfo(history['qaAuth'])),
    opsQaAuthLabel(decodeQaAuthInfo(audit['qaAuth'])),
    opsQaAuthLabel(decodeQaAuthInfo(stories['qaAuth'])),
  ]);
  return {
    auth,
    catalog: requireArray(catalog['catalog'], 'OPS_QA_CATALOG_INVALID', isQaCatalogEntry),
    history: requireArray(history['history'], 'OPS_QA_HISTORY_INVALID', isQaHistoryEntry),
    audit: requireArray(audit['audit'], 'OPS_QA_AUDIT_INVALID', isQaRestartAuditEntry),
    stories: requireArray(stories['stories'], 'OPS_QA_STORIES_INVALID', isQaStoryScreenshot),
    releasePack: optional(stories['releasePack'], 'OPS_QA_RELEASE_PACK_INVALID', isQaUxReleasePackAudit),
    restart: historyRestart ?? catalogRestart ?? { active: false },
    restartAllowed: catalog['restartAllowed'] === true || history['restartAllowed'] === true,
  };
};

export const requestedQaSelection = (url: URL): Readonly<{ runId: string; shard: number | null }> => {
  const runId = String(url.searchParams.get('runId') || '').trim();
  const rawShard = String(url.searchParams.get('shard') || '').trim();
  const shard = rawShard === '' ? null : Number(rawShard);
  return { runId, shard: Number.isInteger(shard) && shard !== null && shard >= 0 ? shard : null };
};

export const pickOpsQaShardIndex = (run: QaRun, requestedShard: number | null): number => {
  const requested = requestedShard === null ? -1 : run.shards.findIndex(shard => shard.shard === requestedShard);
  if (requested >= 0) return requested;
  const failed = run.shards.findIndex(shard => shard.status === 'failed');
  return failed >= 0 ? failed : 0;
};

const RUN_SORT_KEYS: readonly RunSortKey[] = [
  'date-desc', 'date-asc', 'stack-fast', 'stack-slow', 'bootstrap-fast',
  'bootstrap-slow', 'playwright-fast', 'playwright-slow', 'test-fast', 'test-slow',
];

export const readOpsQaRunSort = (value: string): RunSortKey => {
  const match = RUN_SORT_KEYS.find(key => key === value);
  if (!match) throw new Error(`OPS_QA_RUN_SORT_INVALID:${value}`);
  return match;
};

const SHARD_SORT_KEYS: readonly ShardSortKey[] = [
  'index', 'duration-fast', 'duration-slow', 'bootstrap-fast',
  'bootstrap-slow', 'playwright-fast', 'playwright-slow',
];

export const readOpsQaShardSort = (value: string): ShardSortKey => {
  const match = SHARD_SORT_KEYS.find(key => key === value);
  if (!match) throw new Error(`OPS_QA_SHARD_SORT_INVALID:${value}`);
  return match;
};

const shardSortValue = (shard: QaShard, key: ShardSortKey): number => {
  if (key.startsWith('duration')) return shard.durationMs ?? Number.POSITIVE_INFINITY;
  if (key.startsWith('playwright')) return shard.phaseMs?.playwright ?? Number.POSITIVE_INFINITY;
  if (key.startsWith('bootstrap')) {
    const phase = shard.phaseMs;
    return phase ? phase.preflight + phase.anvilBoot + phase.apiBoot + phase.apiHealthy + phase.viteBoot : Number.POSITIVE_INFINITY;
  }
  return shard.shard;
};

export const sortOpsQaShards = (
  shards: readonly QaShard[],
  key: ShardSortKey,
): readonly Readonly<{ shard: QaShard; index: number }>[] => shards.map((shard, index) => ({ shard, index })).sort((left, right) => {
  const difference = shardSortValue(left.shard, key) - shardSortValue(right.shard, key);
  return key.endsWith('slow') ? -difference : difference;
});

export const deriveOpsQaVerdict = (
  systemVerdict: QaSystemVerdict | null,
  runs: readonly QaSummary[],
  audit: readonly QaRestartAuditEntry[],
): QaVerdictSummary => buildVerdictSummary(systemVerdict, runs[0] ?? null, buildFailureInbox([...runs], [...audit]));
