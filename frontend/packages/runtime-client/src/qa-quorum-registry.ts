import { requireFiniteNumber, requireString, requireUnknownRecord } from './boundary';
import type { QuorumInteraction, QuorumVerdict } from './qa-quorum-types';

type RegistryReviewer = Readonly<{ id: string; label: string; family: string }>;
type RegistryRun = Readonly<{
  id: string;
  reviewerId: string;
  sourceSha: string;
  scope: string;
  state: string;
  usefulnessScore: number;
  confirmedFindingIds: readonly string[];
  summary: string;
}>;

export type QuorumRegistry = Readonly<{
  schemaVersion: 2;
  reviewers: readonly RegistryReviewer[];
  agentRuns: readonly RegistryRun[];
}>;

const requireArray = (value: unknown, code: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
};

const requireNonEmptyString = (value: unknown, code: string): string => {
  const result = requireString(value, code);
  if (result.trim().length === 0) throw new Error(code);
  return result;
};

const requireStringArray = (value: unknown, code: string): readonly string[] =>
  requireArray(value, code).map(entry => requireNonEmptyString(entry, code));

const decodeReviewer = (value: unknown): RegistryReviewer => {
  const record = requireUnknownRecord(value, 'QUORUM_REVIEWER_INVALID');
  return {
    id: requireNonEmptyString(record['id'], 'QUORUM_REVIEWER_ID_INVALID'),
    label: requireNonEmptyString(record['label'], 'QUORUM_REVIEWER_LABEL_INVALID'),
    family: requireNonEmptyString(record['family'], 'QUORUM_REVIEWER_FAMILY_INVALID'),
  };
};

const decodeRun = (value: unknown): RegistryRun => {
  const record = requireUnknownRecord(value, 'QUORUM_RUN_INVALID');
  const score = requireFiniteNumber(record['usefulnessScore'], 'QUORUM_RUN_SCORE_INVALID');
  if (!Number.isInteger(score) || score < 0 || score > 1_000) throw new Error('QUORUM_RUN_SCORE_INVALID');
  return {
    id: requireNonEmptyString(record['id'], 'QUORUM_RUN_ID_INVALID'),
    reviewerId: requireNonEmptyString(record['reviewerId'], 'QUORUM_RUN_REVIEWER_INVALID'),
    sourceSha: requireNonEmptyString(record['sourceSha'], 'QUORUM_RUN_SHA_INVALID'),
    scope: requireNonEmptyString(record['scope'], 'QUORUM_RUN_SCOPE_INVALID'),
    state: requireNonEmptyString(record['state'], 'QUORUM_RUN_STATE_INVALID'),
    usefulnessScore: score,
    confirmedFindingIds: requireStringArray(record['confirmedFindingIds'], 'QUORUM_RUN_FINDINGS_INVALID'),
    summary: requireNonEmptyString(record['summary'], 'QUORUM_RUN_SUMMARY_INVALID'),
  };
};

const assertUniqueIds = (entries: readonly { id: string }[], code: string): void => {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`${code}:${entry.id}`);
    ids.add(entry.id);
  }
};

export const decodeQuorumRegistry = (value: unknown): QuorumRegistry => {
  const record = requireUnknownRecord(value, 'QUORUM_REGISTRY_INVALID');
  if (record['schemaVersion'] !== 2) throw new Error('QUORUM_REGISTRY_VERSION_INVALID');
  const reviewers = requireArray(record['reviewers'], 'QUORUM_REVIEWERS_INVALID').map(decodeReviewer);
  const agentRuns = requireArray(record['agentRuns'], 'QUORUM_RUNS_INVALID').map(decodeRun);
  assertUniqueIds(reviewers, 'QUORUM_REVIEWER_DUPLICATE');
  assertUniqueIds(agentRuns, 'QUORUM_RUN_DUPLICATE');
  const reviewerIds = new Set(reviewers.map(({ id }) => id));
  for (const run of agentRuns) {
    if (!reviewerIds.has(run.reviewerId)) throw new Error(`QUORUM_RUN_REVIEWER_UNKNOWN:${run.id}`);
  }
  return { schemaVersion: 2, reviewers, agentRuns };
};

const dateFromRunId = (id: string): string => {
  const raw = id.match(/(20\d{6})/)?.[1];
  if (!raw) throw new Error(`QUORUM_RUN_DATE_INVALID:${id}`);
  const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const timestamp = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error(`QUORUM_RUN_DATE_INVALID:${id}`);
  }
  return `${date}T12:00:00Z`;
};

const modelFromLabel = (label: string, family: string): string => {
  const normalized = label.toLowerCase();
  if (normalized.includes('fable')) return 'Claude Fable';
  if (normalized.includes('sonnet')) return 'Claude Sonnet';
  if (normalized.includes('opus')) return 'Claude Opus';
  if (normalized.includes('grok')) return 'Grok';
  if (normalized.includes('glm')) return 'GLM';
  if (normalized.includes('deepseek')) return 'DeepSeek';
  return family === 'codex' ? 'Codex' : label;
};

const verdictFromRun = (state: string, score: number): QuorumVerdict => {
  if (state !== 'COMPLETED') return 'blocked';
  if (score >= 900) return 'verified';
  if (score >= 500) return 'partial';
  return 'noise';
};

export const interactionsFromRegistry = (registry: QuorumRegistry): readonly QuorumInteraction[] => {
  const reviewers = new Map(registry.reviewers.map(reviewer => [reviewer.id, reviewer]));
  return registry.agentRuns.map((run) => {
    const reviewer = reviewers.get(run.reviewerId);
    if (!reviewer) throw new Error(`QUORUM_RUN_REVIEWER_UNKNOWN:${run.id}`);
    return {
      id: run.id,
      occurredAt: dateFromRunId(run.id),
      reviewerId: run.reviewerId,
      reviewer: reviewer.label,
      model: modelFromLabel(reviewer.label, reviewer.family),
      family: reviewer.family,
      score: run.usefulnessScore,
      verdict: verdictFromRun(run.state, run.usefulnessScore),
      category: 'security',
      scope: run.scope,
      summary: run.summary,
      evidence: run.confirmedFindingIds.length > 0
        ? `${run.confirmedFindingIds.length} confirmed finding(s): ${run.confirmedFindingIds.join(', ')}`
        : 'No confirmed finding attached to this historical run.',
      sourceSha: run.sourceSha,
      verifiedImpact: run.confirmedFindingIds.length * 25,
    };
  });
};
