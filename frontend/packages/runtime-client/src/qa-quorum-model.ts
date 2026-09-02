import type {
  QuorumCategoryFilter,
  QuorumInteraction,
  QuorumModelSummary,
  QuorumRange,
  QuorumReviewChain,
  QuorumVerdict,
  QuorumView,
} from './qa-quorum-types';

const COLORS = ['#ffbf3f', '#52d7ff', '#a78bfa', '#4ade80', '#fb7185', '#f97316', '#e879f9', '#94a3b8'];
const FALLBACK_COLOR = '#ffbf3f';
const RANGE_DAYS = { '7d': 7, '30d': 30, all: 0 } as const satisfies Record<QuorumRange, number>;

export const readQuorumRange = (value: string): QuorumRange => {
  if (value === '7d' || value === '30d' || value === 'all') return value;
  throw new Error(`QUORUM_RANGE_INVALID:${value}`);
};

export const readQuorumCategoryFilter = (value: string): QuorumCategoryFilter => {
  if (value === 'all' || value === 'performance' || value === 'security' || value === 'protocol' || value === 'reliability') {
    return value;
  }
  throw new Error(`QUORUM_CATEGORY_INVALID:${value}`);
};

const occurredAt = (entry: QuorumInteraction): number => {
  const timestamp = Date.parse(entry.occurredAt);
  if (!Number.isFinite(timestamp)) throw new Error(`QUORUM_INTERACTION_DATE_INVALID:${entry.id}`);
  return timestamp;
};

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new Error('QUORUM_MEDIAN_UPPER_MISSING');
  if (sorted.length % 2 !== 0) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new Error('QUORUM_MEDIAN_LOWER_MISSING');
  return (lower + upper) / 2;
};

export const summarizeModels = (interactions: readonly QuorumInteraction[]): readonly QuorumModelSummary[] => {
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
  })).toSorted((left, right) => right.averageScore - left.averageScore || right.interactions - left.interactions);
};

const buildReviewChains = (interactions: readonly QuorumInteraction[]): readonly QuorumReviewChain[] => {
  const byId = new Map(interactions.map(entry => [entry.id, entry]));
  return interactions.flatMap((challenger) => {
    if (!challenger.challengedInteractionId) return [];
    const challenged = byId.get(challenger.challengedInteractionId);
    return challenged ? [{ challenger, challenged }] : [];
  });
};

export const buildQuorumView = (
  allInteractions: readonly QuorumInteraction[],
  filters: Readonly<{ range: QuorumRange; category: QuorumCategoryFilter; selectedId: string }>,
): QuorumView => {
  const newestAt = allInteractions.length === 0 ? 0 : Math.max(...allInteractions.map(occurredAt));
  const cutoff = filters.range === 'all' ? 0 : newestAt - RANGE_DAYS[filters.range] * 86_400_000;
  const interactions = allInteractions
    .filter(entry => occurredAt(entry) >= cutoff)
    .filter(entry => filters.category === 'all' || entry.category === filters.category)
    .toSorted((left, right) => occurredAt(left) - occurredAt(right));
  const summaries = summarizeModels(interactions);
  const selected = interactions.find(entry => entry.id === filters.selectedId) ?? interactions.at(-1) ?? null;
  const timestamps = interactions.map(occurredAt);
  const minTime = timestamps.length === 0 ? 0 : Math.min(...timestamps);
  const maxTime = timestamps.length === 0 ? 0 : Math.max(...timestamps);
  return {
    interactions,
    summaries,
    modelGroups: summaries.map(summary => ({
      ...summary,
      entries: interactions.filter(entry => entry.model === summary.model),
    })),
    reviewChains: buildReviewChains(interactions),
    recentInteractions: interactions.toReversed().slice(0, 8),
    selected,
    verified: interactions.filter(entry => entry.verdict === 'verified').length,
    averageScore: interactions.length === 0
      ? 0
      : Math.round(interactions.reduce((sum, entry) => sum + entry.score, 0) / interactions.length),
    verifiedImpact: interactions.reduce((sum, entry) => sum + (entry.verifiedImpact ?? 0), 0),
    minTime,
    maxTime,
    timeSpan: Math.max(1, maxTime - minTime),
  };
};

export const quorumColorFor = (model: string): string => {
  let hash = 0;
  for (const character of model) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length] ?? FALLBACK_COLOR;
};

export const quorumChartX = (entry: QuorumInteraction, view: QuorumView): number =>
  72 + 886 * (occurredAt(entry) - view.minTime) / view.timeSpan;

export const quorumChartY = (entry: QuorumInteraction): number => 370 - entry.score * 0.32;

export const formatQuorumDate = (value: string | number): string => new Intl.DateTimeFormat('en', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
}).format(new Date(value));

export const quorumVerdictLabel = (value: QuorumVerdict): string => ({
  verified: 'Verified', partial: 'Partial', noise: 'Noise', blocked: 'Blocked',
})[value];

export const shortQuorumSha = (sha: string): string => sha.slice(0, 10);
