import { join } from 'node:path';

type KnipSymbol = { name: string };
type KnipIssue = {
  file: string;
  cycles?: string[];
  enumMembers?: KnipSymbol[];
  exports?: KnipSymbol[];
  namespaceMembers?: KnipSymbol[];
  nsExports?: KnipSymbol[];
  nsTypes?: KnipSymbol[];
  types?: KnipSymbol[];
};

type KnipReport = { issues?: KnipIssue[] };

export const UNUSED_SURFACE_DEBT = new Set([
  'runtime/api/server/rpc/proxy-safety.ts::export:findForbiddenRpcProxyMethod',
  'runtime/api/server/rpc/proxy-safety.ts::export:isLocalProxyRequest',
  'runtime/config/constants.ts::export:TIME_MACHINE',
  'runtime/entity/consensus/state-root.ts::type:AccountReplicaFieldCoverage',
  'runtime/entity/consensus/state-root.ts::type:AccountStateFieldCoverage',
  'runtime/entity/consensus/state-root.ts::type:EntityConsensusStateFieldCoverage',
  'runtime/network/relay/market/wire.ts::export:decodeMarketWireResponse',
  'runtime/network/relay/market/wire.ts::type:MarketWireResponse',
  'runtime/orchestrator/orchestrator-types.ts::type:BootstrapTimeline',
  'runtime/qa/report-types.ts::type:QaCodeFingerprint',
  'runtime/qa/report-types.ts::type:QaShardView',
  'runtime/qa/report.ts::type:QaSeverity',
  'runtime/qa/report.ts::type:QaSeveritySignal',
  'runtime/qa/severity.ts::type:QaSeverity',
  ...[
    'QaAuthoredScenarioStep', 'QaBenchmarkComparison', 'QaBenchmarkMetricDelta',
    'QaBenchmarkStatus', 'QaBrowserHealthSummary', 'QaCodeFingerprint', 'QaFailureClass',
    'QaFatalMarker', 'QaHistoryBackfillResult', 'QaHistoryEntry', 'QaPerfSummary',
    'QaPerfSummaryView', 'QaPhaseKey', 'QaPhaseTimings', 'QaPhaseWaterfall',
    'QaPhaseWaterfallSegment', 'QaRegressionBaselineComparison', 'QaRegressionBaselineKind',
    'QaRegressionMetricDelta', 'QaRegressionReport', 'QaRegressionStatus',
    'QaRetentionPurgeResult', 'QaRunCategory', 'QaRunLedgerEntry', 'QaRunSummary',
    'QaRunTimingSummary', 'QaRunView', 'QaSeverity', 'QaSeveritySignal', 'QaShardView',
    'QaStoryScreenshot', 'QaSystemVerdict', 'QaSystemVerdictStatus', 'QaTestLedgerEntry',
    'QaUxReleasePackAudit',
  ].map(name => `runtime/qa/types.ts::type:${name}`),
  'runtime/storage/schema/account-field-tags.ts::type:StorageAccountReplicaFieldCoverage',
  'runtime/storage/schema/account-field-tags.ts::type:StorageAccountStateFieldCoverage',
  'runtime/storage/schema/merkle-namespace-tags.ts::export:STORAGE_MERKLE_NAMESPACE_BY_TAG',
  'runtime/storage/types.ts::type:AccountPersistenceCoverage',
  'runtime/storage/types.ts::type:EntityPersistenceCoverage',
  'runtime/storage/types.ts::type:ReplicaPersistenceCoverage',
  'tools/audit/types.ts::type:AgentRunState',
  'tools/audit/types.ts::type:AuditPolicy',
  'tools/audit/types.ts::type:AuditReviewer',
  'tools/audit/types.ts::type:AuditScope',
  'tools/audit/types.ts::type:EvidenceState',
  'tools/audit/types.ts::type:FindingState',
  'tools/audit/types.ts::type:ReviewerState',
  'tools/frozen-core/types.ts::type:FrozenPolicyChange',
  'tools/release-snapshot/types.ts::type:ReleaseManifestEntry',
]);

const symbolKeys = (file: string, kind: string, values: readonly KnipSymbol[] = []): string[] =>
  values.map(value => `${file}::${kind}:${value.name}`);

export const collectUnusedSurface = (report: KnipReport): string[] =>
  (report.issues ?? []).flatMap(issue => [
    ...symbolKeys(issue.file, 'export', issue.exports),
    ...symbolKeys(issue.file, 'nsExport', issue.nsExports),
    ...symbolKeys(issue.file, 'type', issue.types),
    ...symbolKeys(issue.file, 'nsType', issue.nsTypes),
    ...symbolKeys(issue.file, 'enum', issue.enumMembers),
    ...symbolKeys(issue.file, 'namespace', issue.namespaceMembers),
    ...(issue.cycles ?? []).map(cycle => `${issue.file}::cycle:${cycle}`),
  ]).sort();

export const evaluateUnusedSurface = (
  actual: readonly string[],
  debt: ReadonlySet<string> = UNUSED_SURFACE_DEBT,
): string[] => {
  const actualSet = new Set(actual);
  return [
    ...actual.filter(key => !debt.has(key)).map(key => `NEW_UNUSED_SURFACE:${key}`),
    ...[...debt].filter(key => !actualSet.has(key)).map(key => `STALE_UNUSED_SURFACE_DEBT:${key}`),
  ].sort();
};

const run = (): void => {
  const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
  const result = Bun.spawnSync({
    cmd: [
      'bunx', 'knip', '--no-progress', '--no-config-hints', '--reporter', 'json',
      '--include', 'exports,nsExports,types,nsTypes,enumMembers,namespaceMembers,cycles',
    ],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`KNIP_UNUSED_SURFACE_EXEC_FAILED:${result.exitCode}:${result.stderr.toString()}`);
  }
  const report = JSON.parse(result.stdout.toString()) as KnipReport;
  const actual = collectUnusedSurface(report);
  const errors = evaluateUnusedSurface(actual);
  if (errors.length > 0) {
    throw new Error(`UNUSED_SURFACE_RATCHET_FAILED\n${errors.join('\n')}`);
  }
  console.log(`UNUSED_SURFACE_OK debt=${actual.length} new=0 stale=0`);
};

if (import.meta.main) run();
