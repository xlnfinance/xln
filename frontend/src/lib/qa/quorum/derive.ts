import type { QuorumInteraction, QuorumModelSummary, QuorumVerdict } from './types';

type RegistryReviewer = Readonly<{ id: string; label: string; family: string }>;
type RegistryRun = Readonly<{
  id: string; reviewerId: string; sourceSha: string; scope: string; state: string;
  usefulnessScore: number; confirmedFindingIds: readonly string[]; summary: string;
}>;
export type QuorumRegistry = Readonly<{
  reviewers: readonly RegistryReviewer[];
  agentRuns: readonly RegistryRun[];
}>;

const dateFromRunId = (id: string): string => {
  const match = id.match(/(20\d{6})/);
  const raw = match?.[1];
  if (!raw) return '2026-01-01T12:00:00Z';
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T12:00:00Z`;
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

export const interactionsFromRegistry = (registry: QuorumRegistry): QuorumInteraction[] => {
  const reviewers = new Map(registry.reviewers.map(reviewer => [reviewer.id, reviewer]));
  return registry.agentRuns.map((run) => {
    const reviewer = reviewers.get(run.reviewerId);
    const label = reviewer?.label ?? run.reviewerId;
    const family = reviewer?.family ?? 'unknown';
    return {
      id: run.id,
      occurredAt: dateFromRunId(run.id),
      reviewerId: run.reviewerId,
      reviewer: label,
      model: modelFromLabel(label, family),
      family,
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

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new Error('QUORUM_MEDIAN_UPPER_MISSING');
  if (sorted.length % 2 !== 0) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new Error('QUORUM_MEDIAN_LOWER_MISSING');
  return (lower + upper) / 2;
};

export const summarizeModels = (interactions: readonly QuorumInteraction[]): QuorumModelSummary[] => {
  const groups = new Map<string, QuorumInteraction[]>();
  for (const interaction of interactions) {
    const group = groups.get(interaction.model) ?? [];
    group.push(interaction);
    groups.set(interaction.model, group);
  }
  return [...groups.entries()].map(([model, entries]) => ({
    model,
    family: entries[0]?.family ?? 'unknown',
    interactions: entries.length,
    averageScore: Math.round(entries.reduce((sum, entry) => sum + entry.score, 0) / entries.length),
    verifiedRate: Math.round(100 * entries.filter(entry => entry.verdict === 'verified').length / entries.length),
    verifiedImpact: entries.reduce((sum, entry) => sum + (entry.verifiedImpact ?? 0), 0),
    medianResponseMinutes: median(entries.flatMap(entry => entry.responseMinutes === undefined ? [] : [entry.responseMinutes])),
  })).sort((left, right) => right.averageScore - left.averageScore || right.interactions - left.interactions);
};
